/* ============================================================================
 * tool_mobileprovision.test.js —— 证书体检工具的单元测试
 * ----------------------------------------------------------------------------
 * 为什么值得测：这个工具是"签名前最后一道关"，它要是读错了值，
 * 用户会照着错误结论去签名，白折腾一轮。所以把各种描述文件形态都覆盖一遍。
 * 运行：node test/tool_mobileprovision.test.js
 * ==========================================================================*/
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', 'tools', 'inspect-mobileprovision.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 造一个描述文件（真实结构：CMS 容器里内嵌明文 plist） */
function makeProvision(opts) {
  const o = Object.assign({
    name: 'MDZ AdHoc', uuid: '1111-2222', team: 'ABCDE12345',
    appId: 'ABCDE12345.com.mdz.webrtcmp',
    created: '2026-01-01T00:00:00Z', expiry: '2027-01-01T00:00:00Z',
    taskAllow: 'true', devices: ['00008030-001A2B3C4D5E006E', '00008110-000C0D0E0F100011'],
    allDevices: false
  }, opts || {});
  const dev = (o.devices && o.devices.length)
    ? '<key>ProvisionedDevices</key><array>' + o.devices.map(d => '<string>' + d + '</string>').join('') + '</array>'
    : '';
  const all = o.allDevices ? '<key>ProvisionsAllDevices</key><true/>' : '';
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x0A, 0x1C, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02, 0xA0]),
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>${o.name}</string>
<key>UUID</key><string>${o.uuid}</string>
<key>TeamIdentifier</key><array><string>${o.team}</string></array>
<key>CreationDate</key><date>${o.created}</date>
<key>ExpirationDate</key><date>${o.expiry}</date>
${dev}${all}
<key>Entitlements</key><dict>
<key>application-identifier</key><string>${o.appId}</string>
<key>get-task-allow</key><${o.taskAllow}/>
</dict>
</dict></plist>`, 'utf8'),
    Buffer.from([0x00, 0x00, 0x00, 0x00])
  ]);
}

console.log('Mini DAYZ WebRTC —— 描述文件体检工具测试');

/* ------------------------------------------------------------ 1. 基本解析 */
section('1. 解析 Ad-Hoc 描述文件');
const p1 = T.parseProfile(T.extractPlistFromProvision(makeProvision()));
eq('名称', p1.name, 'MDZ AdHoc');
eq('UUID', p1.uuid, '1111-2222');
eq('Team ID', p1.team, 'ABCDE12345');
eq('App ID（含 Team 前缀）', p1.appIdFull, 'ABCDE12345.com.mdz.webrtcmp');
eq('Bundle ID（去掉 Team 前缀）', p1.bundleId, 'com.mdz.webrtcmp');
eq('类型 = adhoc', p1.type, 'adhoc');
eq('设备数量', (p1.devices || []).length, 2);
eq('get-task-allow', p1.getTaskAllow, 'true');
ok('不是通配符证书', p1.wildcard === false);

/* -------------------------------------------------------- 2. 三种证书类型 */
section('2. 证书类型判定');
const ent = T.parseProfile(T.extractPlistFromProvision(makeProvision({ allDevices: true, devices: [] })));
eq('企业证书 → enterprise', ent.type, 'enterprise');
ok('企业证书的设备列表为空', !ent.devices);
const store = T.parseProfile(T.extractPlistFromProvision(makeProvision({ devices: [] })));
eq('无设备列表 → appstore', store.type, 'appstore');
const wild = T.parseProfile(T.extractPlistFromProvision(makeProvision({ appId: 'ABCDE12345.*' })));
eq('通配符 → bundleId 去掉 *', wild.bundleId, '');
ok('通配符标记', wild.wildcard === true);
const wild2 = T.parseProfile(T.extractPlistFromProvision(makeProvision({ appId: 'ABCDE12345.com.foo.*' })));
eq('前缀通配符 → bundleId = com.foo', wild2.bundleId, 'com.foo');
ok('前缀通配符匹配任意子域', T.bundleMatches(wild2, 'com.foo.bar') === true);

/* ---------------------------------------------------- 3. Bundle ID 一致性 */
section('3. Bundle ID 比对（签名失败头号原因）');
ok('完全一致 → true', T.bundleMatches(p1, 'com.mdz.webrtcmp') === true);
ok('不一致 → false', T.bundleMatches(p1, 'com.someoneelse.game') === false);
ok('IPA 读不到时 → null（不误报）', T.bundleMatches(p1, null) === null);
ok('描述文件读不到时不误报', T.bundleMatches(null, 'com.a.b') === null);

/* ------------------------------------------------------------ 4. 有效期 */
section('4. 有效期计算');
const now = new Date('2026-06-01T00:00:00Z').getTime();
eq('距离 2027-01-01 还有 214 天', T.daysLeft(p1, now), 214);
const exp = T.parseProfile(T.extractPlistFromProvision(makeProvision({ expiry: '2026-05-01T00:00:00Z' })));
ok('过期的证书算出负数', T.daysLeft(exp, now) < 0, 'daysLeft=' + T.daysLeft(exp, now));

/* --------------------------------------------------- 5. 缺字段/坏文件容错 */
section('5. 容错');
ok('非描述文件 → extractPlistFromProvision 返回 null', T.extractPlistFromProvision(Buffer.from('hello world')) === null);
const bare = T.parseProfile('<plist version="1.0"><dict></dict></plist>');
ok('空 dict 不抛错', bare.name === null && bare.bundleId === null);
eq('空 dict 的到期天数为 null', T.daysLeft(bare), null);
eq('空 dict 的匹配结果为 null', T.bundleMatches(bare, 'com.a'), null);

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
