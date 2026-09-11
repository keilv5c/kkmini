/* ============================================================================
 * mdz_fix_audit.test.js —— 本次真机故障修复点的审计测试
 * ----------------------------------------------------------------------------
 * 现场（iOS 房主 + 安卓客机，2026-09）：
 *   1) "安卓能扫码成功，iOS 回扫怎么也扫不上，偶尔突然就扫上了"
 *   2) 安卓日志：Failed to set remote answer sdp: Called in wrong state: stable
 *      → 客机一直进不去
 *   3) 异地文本模式：双方握手串都贴好了，却一直卡在"等待直连"
 *
 * 对应修复（每条都在 test/mdz_handshake.test.js 或本文件里钉住）：
 *   A. 传输层幂等：重复回码静默忽略、陈旧回码给人话    → mdz_handshake.test.js
 *   B. UI 单次闩锁：原生回调连发只认第一张              → 本文件
 *   C. iOS 识别率：1080p + 数字变焦 + 藏掉所有 HTML      → 本文件
 *   D. 出码前先要摄像头权限（否则 Offer 只有 mDNS 地址）  → 本文件
 *   E. 文本模式保留完整 SDP（不再白丢候选）              → mdz_handshake.test.js
 *   F. 插件投票门槛 10 帧 → 3 帧                         → 本文件（真跑工具）
 *
 * 运行：node test/mdz_fix_audit.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(ROOT, 'web', 'mdz_ui.js'), 'utf8');
const p2p = fs.readFileSync(path.join(ROOT, 'web', 'mdz_p2p.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

console.log('Mini DAYZ WebRTC —— 真机故障修复点审计');

/* ---------------------------------------------- B. UI 侧单次扫码闩锁 */
section('B. 扫码回调连发只处理一次（stable 报错的直接来源）');
ok('存在 scanHandled 闩锁状态', /scanHandled/.test(ui));
ok('onScanned 第一件事就是检查闩锁', /function onScanned\(payload, purpose\) \{[\s\S]{0,700}?if \(state\.scanHandled\)/.test(ui));
ok('每次开扫都会重置闩锁', /state\.scanHandled = false/.test(ui));
ok('重复回调会写日志而不是静默吞掉', /重复的扫码回调已忽略/.test(ui));

/* ------------------------------- C. iOS 识别率：分辨率/变焦/藏掉所有 HTML */
section('C. 原生扫码识别率（iOS 默认 720p + 无变焦 → 密集码凑不满投票）');
ok('原生 startScan 明确要求 1080p（resolution: 2）', /resolution: 2/.test(ui));
ok('iOS 上会设置数字变焦', /isIOS\(\)\) applyZoom\(nat, 1\.8\)/.test(ui));
ok('8 秒未识别会把变焦再推一档', /applyZoom\(nat, 3\)/.test(ui));
ok('扫描时把**所有** HTML 都藏起来（不只是 canvas，还有全屏二维码浮层）',
  /body \*:not\(#mdz-scan-tip\):not\(#mdz-scan-reticle\)/.test(ui));
ok('扫描时给了取景框提示', /mdz-scan-reticle/.test(ui));
ok('开扫前先收起自己的二维码（否则会挡住 WebView 后面的原生预览）',
  /function startScan\(purpose, methodOverride\) \{[\s\S]{0,900}?hideQr\(\);/.test(ui));

/* ------------------------------------------- 网页扫码改成全屏取景浮层 */
section('C2. 网页扫码用全屏浮层（面板里 180px 的小窗没法瞄准）');
ok('新增全屏扫码浮层', /mdz-scan-overlay/.test(ui));
ok('html5-qrcode 挂到全屏容器上', /new window\.Html5Qrcode\('mdz-scan-camera'/.test(ui));
ok('浮层里有"换个扫码方式/取消"按钮', /switchScanMethod/.test(ui) && /取消扫码/.test(ui));

/* --------------------------------- D. 出码前先拿摄像头权限（mDNS 混淆） */
section('D. 房主出码前先授权摄像头（否则 Offer 只有 .local，对方解析不了）');
ok('onHost 在 QR 模式下传 unobfuscated: true',
  /unobfuscated: state\.mode === 'qr'/.test(ui));
ok('文本模式没有公网候选时会直说（别再让人干等）', /STUN 全部没响应/.test(ui));
ok('诊断文案接上了新的错误码', /ERR\.STALE_HANDSHAKE/.test(ui));

/* ------------------------------------- A/E. 传输层（与 mdz_handshake 呼应） */
section('A/E. 传输层幂等与文本模式完整 SDP');
ok('acceptAnswer 有"重复回码"幂等分支', /_remoteAnswerApplied/.test(p2p));
ok('acceptOffer 复用上次 Answer', /_lastAnswerPayload/.test(p2p));
ok('文本模式在 munge/trim 之前就返回完整 SDP',
  /if \(this\.mode === 'text'\) \{[\s\S]{0,400}?return Core\.packSdp\(\{ type: ld\.type, sdp: ld\.sdp \}\)/.test(p2p));
ok('STUN 列表补了 Google/Cloudflare', /stun\.l\.google\.com/.test(p2p) && /stun\.cloudflare\.com/.test(p2p));
ok('暴露了 diagnose()', /diagnose: function \(role\)/.test(p2p));

/* --------------------------------------------- F. 插件投票门槛补丁 */
section('F. 扫码插件投票门槛（同一个码要连续识别 10 帧才回调）');
ok('package.json 的 postinstall 会打补丁', pkg.scripts && /patch-mlkit-votes/.test(pkg.scripts.postinstall || ''));
let patchOut = '', patchOk = false;
try {
  patchOut = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'patch-mlkit-votes.js'), '--check'],
    { encoding: 'utf8' });
  patchOk = true;
} catch (e) { patchOut = String(e.stdout || e.message); }
ok('--check 通过（两个平台的投票门槛都已是 3）', patchOk, patchOut.split('\n').filter(Boolean).slice(-2).join(' / '));

/* --------------------------------------------------- 构建标记（可验证版本） */
section('G. 构建标记（手机上要能看到打开的是新版本）');
ok('index.html 构建号已升到 web-4', /MDZ_BUILD = 'mdz-webrtc-web-4'/.test(html));
ok('面板构建号已升到 ui-4', /var BUILD = 'mdz-ui-4'/.test(ui));
ok('跨岛检测模块已挂进 index.html', /<script src="mdz_island\.js"><\/script>/.test(html));
ok('诊断钩子已挂进 index.html', /<script src="mdz_diag\.js"><\/script>/.test(html));
ok('命中兼容层已挂进 index.html', /<script src="mdz_hitfix\.js"><\/script>/.test(html));
ok('面板提供「复制日志」（真机排查要把完整日志发出来）', /复制日志/.test(ui));
{
  const diag = fs.readFileSync(path.join(ROOT, 'web', 'mdz_diag.js'), 'utf8');
  ok('诊断模块会接上 window.MDZTrace', /window\.MDZTrace\s*=/.test(diag));
  ok('诊断模块会汇报计数器变化', /snapshot\(\)/.test(diag) && /\[统计\]/.test(diag));
  ok('诊断模块会镜像游戏内提示消息（character checkpoint restored 等）',
    /mirrorMessages/.test(diag) && /window\.appendMsg/.test(diag));

  const island = fs.readFileSync(path.join(ROOT, 'web', 'mdz_island.js'), 'utf8');
  ok('★ 跨岛模块**不再**重推世界快照（推快照会把房主的角色/背包带给客机，实测串装备）',
    !/sendSnapshot/.test(island));
  ok('跨岛模块改成"断开并提示重连"', /reconnectNow/.test(island) && /MDZP2P\.cancel/.test(island));
  ok('跨岛模块在加载时就挂事件监听（不依赖 DOMContentLoaded）',
    /window\.addEventListener\('mdz-mp-world-ready'/.test(island));

  const hit = fs.readFileSync(path.join(ROOT, 'web', 'mdz_hitfix.js'), 'utf8');
  ok('命中兼容层会把客机切到「房主裁决伤害」模式（否则命中不上报）',
    /hostArbitratedDamage/.test(hit) && /setLocalDamage\(false\)/.test(hit));
  const ply = fs.readFileSync(path.join(ROOT, 'web', 'mdz_players.js'), 'utf8');
  ok('客机角色自保层已挂进 index.html', /<script src="mdz_players\.js"><\/script>/.test(html));
  ok('角色自保层用 capture + checkpoint 把自己的角色交给房主存档',
    /MPPlayers|players\(\)/.test(ply) && /capture\(\)/.test(ply) && /checkpoint\(true, st\.mine\)/.test(ply));
  ok('角色自保层在"载入前"同步执行（不能延后到世界载入之后）',
    /mdz-mp-before-client-snapshot[\s\S]{0,220}?pushMyState\(\)/.test(ply));
  ok('命中兼容层含 29 种弹种白名单判断', /WHITELIST/.test(hit) && /t192/.test(hit) && /t881/.test(hit));
  ok('命中兼容层会校正命中点到房主权威坐标', /repairHitCoords/.test(hit) && /msg\.x = p\.x/.test(hit));
  ok('命中兼容层会在房主侧补刷新客机位置（绕开 3 秒过期全拒）',
    /refreshHostStalePos/.test(hit) && /MPEntities\.observe/.test(hit));
  ok('面板的跨岛按钮改成"断开重连"而不是重推快照',
    /跨岛后重连/.test(ui) && /reconnectNow/.test(ui));
}

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
