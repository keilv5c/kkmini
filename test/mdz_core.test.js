/* ============================================================================
 * mdz_core.test.js —— mdz_core.js 的 Node 单元测试（不需要浏览器/第二台设备）
 * 运行：node test/mdz_core.test.js
 * ==========================================================================*/
'use strict';
const Core = require('../web/mdz_core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a).slice(0, 80) + ' want=' + JSON.stringify(b).slice(0, 80)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* --------------------------------------------------- 真实形态的 data-only SDP */
const FP = 'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) => ((i * 7 + 3) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

// 模式A：只收集 host 候选（现代 Chrome 会做 mDNS 混淆）
const SDP_A_MDNS = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1903873481 1 udp 2122260223 8f7a1c2e-1234-4a5b-9c8d-0e1f2a3b4c5d.local 54321 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:1903873482 1 udp 2122194687 3b2a1f0e-5678-4c9d-8e1f-2a3b4c5d6e7f.local 54322 typ host generation 0 network-id 2 network-cost 10',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy',
  'a=ice-options:trickle',
  FP,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ''
].join('\r\n');

// 模式A 变体：拿到真实内网 IP（未混淆）
const SDP_A_LAN = SDP_A_MDNS
  .replace(/a=candidate:1903873481 1 udp 2122260223 \S+ 54321/, 'a=candidate:1903873481 1 udp 2122260223 192.168.137.1 54321')
  .replace(/a=candidate:1903873482 1 udp 2122194687 \S+ 54322/, 'a=candidate:1903873482 1 udp 2122194687 172.20.7.233 54322');

// 模式B：带 STUN 反射候选
const SDP_B = SDP_A_LAN
  .replace('a=ice-options:trickle', 'a=ice-options:trickle')
  .replace('a=setup:actpass', [
    'a=candidate:842163049 1 udp 1686052607 1.201.191.211 55745 typ srflx raddr 192.168.137.1 rport 54321 generation 0 network-id 1',
    'a=setup:actpass'
  ].join('\r\n')) + 'a=end-of-candidates\r\n';

// 一条带音视频 m-line 的 SDP（我们永远不会用到，只用来验证裁剪不会破坏 m-line 结构）
const SDP_AV = SDP_A_MDNS
  .replace('a=extmap-allow-mixed', ['a=extmap-allow-mixed', 'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level'].join('\r\n'))
  + ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', ''].join('\r\n');

console.log('Mini DAYZ WebRTC —— mdz_core 单元测试');
console.log('pako 版本:', require('pako/package.json').version);

/* ------------------------------------------------------------------ 1. 打包 */
section('1. SDP 打包 / 解包');
const packedA = Core.packSdp({ type: 'offer', sdp: SDP_A_MDNS });
const packedB = Core.packSdp({ type: 'answer', sdp: SDP_B });
ok('模式A 打包成功', packedA.startsWith('MDZ1.'));
const backA = Core.unpackSdp(packedA);
eq('模式A 解包 type', backA.type, 'offer');
eq('模式A 解包 sdp 完全一致', backA.sdp, SDP_A_MDNS);
const backB = Core.unpackSdp(packedB);
eq('模式B 解包 type', backB.type, 'answer');
eq('模式B 解包 sdp 完全一致', backB.sdp, SDP_B);

// 容忍聊天软件插入的空白/换行
const mangled = '  ' + packedA.slice(0, 60) + '\n' + packedA.slice(60, 200) + '\r\n  ' + packedA.slice(200) + '\n';
eq('容忍换行/空格/首尾空白', Core.unpackSdp(mangled).sdp, SDP_A_MDNS);

// 错误处理
function throws(name, fn) { try { fn(); ok(name, false, '应当抛错但没有'); } catch (e) { ok(name, true, e.message.slice(0, 46)); } }
throws('缺少前缀时报错', () => Core.unpackSdp('hello world'));
throws('被截断时报错', () => Core.unpackSdp(packedA.slice(0, packedA.length - 40)));
throws('校验和被改时报错', () => Core.unpackSdp(packedA.slice(0, packedA.lastIndexOf('.') + 1) + 'zzzz'));

/* ------------------------------------------------------------------ 2. 裁剪 */
section('2. SDP 安全裁剪');
const m1 = Core.mungeSdp(SDP_A_MDNS);
ok('裁剪后未降级', !m1.degraded, m1.reason || '');
eq('裁掉了 extmap-allow-mixed + msid-semantic 共 2 行', m1.dropped, 2);
ok('必需字段全部保留', Core.REQUIRED_TOKENS.every(t => m1.sdp.indexOf(t) >= 0));
eq('m-line 数量不变', Core.countMLines(m1.sdp), Core.countMLines(SDP_A_MDNS));
eq('裁剪后仍能解出相同 sdp（再打包往返）', Core.unpackSdp(Core.packSdp({ type: 'offer', sdp: m1.sdp })).sdp, m1.sdp);

const m2 = Core.mungeSdp(SDP_AV);
eq('带音视频 m-line 时 m-line 不被破坏', Core.countMLines(m2.sdp), Core.countMLines(SDP_AV));
ok('带音视频时 rtpmap/fmtp 被删但结构完整', !m2.degraded && m2.sdp.indexOf('a=rtpmap:') < 0, 'dropped=' + m2.dropped);

const broken = SDP_A_MDNS.replace('a=sctp-port:5000\r\n', '');
const m3 = Core.mungeSdp(broken);
ok('缺少必需字段 -> 自动降级为原始 SDP', m3.degraded && m3.sdp === broken, m3.reason || '');

const m4 = Core.mungeSdp('这不是 SDP at all');
ok('非法输入 -> 降级不抛错', m4.degraded && typeof m4.sdp === 'string');

/* ------------------------------------------------------------------ 3. ICE */
section('3. ICE 候选分析');
const cA = Core.analyzeCandidates(SDP_A_MDNS);
eq('mDNS 候选数', cA.mdns, 2);
eq('真实内网候选数', cA.lan, 0);
ok('模式A 判定可用（mDNS 也算可用）', cA.modeAUsable === true);
ok('提示需要取消 mDNS 混淆', cA.needsUnobfuscation === true);

const cB = Core.analyzeCandidates(SDP_A_LAN);
eq('内网候选数=2', cB.lan, 2);
eq('mDNS 候选数=0', cB.mdns, 0);
ok('识别出内网地址', cB.lanAddresses.join(',') === '192.168.137.1:54321,172.20.7.233:54322', cB.lanAddresses.join(','));

const cC = Core.analyzeCandidates(SDP_B);
eq('模式B 识别 srflx', cC.srflx, 1);
ok('公网地址被识别为 public', Core.ipKind('1.201.191.211') === 'public');
eq('CGNAT 识别', Core.ipKind('100.64.3.9'), 'cgnat');
eq('link-local 识别', Core.ipKind('169.254.1.1'), 'linklocal');

const cEmpty = Core.analyzeCandidates(SDP_A_MDNS.split('\r\n').filter(l => !l.startsWith('a=candidate')).join('\r\n'));
ok('无候选时模式A 判定不可用', cEmpty.modeAUsable === false, 'total=' + cEmpty.total);

/* ------------------------------------------------------- 4. 代理对安全切片 */
section('4. 字符串安全切片 / 分块');
const emoji = '玩家A😀移动中🚀x'.repeat(3);
eq('切片后拼回原串', Core.splitStringSafely(emoji, 4).join(''), emoji);
ok('每片都不含孤立代理', Core.splitStringSafely(emoji, 4).every(s => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(i + 1); if (!(n >= 0xdc00 && n <= 0xdfff)) return false; i++; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}));

const big = JSON.stringify({ type: 'map_data', blob: 'A'.repeat(50000), tail: '结束😀' });
const chunks = Core.makeChunks(big, 42);
ok('大消息被分成多块', chunks.length > 1, chunks.length + ' 块');
ok('每块不超过上限', chunks.every(c => c.d.length <= Core.CHUNK_MAX_UNITS));

const ra = new Core.ChunkReassembler();
let done = null;
// 故意乱序 + 重复投递
const order = chunks.map((_, i) => i).reverse();
for (const i of order) { done = ra.push(chunks[i].__mdz, chunks[i].d) || done; }
ra.push(chunks[0].__mdz, chunks[0].d);   // 重复块不应破坏结果
eq('乱序+重复投递后完整还原', done, big);

const ra2 = new Core.ChunkReassembler();
let done2 = null;
for (const c of chunks) done2 = ra2.push(c.__mdz, c.d) || done2;
eq('顺序投递后完整还原', done2, big);

/* ------------------------------------------------------------------ 5. 分流 */
section('5. 消息分流策略');
eq('player_state -> 快通道', Core.classifyMessage({ type: 'player_state' }), 'fast');
eq('player_visual -> 快通道', Core.classifyMessage({ type: 'player_visual' }), 'fast');
eq('mpj_chunk -> 可靠通道', Core.classifyMessage({ type: 'mpj_chunk' }), 'reliable');
eq('物品操作 -> 可靠通道', Core.classifyMessage({ type: 'item_pickup' }), 'reliable');
eq('分块信封 -> 可靠通道', Core.classifyMessage({ __mdz: { id: 1 }, d: 'x' }), 'reliable');
eq('未知类型 -> 可靠通道', Core.classifyMessage({ type: 'whatever' }), 'reliable');
eq('非对象 -> 可靠通道', Core.classifyMessage('raw'), 'reliable');

/* ------------------------------------------------------- 6. 二维码体积实测 */
section('6. 握手串体积（决定二维码密度）');
function report(name, packed, rawSdp) {
  const fit = Core.qrFit(packed);
  console.log(`  ${name}`);
  console.log(`    原始 SDP      : ${rawSdp.length} 字符`);
  console.log(`    压缩+base64后 : ${fit.chars} 字符 / ${fit.bytes} 字节  (压缩率 ${(100 * fit.chars / rawSdp.length).toFixed(1)}%)`);
  console.log(`    二维码判定    : ${fit.fits ? '单张可容纳' : '超出单张容量'} —— ${fit.hint}`);
  return fit;
}
const fA = report('模式A（2 个 mDNS host 候选）', packedA, SDP_A_MDNS);
const fA2 = report('模式A（2 个真实内网 IP 候选）', Core.packSdp({ type: 'offer', sdp: SDP_A_LAN }), SDP_A_LAN);
const fB = report('模式B（内网 + 1 个 srflx 候选）', packedB, SDP_B);
const fM = report('模式A（裁剪后再打包）', Core.packSdp({ type: 'offer', sdp: Core.mungeSdp(SDP_A_MDNS).sdp }), Core.mungeSdp(SDP_A_MDNS).sdp);
ok('模式A 握手串可放进单张二维码', fA.fits, fA.chars + ' 字符');
ok('模式B 握手串可放进单张二维码', fB.fits, fB.chars + ' 字符');
ok('裁剪确实缩小了握手串', fM.chars <= fA.chars, `${fA.chars} -> ${fM.chars}`);

// 用真实的 qrcode 库量化：纠错等级 L vs M 的模块数（模块越少 = 同样屏幕尺寸下每格越大 = 越好扫）
try {
  const QRCode = require('qrcode');
  const sizeL = QRCode.create(packedA, { errorCorrectionLevel: 'L' }).modules.size;
  const sizeM = QRCode.create(packedA, { errorCorrectionLevel: 'M' }).modules.size;
  console.log(`    二维码模块数  : 纠错L = ${sizeL}x${sizeL}   纠错M = ${sizeM}x${sizeM}`);
  console.log(`    在 328px 屏幕上每格 = ${(328 / sizeL).toFixed(2)}px (L) / ${(328 / sizeM).toFixed(2)}px (M)`);
  ok('纠错等级 L 的模块数不多于 M（小屏更友好）', sizeL <= sizeM, `${sizeL} <= ${sizeM}`);
} catch (e) {
  console.log('    (未安装 qrcode 包，跳过模块数测量)');
}

/* ------------------------------------------------- 7. 候选瘦身（压缩二维码） */
section('7. 候选瘦身 trimCandidates');
const CAND = (f, pr, ip, port, typ, extra) =>
  `a=candidate:${f} 1 udp ${pr} ${ip} ${port} typ ${typ} generation 0 network-id 1${extra || ''}`;
const SDP_MULTI = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  CAND(1, 2122260223, '192.168.137.1', 54321, 'host'),
  CAND(2, 2122194687, '10.0.0.5', 54322, 'host'),
  CAND(3, 2122129151, '172.20.7.233', 54323, 'host'),          // 优先级最低，应被丢掉
  CAND(4, 1686052607, '1.201.191.211', 55745, 'srflx', ' raddr 192.168.137.1 rport 54321'),
  'a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy', FP,
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''
].join('\r\n');
eq('样例本身是合法的（4 个候选）', (SDP_MULTI.match(/typ host|typ srflx/g) || []).length, 4);

const tr = Core.trimCandidates(SDP_MULTI, 2);
ok('瘦身后未降级', !tr.degraded, tr.reason || '');
eq('丢掉了 1 个多余 host 候选', tr.dropped, 1);
eq('host 保留 2 个', (tr.sdp.match(/typ host/g) || []).length, 2);
eq('srflx 保留 1 个', (tr.sdp.match(/typ srflx/g) || []).length, 1);
eq('保留的是优先级最高的两个', Core.analyzeCandidates(tr.sdp).lanAddresses.join(','),
  '192.168.137.1:54321,10.0.0.5:54322');
ok('丢掉的正是优先级最低的 172.20.7.233', tr.sdp.indexOf('172.20.7.233') < 0);
eq('m-line 数量不变', Core.countMLines(tr.sdp), Core.countMLines(SDP_MULTI));
ok('瘦身后仍能打包/解包往返', Core.unpackSdp(Core.packSdp({ type: 'offer', sdp: tr.sdp })).sdp === tr.sdp);
ok('瘦身确实缩小了手串',
  Core.packSdp({ type: 'offer', sdp: tr.sdp }).length < Core.packSdp({ type: 'offer', sdp: SDP_MULTI }).length,
  Core.packSdp({ type: 'offer', sdp: SDP_MULTI }).length + ' -> ' + Core.packSdp({ type: 'offer', sdp: tr.sdp }).length);

const trNone = Core.trimCandidates(SDP_A_MDNS.split('\r\n').filter(l => !l.startsWith('a=candidate')).join('\r\n'), 2);
ok('没有候选时降级并原样返回', trNone.degraded && trNone.dropped === 0);
const trOne = Core.trimCandidates(SDP_A_LAN, 2);
ok('候选本来就少时不丢任何东西', trOne.dropped === 0 && trOne.sdp === SDP_A_LAN);

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
