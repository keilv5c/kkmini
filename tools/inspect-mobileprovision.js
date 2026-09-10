#!/usr/bin/env node
/* ============================================================================
 * inspect-mobileprovision.js —— 签名前体检：读出 .mobileprovision 的关键信息
 * ----------------------------------------------------------------------------
 * 为什么需要它：自己签名失败最常见的三个原因就是
 *   1) 证书里的 App ID 与 IPA 的 Bundle ID 不一致   ← 头号原因
 *   2) 描述文件过期了
 *   3) 设备 UDID 不在描述文件的设备列表里（开发/Ad-Hoc 证书才有这个列表）
 * 本脚本不需要 openssl、不需要 Mac —— .mobileprovision 是 CMS(PKCS#7) 容器，
 * 里面的 plist 是**明文 XML**，直接从字节里抠出来即可；IPA 就是 zip，
 * 自己解析中央目录取 Payload/*.app/Info.plist（不依赖任何第三方库）。
 *
 * 用法：
 *   node tools/inspect-mobileprovision.js my.mobileprovision
 *   node tools/inspect-mobileprovision.js my.mobileprovision --ipa Minidayz-unsigned.ipa
 *   node tools/inspect-mobileprovision.js my.mobileprovision --udid 00008030-001A2B3C4D5E006E
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ============================== 纯函数部分（可单测） ============================== */

/** 从 .mobileprovision 的字节里抠出内嵌的 plist XML */
function extractPlistFromProvision(buf) {
  const raw = buf.toString('latin1');
  const start = raw.indexOf('<?xml');
  const end = raw.lastIndexOf('</plist>');
  if (start < 0 || end < 0) return null;
  return raw.slice(start, end + '</plist>'.length);
}

/* plist 的键值结构是 <key>Name</key><string>值</string>（不是 <Name>值</Name>），
   所以必须按 key 找它后面的那个标签。 */
function valueFor(plist, key) {
  const re = new RegExp('<key>' + key + '</key>\\s*<([a-z]+)(?:\\s*/>|>([\\s\\S]*?)</\\1>)');
  const m = re.exec(plist);
  if (!m) return null;
  return { type: m[1], body: m[2] === undefined ? '' : m[2] };
}
function str(plist, key) {
  const v = valueFor(plist, key);
  if (!v) return null;
  if (v.type === 'string') return v.body.trim();
  const inner = /<string>([\s\S]*?)<\/string>/.exec(v.body);
  return inner ? inner[1].trim() : null;
}
function dateVal(plist, key) {
  const v = valueFor(plist, key);
  if (!v) return null;
  const m = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(v.body);
  return m ? m[1] : null;
}
function arrayOf(plist, key) {
  const v = valueFor(plist, key);
  if (!v) return null;
  const inner = v.type === 'array' ? v.body : (/<array>([\s\S]*?)<\/array>/.exec(v.body) || [])[1];
  if (!inner) return null;
  return (inner.match(/<string>([^<]*)<\/string>/g) || []).map(s => s.replace(/<\/?string>/g, ''));
}
function boolVal(plist, key) {
  const v = valueFor(plist, key);
  if (!v) return null;
  if (v.type === 'true') return true;
  if (v.type === 'false') return false;
  return null;
}

/** 把描述文件 plist 解析成结构化信息 */
function parseProfile(plistXml) {
  const appIdFull = (/<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plistXml) || [])[1] || null;
  // App ID 形如 TEAMID.com.foo.bar（通配符是 TEAMID.* 或 TEAMID.com.foo.*），
  // 所以先剥掉 Team 前缀，再看剩下的部分里有没有 '*'
  const rest = appIdFull ? appIdFull.slice(appIdFull.indexOf('.') + 1) : null;
  const wildcard = !!(rest && rest.indexOf('*') >= 0);
  const bundleId = rest == null ? null : (wildcard ? rest.replace(/\.?\*+$/, '') : rest);
  const devices = arrayOf(plistXml, 'ProvisionedDevices');
  const allDevices = boolVal(plistXml, 'ProvisionsAllDevices');
  return {
    name: str(plistXml, 'Name'),
    uuid: str(plistXml, 'UUID'),
    team: (arrayOf(plistXml, 'TeamIdentifier') || [])[0] || null,
    created: dateVal(plistXml, 'CreationDate'),
    expiry: dateVal(plistXml, 'ExpirationDate'),
    appIdFull, bundleId, wildcard,
    getTaskAllow: (/<key>get-task-allow<\/key>\s*<(true|false)\/?>/.exec(plistXml) || [])[1] || null,
    allDevices, devices,
    type: allDevices === true ? 'enterprise' : (devices && devices.length ? 'adhoc' : 'appstore')
  };
}

/** 描述文件里的 Bundle ID 与 IPA 里的能否对得上 */
function bundleMatches(prof, ipaBundle) {
  if (!prof || prof.bundleId == null || !ipaBundle) return null;
  if (prof.wildcard) return ipaBundle.indexOf(prof.bundleId) === 0;   // 纯通配符时 bundleId='' → 全匹配
  return ipaBundle === prof.bundleId;
}

/** 剩余天数（负数 = 已过期） */
function daysLeft(prof, now) {
  if (!prof || !prof.expiry) return null;
  return Math.floor((new Date(prof.expiry).getTime() - (now || Date.now())) / 86400000);
}

/** 极简 ZIP 读取：只为从 IPA 里抠出 Payload/*.app/Info.plist。
 *  正常返回 { name, data }；wantList=true 时返回 { entries:[条目名...] } 便于排查。 */
function readZipEntry(zipPath, nameTest, wantList) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return wantList ? { entries: [], error: '不是 zip（找不到 EOCD）' } : null;
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cd = Buffer.alloc(Math.max(0, size - cdOffset));
    fs.readSync(fd, cd, 0, cd.length, cdOffset);
    const names = [];
    let p = 0;
    for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const entryName = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      names.push(entryName);
      if (nameTest(entryName)) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOffset);
        const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = Buffer.alloc(compSize);
        fs.readSync(fd, data, 0, compSize, dataStart);
        if (method === 0) return { name: entryName, data };
        if (method === 8) return { name: entryName, data: zlib.inflateRawSync(data) };
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return wantList ? { entries: names } : null;
  } finally { fs.closeSync(fd); }
}

/** 从 IPA 里读出 Bundle ID（Info.plist 可能是 XML 也可能是二进制 plist，字符串都是可见 ASCII） */
function readIpaBundleId(ipaPath) {
  const hit = readZipEntry(ipaPath, n => /^Payload[\\/][^\\/]+\.app[\\/]Info\.plist$/.test(n));
  if (!hit || !hit.data) {
    const list = readZipEntry(ipaPath, () => false, true);
    return { bundleId: null, entry: null, entries: (list && list.entries) || [], error: (list && list.error) || null };
  }
  const txt = hit.data.toString('latin1');
  const m = /com\.[A-Za-z0-9][A-Za-z0-9._-]{3,}/.exec(txt);
  return { bundleId: m ? m[0] : null, entry: hit.name, entries: [] };
}

/* ==================================== CLI ==================================== */
if (require.main === module) {
  const args = process.argv.slice(2);
  const profPath = args.find(a => !a.startsWith('--'));
  const ipaPath = args.includes('--ipa') ? args[args.indexOf('--ipa') + 1] : null;
  const udid = args.includes('--udid') ? args[args.indexOf('--udid') + 1] : null;

  function die(msg) { console.error('错误: ' + msg); process.exit(2); }
  if (!profPath) {
    console.log('用法: node tools/inspect-mobileprovision.js <profile.mobileprovision> [--ipa app.ipa] [--udid 设备UDID]');
    process.exit(1);
  }
  if (!fs.existsSync(profPath)) die('找不到文件: ' + profPath);

  const plistXml = extractPlistFromProvision(fs.readFileSync(profPath));
  if (!plistXml) die('这个文件里没找到内嵌的 plist —— 确定是 .mobileprovision 吗？');
  const prof = parseProfile(plistXml);
  let problems = 0;

  const typeText = {
    enterprise: '企业证书 In-House（可装到任意设备）',
    adhoc: '开发 / Ad-Hoc（只能装到列表内的 ' + (prof.devices || []).length + ' 台设备）',
    appstore: 'App Store 分发（不能直接装到设备，需走 TestFlight/上架）'
  }[prof.type];

  console.log('================ 描述文件体检 ================');
  console.log('  文件        : ' + path.basename(profPath));
  console.log('  名称        : ' + (prof.name || '(读不到)'));
  console.log('  UUID        : ' + (prof.uuid || '(读不到)'));
  console.log('  Team ID     : ' + (prof.team || '(读不到)'));
  console.log('  类型        : ' + typeText);
  console.log('  App ID      : ' + (prof.appIdFull || '(读不到)'));
  console.log('  Bundle ID   : ' + (prof.bundleId || '(读不到)') + (prof.wildcard ? '  ← 通配符证书' : ''));
  console.log('  get-task-allow（可否调试）: ' + (prof.getTaskAllow === null ? '(无)' : prof.getTaskAllow));
  console.log('  创建 / 过期 : ' + (prof.created || '?') + '  →  ' + (prof.expiry || '?'));

  const dl = daysLeft(prof);
  if (dl !== null) {
    if (dl < 0) { console.log('  ⚠️  描述文件已过期 ' + (-dl) + ' 天'); problems++; }
    else console.log('  剩余有效期  : ' + dl + ' 天');
  }

  if (ipaPath) {
    console.log('');
    console.log('================ 与 IPA 比对 ================');
    if (!fs.existsSync(ipaPath)) die('找不到 IPA: ' + ipaPath);
    const r = readIpaBundleId(ipaPath);
    console.log('  IPA 内文件          : ' + (r.entry || '(没找到 Payload/*.app/Info.plist)'));
    if (r.entries.length) console.log('  IPA 内的条目示例    : ' + r.entries.slice(0, 6).join(' | '));
    console.log('  IPA 里的 Bundle ID  : ' + (r.bundleId || '(没读到，请对照云构建日志里的 CFBundleIdentifier)'));
    console.log('  证书里的 Bundle ID  : ' + (prof.bundleId || '(读不到)'));
    const ok = bundleMatches(prof, r.bundleId);
    if (ok === true) console.log('  ✅ 一致，可以直接签名');
    else if (ok === false) {
      console.log('  ❌ 不一致！这正是签名失败的头号原因。');
      console.log('     两种解法：');
      console.log('       1) 到 Apple Developer 建一个 App ID = ' + r.bundleId + ' 的描述文件；或');
      console.log('       2) 重跑云构建，在 bundle_id 输入框里填 "' + prof.bundleId + '"，让 IPA 改用证书的 ID');
      problems++;
    }
  }

  if (udid) {
    console.log('');
    console.log('================ 设备检查 ================');
    console.log('  要装的设备 UDID : ' + udid);
    if (prof.type === 'enterprise') console.log('  ✅ 企业证书，任意设备都能装');
    else if (prof.devices && prof.devices.length) {
      if (prof.devices.some(d => d.toLowerCase() === udid.toLowerCase())) console.log('  ✅ 该设备在描述文件列表里');
      else {
        console.log('  ❌ 该设备**不在**描述文件列表里，装上会失败');
        console.log('     解法：到 Apple Developer 后台把该 UDID 加进 Devices，重新生成描述文件');
        problems++;
      }
    } else { console.log('  ⚠️  这是 App Store 分发描述文件，不能直接装到设备'); problems++; }
  }

  console.log('');
  console.log(problems === 0 ? '结论: 没发现问题 ✅' : ('结论: 有 ' + problems + ' 个问题需要先解决 ⚠️'));
  process.exit(problems === 0 ? 0 : 1);
}

module.exports = {
  extractPlistFromProvision, valueFor, str, dateVal, arrayOf, boolVal,
  parseProfile, bundleMatches, daysLeft, readZipEntry, readIpaBundleId
};
