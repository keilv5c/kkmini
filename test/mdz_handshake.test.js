/* ============================================================================
 * mdz_handshake.test.js —— 握手状态机的回归测试（不需要真设备/真网络）
 * ----------------------------------------------------------------------------
 * 起因（真机日志）：
 *   应用客机回码失败：Failed to execute 'setRemoteDescription' on 'RTCPeerConnection':
 *     Failed to set remote answer sdp: Called in wrong state: stable
 *   现场是"扫码已经成功、却报错、客机一直进不去"。
 *
 * 根因：原生扫码回调会连发多次（插件要同一个码连续识别 N 帧才回调，事件到达 JS 的
 * 顺序不保证），于是同一张回码被应用两次：第二次 setRemoteDescription(answer) 时
 * PC 已经是 stable，必然抛错 —— 而第一次其实已经成功了。
 *
 * 这个文件用一个"和浏览器行为一致"的假 RTCPeerConnection（非法状态转换会 reject）
 * 来守住：重复回码必须被静默忽略、陈旧回码必须给出可操作的报错、文本模式必须保留
 * 完整 SDP（不裁剪候选）。
 *
 * 运行：node test/mdz_handshake.test.js
 * ==========================================================================*/
'use strict';
const Core = require('../web/mdz_core.js');
const P2P = require('../web/mdz_p2p.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

P2P.CFG.OPEN_TIMEOUT = 250;   // 假通道永远不会 open，别让 waitOpen 卡 45 秒

/* ------------------------------------------------- 和浏览器一致的信令状态机 */
let remoteApplied = 0, localOffer = 0, localAnswer = 0;
function FakePC() {
  this.signalingState = 'stable';
  this.iceGatheringState = 'complete';       // 直接算收集完成，跳过等待
  this.iceConnectionState = 'new';
  this.connectionState = 'new';
  this.localDescription = null;
  this.remoteDescription = null;
  this._chs = [];
}
FakePC.prototype.createDataChannel = function (label) {
  const ch = { label, readyState: 'connecting', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
  this._chs.push(ch);
  return ch;
};
FakePC.prototype.createOffer = function () { return Promise.resolve({ type: 'offer', sdp: this._sdp }); };
FakePC.prototype.createAnswer = function () { return Promise.resolve({ type: 'answer', sdp: this._sdp }); };
FakePC.prototype.setLocalDescription = function (d) {
  // 真实浏览器：stable 下能设本地 offer；have-remote-offer 下能设本地 answer
  if (d.type === 'offer') {
    if (this.signalingState !== 'stable') {
      return Promise.reject(new Error('Failed to set local offer sdp: Called in wrong state: ' + this.signalingState));
    }
    this.localDescription = { type: 'offer', sdp: d.sdp };
    localOffer++;
    this.signalingState = 'have-local-offer';
    return Promise.resolve();
  }
  if (this.signalingState !== 'have-remote-offer') {
    return Promise.reject(new Error('Failed to set local answer sdp: Called in wrong state: ' + this.signalingState));
  }
  this.localDescription = { type: 'answer', sdp: d.sdp };
  localAnswer++;
  this.signalingState = 'stable';
  return Promise.resolve();
};
FakePC.prototype.setRemoteDescription = function (d) {
  const t = d && d.type;
  if (t === 'answer') {
    if (this.signalingState !== 'have-local-offer') {
      return Promise.reject(new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': " +
        'Failed to set remote answer sdp: Called in wrong state: ' + this.signalingState));
    }
    remoteApplied++;
    this.remoteDescription = { type: 'answer', sdp: d.sdp };
    this.signalingState = 'stable';
    return Promise.resolve();
  }
  if (t === 'offer') {
    if (this.signalingState !== 'stable') {
      return Promise.reject(new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': " +
        'Failed to set remote offer sdp: Called in wrong state: ' + this.signalingState));
    }
    this.remoteDescription = { type: 'offer', sdp: d.sdp };
    this.signalingState = 'have-remote-offer';
    return Promise.resolve();
  }
  return Promise.reject(new Error('不支持的描述类型：' + t));
};
FakePC.prototype.close = function () { this.closed = true; };
FakePC.prototype.addEventListener = function () {};
FakePC.prototype.removeEventListener = function () {};

const RTC = { RTCPeerConnection: FakePC };

/* ------------------------------------------------------------- SDP 夹具 */
const FP = 'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) =>
  ((i * 7 + 3) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

function makeSdp(hostN, srflxN, mdnsOnly) {
  const L = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0'];
  for (let i = 0; i < hostN; i++) {
    const addr = mdnsOnly ? `8f7a1c2e-1234-4a5b-9c8d-0e1f2a3b4c${i}d.local` : `192.168.1.${10 + i}`;
    L.push(`a=candidate:10000${i} 1 udp 2122260223 ${addr} 5432${i} typ host generation 0 network-id ${i + 1}`);
  }
  for (let i = 0; i < srflxN; i++) {
    L.push(`a=candidate:20000${i} 1 udp 1686052607 1.201.191.${20 + i} 5574${i} typ srflx ` +
      'raddr 192.168.1.10 rport 54320 generation 0 network-id 1');
  }
  L.push('a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy', 'a=ice-options:trickle',
    FP, 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '');
  return L.join('\r\n');
}
function countCand(sdp) { return (sdp.match(/^a=candidate:/gm) || []).length; }

function makeSession(role, mode, sdp) {
  const logs = [];
  const s = new P2P.MdzSession({ role, mode, env: {}, RTC, debug: false });
  FakePC.prototype._sdp = sdp;                 // 让假 PC 吐出我们想要的 SDP
  s.log = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
  s._logs = logs;
  return s;
}

console.log('Mini DAYZ WebRTC —— 握手状态机回归测试');

(async () => {
  /* --------------------------------------------- 1. 房主重复应用同一张回码 */
  section('1. 房主：同一张回码被应用两次（原生回调连发）');
  {
    remoteApplied = 0;
    const sdp = makeSdp(2, 0, false);
    const s = makeSession('host', 'qr', sdp);
    const payload = await s.createOffer();
    ok('QR 模式能生成 Offer 握手串', typeof payload === 'string' && payload.indexOf('MDZ1.') === 0);
    const ans = { type: 'answer', sdp: sdp.replace('a=setup:actpass', 'a=setup:active') };

    await s.acceptAnswer(ans);
    eq('第一次应用成功（PC 只被写一次）', remoteApplied, 1);
    eq('应用后状态回到 stable', s.pc.signalingState, 'stable');

    let dupErr = null;
    await s.acceptAnswer(ans).catch((e) => { dupErr = e; });
    eq('第二次（重复）不再抛错', dupErr, null);
    eq('重复时没有再次写入远端描述', remoteApplied, 1);
    ok('日志里明确写了"重复的客机回码"',
      s._logs.join(' | ').indexOf('重复的客机回码') >= 0, s._logs.slice(-1)[0]);
  }

  /* ------------------------------------------------ 2. 陈旧回码要给出人话 */
  section('2. 房主：回码对应的是上一版会话（房间被重建过）');
  {
    remoteApplied = 0;
    const s = makeSession('host', 'qr', makeSdp(2, 0, false));   // 故意不调 createOffer
    let e = null;
    await s.acceptAnswer({ type: 'answer', sdp: makeSdp(1, 0, false) }).catch((x) => { e = x; });
    ok('必须拒绝，而不是把 PC 搞成脏状态', !!e);
    eq('错误码是 STALE_HANDSHAKE', e && e.code, P2P.ERR.STALE_HANDSHAKE);
    ok('错误信息告诉用户去扫最新二维码', !!e && /最新二维码/.test(e.message), e && e.message);
    eq('没有写入任何远端描述', remoteApplied, 0);
    ok('日志说明了原因', s._logs.join(' | ').indexOf('回码无法应用') >= 0);
  }

  /* --------------------------------------------------- 3. 客机重复扫同一张码 */
  section('3. 客机：房主二维码被扫两次');
  {
    remoteApplied = 0; localAnswer = 0;
    const offer = Core.packSdp({ type: 'offer', sdp: makeSdp(2, 0, false) });
    const s = makeSession('client', 'qr', makeSdp(3, 1, false));
    const p1 = await s.acceptOffer(Core.unpackSdp(offer));
    const p2 = await s.acceptOffer(Core.unpackSdp(offer));
    eq('第二次返回的是同一份 Answer（可安全重发）', p1, p2);
    eq('Answer 只生成了一次', localAnswer, 1);
    ok('日志说明了复用', s._logs.join(' | ').indexOf('重复的房主二维码') >= 0);
  }

  /* ------------------------------------ 4. 传输层 API：重复回码不再报 error */
  section('4. 端到端（MDZP2P API）：整个流程里不应出现 "wrong state" 报错');
  {
    P2P._reset();
    const errs = [];
    P2P.on('error', (e) => errs.push(e));

    const r = await P2P.hostBegin({ mode: 'qr', env: {}, RTC });
    const packedAnswer = Core.packSdp({ type: 'answer', sdp: makeSdp(2, 0, false).replace('a=setup:actpass', 'a=setup:active') });

    // 第一次：正常应用（随后 waitOpen 会因为假通道永不 open 而超时，属预期）
    await P2P.hostAcceptPeer(packedAnswer).catch(() => {});
    const stAfterFirst = P2P.currentHost().pc.signalingState;
    eq('第一次应用后 PC 处于 stable', stAfterFirst, 'stable');

    // 第二次：必须静默忽略
    await P2P.hostAcceptPeer(packedAnswer).catch(() => {});
    const bad = errs.filter((e) => /wrong state/i.test(e && e.message || ''));
    eq('没有任何 "Called in wrong state" 报错', bad.length, 0);
    const stale = errs.filter((e) => e && e.code === P2P.ERR.STALE_HANDSHAKE);
    eq('也没有把重复回码误判成"过期回码"', stale.length, 0);
    ok('Offer 握手串正常生成', !!r && !!r.payload);

    // 通道已经打开时：重复回码应当立刻成功返回
    P2P.currentHost().open = true;
    let okOpen = false;
    await P2P.hostAcceptPeer(packedAnswer).then(() => { okOpen = true; }).catch(() => {});
    ok('通道已连上时，再来一张回码直接忽略并成功返回', okOpen);
    P2P._reset();
  }

  /* ---------------------- 5. 文本模式必须保留完整 SDP（异地连通率的关键） */
  section('5. 模式B（异地文本）：不裁剪 SDP、不瘦身候选');
  {
    const many = makeSdp(10, 4, false);
    const total = countCand(many);
    eq('夹具本身有 14 个候选', total, 14);

    const txt = makeSession('host', 'text', many);
    const pText = await txt.createOffer();
    eq('文本模式打包后候选一个不少', countCand(Core.unpackSdp(pText).sdp), total);

    const qr = makeSession('host', 'qr', many);
    const pQr = await qr.createOffer();
    const qrCand = countCand(Core.unpackSdp(pQr).sdp);
    ok('对比：QR 模式仍然瘦身候选（二维码不能太大）', qrCand < total, 'QR=' + qrCand + ' / 全部=' + total);
  }

  /* ----------------------------------------------- 6. 没有公网候选要说清楚 */
  section('6. 诊断文案：连不上时得告诉用户为什么');
  {
    const noSrflx = makeSession('host', 'text', makeSdp(2, 0, false));
    await noSrflx.createOffer();
    ok('文本模式没有 srflx 时置位 _srflxMissing', noSrflx._srflxMissing === true);
    ok('日志里给出 ⚠️ 提示', noSrflx._logs.join(' | ').indexOf('没有拿到任何公网反射候选') >= 0);
    ok('diagnose() 明确指出异地必失败', /STUN 全部没响应|异地必失败/.test(noSrflx.diagnose()), noSrflx.diagnose());

    const mdns = makeSession('host', 'qr', makeSdp(2, 0, true));
    await mdns.createOffer();
    ok('只有 mDNS 候选时 diagnose() 指向"授权摄像头后重出码"',
      /mDNS/.test(mdns.diagnose()) && /授权摄像头/.test(mdns.diagnose()), mdns.diagnose());
  }

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('\n测试自身抛错：' + (e && e.stack || e));
  process.exit(1);
});
