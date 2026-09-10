/* ============================================================================
 * tools/patch-mlkit-votes.js —— 把扫码插件的"投票门槛"从 10 帧降到 3 帧
 * ----------------------------------------------------------------------------
 * 为什么必须改（真实故障）：
 *   @capacitor-mlkit/barcode-scanning 在 iOS 和安卓上都会对同一个码**投票**：
 *     iOS   ios/Plugin/BarcodeScanner.swift    voteForBarcodes: votes >= 10
 *     安卓  android/.../BarcodeScanner.java    voteForBarcodes: votes >= 10
 *   也就是说，同一个二维码必须被**连续识别到 10 帧**才会回调 barcodesScanned。
 *   我们的握手串压缩后是 89x89 模块的密集二维码（约 370px 显示在手机屏上），
 *   相机在 720p 全画幅下每模块只有 ~2 像素，MLKit 只能**间歇**识别到它 ——
 *   于是投票涨得很慢，表现就是"iOS 怎么都扫不上，偶尔突然又扫上了"，
 *   而安卓机型摄像头/对焦更好时偶尔能凑够票，于是"安卓能扫"。
 *
 *   降到 3 帧后回调快 ~3 倍，密集码终于能稳定扫上。
 *
 * 为什么敢降：我们自己的握手串带 FNV-1a 校验（格式 MDZ1.<base64url>.<fnv36>），
 *   万一误读，unpackSdp 会直接报"握手串解析失败"，不会把半截 SDP 塞给
 *   RTCPeerConnection 导致更难查的问题。
 *
 * 用法：
 *   node tools/patch-mlkit-votes.js          # 打补丁（幂等）
 *   node tools/patch-mlkit-votes.js --check  # 只检查有没有打上
 *   已挂到 package.json 的 postinstall，npm ci / npm install 之后自动生效。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VOTE_MIN = 3;

const TARGETS = [
  {
    name: 'iOS',
    file: path.join(ROOT, 'node_modules', '@capacitor-mlkit', 'barcode-scanning',
      'ios', 'Plugin', 'BarcodeScanner.swift'),
    // Swift: return votes >= 10
    re: /return votes >= 10\b/,
    to: 'return votes >= ' + VOTE_MIN,
    patched: new RegExp('return votes >= ' + VOTE_MIN + '\\b')
  },
  {
    name: 'Android',
    file: path.join(ROOT, 'node_modules', '@capacitor-mlkit', 'barcode-scanning',
      'android', 'src', 'main', 'java', 'io', 'capawesome', 'capacitorjs', 'plugins',
      'mlkit', 'barcodescanning', 'BarcodeScanner.java'),
    // Java: if (votes == null || votes >= 10) {
    re: /votes >= 10\b/,
    to: 'votes >= ' + VOTE_MIN,
    patched: new RegExp('votes >= ' + VOTE_MIN + '\\b')
  }
];

function warn(msg) {
  console.log('::warning::' + msg);
}

function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0;
  let touched = 0, already = 0, missing = 0;

  console.log('扫码插件投票门槛补丁（同一个码要连续识别多少帧才回调）');
  for (const t of TARGETS) {
    if (!fs.existsSync(t.file)) {
      console.log(`  --    ${t.name}: 找不到文件（node_modules 还没装？）`);
      missing++;
      continue;
    }
    let src = fs.readFileSync(t.file, 'utf8');
    if (t.patched.test(src)) {
      console.log(`  OK    ${t.name}: 已经是 votes >= ${VOTE_MIN}（无需再改）`);
      already++;
      continue;
    }
    if (!t.re.test(src)) {
      // 插件升级改了写法：只告警，绝不让构建失败（原始门槛也能用，只是慢）
      warn(`${t.name}: 没找到 "votes >= 10" 这段代码，插件可能升级了 —— ` +
        `请重新确认 ${path.relative(ROOT, t.file)} 的投票逻辑（本次不改动）`);
      missing++;
      continue;
    }
    if (checkOnly) {
      console.log(`  !!    ${t.name}: 还没打补丁（当前仍是 votes >= 10）`);
      missing++;
      continue;
    }
    src = src.replace(t.re, t.to);
    fs.writeFileSync(t.file, src);
    console.log(`  FIX   ${t.name}: votes >= 10 -> votes >= ${VOTE_MIN}`);
    touched++;
  }

  console.log(`  小结：改了 ${touched} 个，本来就好 ${already} 个，跳过 ${missing} 个`);
  if (checkOnly && missing > 0) process.exit(1);
}

try {
  main();
} catch (e) {
  // 这个脚本是"锦上添花"，绝不能因为它让 npm install / 构建挂掉
  warn('投票门槛补丁执行异常（已忽略，不影响构建）：' + (e && e.message));
}
