/* ============================================================================
 * mdz_rtc.test.js —— 真实 DataChannel 端到端测试（Node + node-datachannel polyfill）
 * ----------------------------------------------------------------------------
 * 这里跑的就是浏览器里那份 web/mdz_p2p.js，只是把 RTCPeerConnection 注入成
 * node-datachannel 的实现。覆盖：
 *   1) 模式A 完整握手：Offer串 -> Answer串 -> 双方通道打开
 *   2) 数据传输：双向、player_state 走无序副通道、大消息分块重组、背压契约
 *   3) 模式B（带 STUN）完整握手
 *   4) Peer 垫片按 lan_bridge.js 的真实调用顺序模拟（最关键的一条）
 *   5) 模式切换 / 取消的状态隔离
 *
 * 运行：node test/mdz_rtc.test.js
 * 看细节日志：set MDZ_VERBOSE=1 && node test/mdz_rtc.test.js
 * ==========================================================================*/
'use strict';
const path = require('path');
const polyfill = require('node-datachannel/polyfill');
const MDZP2P = require(path.join(__dirname, '..', 'web', 'mdz_p2p.js'));

const RTC = {
  RTCPeerConnection: polyfill.RTCPeerConnection,
  RTCSessionDescription: polyfill.RTCSessionDescription,
  RTCIceCandidate: polyfill.RTCIceCandidate
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 每个测试用独立 env，避免垫片的全局会话槽互相干扰
function freshEnv(tag) {
  const env = { console, setTimeout, clearTimeout, Date, Promise, Math, JSON };
  env.MDZ_DEBUG_TAG = tag;
  return env;
}

/** 一步到位：跑完整握手，返回 host/client 两侧会话 */
async function handshake(mode, iceTimeoutMs) {
  const envH = freshEnv('host'), envC = freshEnv('client');
  const h = await MDZP2P.hostBegin({ mode, env: envH, RTC, iceTimeoutMs });
  await MDZP2P.clientBegin({ mode, env: envC, RTC, iceTimeoutMs });
  const ans = await MDZP2P.clientAcceptHost(h.payload);
  await MDZP2P.hostAcceptPeer(ans.payload);
  const hs = MDZP2P.currentHost();
  const cs = MDZP2P.currentClient();
  await hs.waitOpen(20000);
  return { host: h, answer: ans, session: hs, clientSession: cs };
}

(async () => {
  // 默认安静跑（只看断言）；需要看握手细节：set MDZ_VERBOSE=1
  MDZP2P.CFG.DEBUG = process.env.MDZ_VERBOSE === '1';
  console.log('Mini DAYZ WebRTC —— 真实 DataChannel 端到端测试（node-datachannel）');
  console.log('node:', process.version, '| 详细日志:', MDZP2P.CFG.DEBUG ? '开' : '关（MDZ_VERBOSE=1 可打开）');

  /* ---------------------------------------------------- 1. 模式A 完整握手 */
  console.log('\n=== 1. 模式A（无 STUN，局域网候选）握手 ===');
  let r1 = null;
  try {
    r1 = await handshake('qr', 5000);
    ok('房主生成 Offer 串', !!r1.host.payload, r1.host.fit.chars + ' 字符');
    ok('客机生成 Answer 串', !!r1.answer.payload, r1.answer.fit.chars + ' 字符');
    ok('主通道已打开', r1.session.open === true);
    const st = r1.session.stats();
    ok('统计里能看到 ICE 候选', st.iceStats && st.iceStats.total >= 1,
      'total=' + (st.iceStats && st.iceStats.total) + ' lan=' + (st.iceStats && st.iceStats.lan));
    // 副通道比主通道晚一点点打开是正常的，这里等它一下
    for (let i = 0; i < 30 && !(r1.session.chFast && r1.session.chFast.readyState === 'open'); i++) await sleep(100);
    ok('双通道都已建立', st.reliable === 'open' && r1.session.chFast.readyState === 'open',
      'reliable=' + st.reliable + ' fast=' + (r1.session.chFast && r1.session.chFast.readyState));
  } catch (e) {
    fail++; console.log('  FAIL  模式A 握手异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n'));
  }

  /* ------------------------------------------- 2. 双向收发 + 大消息分块 + 分流 */
  if (r1) {
    console.log('\n=== 2. 数据传输 ===');
    const sHost = r1.session;
    const sClient = r1.clientSession;
    const inbox = [];
    sClient.attachDataHandler((obj) => inbox.push(obj));

    sHost.send({ type: 'chat', msg: 'hello-from-host' });
    await sleep(400);
    ok('客机收到普通消息', inbox.some(m => m.type === 'chat' && m.msg === 'hello-from-host'),
      JSON.stringify(inbox[inbox.length - 1] || null).slice(0, 60));

    const hostInbox = [];
    sHost.attachDataHandler((obj) => hostInbox.push(obj));
    sClient.send({ type: 'mp_pong', t: 12345 });
    await sleep(400);
    ok('房主收到反向消息', hostInbox.some(m => m.type === 'mp_pong' && m.t === 12345));

    inbox.length = 0;
    sHost.send({ type: 'mp_ping', t: Date.now() });
    sHost.send({ type: 'player_state', x: 1.5, y: 2.5, anim: 'run_down', seq: 7 });
    for (let i = 0; i < 30 && inbox.length < 2; i++) await sleep(100);
    ok('客机收到 mp_ping', inbox.some(m => m.type === 'mp_ping'));
    ok('客机收到 player_state（走无序副通道）', inbox.some(m => m.type === 'player_state' && m.seq === 7),
      '收到类型：' + inbox.map(m => m.type).join(','));
    ok('副通道处于 open', !!sHost.chFast && sHost.chFast.readyState === 'open');

    const big = { type: 'map_data', blob: 'B'.repeat(60000), tail: '结束😀' };
    inbox.length = 0;
    sHost.send(big);
    for (let i = 0; i < 40 && !inbox.some(m => m.type === 'map_data'); i++) await sleep(100);
    const gotBig = inbox.find(m => m.type === 'map_data');
    ok('大消息分块后完整重组', !!gotBig && gotBig.blob.length === 60000 && gotBig.tail === '结束😀',
      gotBig ? (gotBig.blob.length + ' 字符, tail=' + gotBig.tail) : '未收到');

    ok('conn.bufferSize 是数字（mp_join 背压契约）', typeof sHost.bufferSize() === 'number', 'bufferSize=' + sHost.bufferSize());
    ok('收发计数正常', sHost.stats().tx.txMsgs > 0 && sClient.stats().tx.rxMsgs > 0,
      'hostTx=' + sHost.stats().tx.txMsgs + ' clientRx=' + sClient.stats().tx.rxMsgs + ' chunks=' + sHost.stats().tx.chunks);
  }

  /* ------------------------------------------------ 3. 模式B（STUN）握手 */
  console.log('\n=== 3. 模式B（带 STUN，文本 SDP）握手 ===');
  MDZP2P._reset();
  try {
    const r3 = await handshake('text', 6000);
    ok('模式B 主通道已打开', r3.session.open === true);
    const st = r3.session.stats();
    console.log('      候选：total=' + st.iceStats.total + ' host=' + st.iceStats.lan +
      ' srflx=' + st.iceStats.srflx + ' relay=' + st.iceStats.relay);
    ok('模式B 在没有 srflx 时也能连通（同机测试正常）', r3.session.open === true, 'srflx=' + st.iceStats.srflx);
    r3.session.close();
    r3.clientSession.close();
  } catch (e) {
    fail++; console.log('  FAIL  模式B 握手异常: ' + e.message);
  }

  /* ------------------------- 4. 模拟 lan_bridge.js 的真实调用顺序（垫片契约） */
  console.log('\n=== 4. Peer 垫片：完全模仿 lan_bridge.js 的调用顺序 ===');
  MDZP2P._reset();
  const envHost = freshEnv('host'); MDZP2P.install(envHost);
  const envClient = freshEnv('client'); MDZP2P.install(envClient);

  try {
    // —— 房主侧 ——
    // 我们的 UI：先建会话拿到 Offer 串
    const h = await MDZP2P.hostBegin({ mode: 'qr', env: envHost, RTC, iceTimeoutMs: 5000 });
    // lan_bridge：window.startHost(room) -> new Peer(room, {host,port,path,secure,debug})
    const hostPeer = new envHost.Peer('room-1', { host: 'x', port: 9000, path: '/myapp', secure: false, debug: 1 });
    let hostPeerOpen = false, hostConn = null;
    hostPeer.on('open', () => { hostPeerOpen = true; });
    hostPeer.on('connection', (conn) => { hostConn = conn; });
    await sleep(50);
    ok('房主 new Peer(id) 触发 open', hostPeerOpen === true, 'id=' + hostPeer.id);

    // —— 客机侧 ——
    // 我们的 UI：解析房主 Offer 生成 Answer 串
    await MDZP2P.clientBegin({ mode: 'qr', env: envClient, RTC, iceTimeoutMs: 5000 });
    const ans = await MDZP2P.clientAcceptHost(h.payload);
    // lan_bridge：window.joinGame(room) -> new Peer({...}) -> on('open') -> connect(room)
    const clientPeer = new envClient.Peer({ host: 'x', port: 9000, path: '/myapp', secure: false, debug: 1 });
    let clientConn = null, clientConnOpen = false;
    clientPeer.on('open', () => {
      clientConn = clientPeer.connect('room-1');     // lan_bridge 原文就是在这里立刻 connect
      clientConn.on('open', () => { clientConnOpen = true; });
    });
    await sleep(80);
    ok('客机 new Peer(opts) 触发 open（Answer 已就绪）', clientConn !== null);

    // 房主扫码/粘贴拿到 Answer
    await MDZP2P.hostAcceptPeer(ans.payload);

    for (let i = 0; i < 150 && !(hostConn && hostConn.open && clientConnOpen); i++) await sleep(100);

    ok('房主收到 connection 事件', !!hostConn);
    ok('房主 conn.open === true', !!(hostConn && hostConn.open === true));
    ok('客机 conn 触发 open', clientConnOpen === true);

    if (hostConn && clientConnOpen) {
      ok('conn.send 是函数', typeof hostConn.send === 'function');
      ok('conn.on 是函数', typeof hostConn.on === 'function');
      ok('conn.close 是函数', typeof hostConn.close === 'function');
      ok('conn.bufferSize 是数字', typeof hostConn.bufferSize === 'number', '=' + hostConn.bufferSize);

      // 模拟 lan_bridge 注入后的真实流量
      const recv = [];
      hostConn.on('data', (m) => recv.push(m));
      const sender = (pkt) => { if (clientConn && clientConn.open) clientConn.send(pkt); };
      sender({ type: 'visual_ready' });
      sender({ type: 'mpj_begin', id: 1, total: 2, len: 18000, fingerprint: null });
      sender({ type: 'mpj_chunk', id: 1, i: 0, s: 'C'.repeat(12000) });   // 游戏自身的 12000 分块
      sender({ type: 'mpj_chunk', id: 1, i: 1, s: 'D'.repeat(6000) });
      sender({ type: 'mpj_end', id: 1, len: 18000, registry: [] });
      for (let i = 0; i < 80 && recv.length < 5; i++) await sleep(100);
      ok('5 个游戏包全部到达', recv.length === 5, '收到 ' + recv.length + ' 个：' + recv.map(m => m.type).join(','));
      ok('顺序正确（可靠有序通道）', recv.map(m => m.type).join(',') === 'visual_ready,mpj_begin,mpj_chunk,mpj_chunk,mpj_end');
      ok('12000 字节分块内容完整', !!recv[2] && recv[2].s.length === 12000);

      hostPeer.destroy();
      await sleep(400);
      ok('destroy() 后 conn.open 变 false', hostConn.open === false);
    }
  } catch (e) {
    fail++; console.log('  FAIL  垫片模拟异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }

  /* ------------------------------------------------------- 5. 状态隔离 */
  console.log('\n=== 5. 模式切换 / 取消的状态隔离 ===');
  MDZP2P._reset();
  const envX = freshEnv('x');
  try {
    await MDZP2P.hostBegin({ mode: 'qr', env: envX, RTC, iceTimeoutMs: 3000 });
    const s1 = MDZP2P.currentHost();
    MDZP2P.cancel();
    ok('cancel() 后 currentHost 为空', MDZP2P.currentHost() === null);
    ok('cancel() 已关闭旧 pc', s1.closed === true);

    await MDZP2P.hostBegin({ mode: 'text', env: envX, RTC, iceTimeoutMs: 3000 });
    const s2 = MDZP2P.currentHost();
    ok('切换模式后拿到全新会话', s2 !== s1 && s2.mode === 'text');
    ok('新会话未关闭', s2.closed === false);
    MDZP2P.cancel();
  } catch (e) {
    fail++; console.log('  FAIL  状态隔离异常: ' + e.message);
  }

  /* --------------------------------- 6. 容错：漏调 clientBegin 也要能用（回归） */
  console.log('\n=== 6. 容错：没调 clientBegin 直接 clientAcceptHost ===');
  MDZP2P._reset();
  try {
    const envH2 = freshEnv('h2');
    const h = await MDZP2P.hostBegin({ mode: 'qr', env: envH2, RTC, iceTimeoutMs: 5000 });
    // 故意跳过 MDZP2P.clientBegin()：自测页曾经就是这么写的，直接报"没有等待握手的客机会话"
    const ans = await MDZP2P.clientAcceptHost(h.payload);
    ok('自动补建客机会话并生成 Answer', !!ans.payload, ans.fit.chars + ' 字符');
    await MDZP2P.hostAcceptPeer(ans.payload);
    ok('补建之后依然能连通', MDZP2P.currentClient().open === true);
  } catch (e) {
    fail++; console.log('  FAIL  容错路径异常: ' + e.message);
  }

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 400);
})().catch((e) => {
  console.log('FAIL: 未预期异常 ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
