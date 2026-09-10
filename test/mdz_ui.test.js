/* ============================================================================
 * mdz_ui.test.js —— 两个"浏览器"互连的 UI 全流程测试（jsdom + node-datachannel）
 * ----------------------------------------------------------------------------
 * 这里模拟两台设备：各起一个 jsdom window，按 index.html 的顺序加载
 *   pako -> qrcode -> mdz_core -> mdz_p2p -> (MDZP2P.install) -> [lan_bridge 替身] -> mdz_ui
 * 其中 lan_bridge 替身**逐字照抄**真实 lan_bridge.js 的关键调用：
 *   房主：window.startHost(room) -> new Peer(room, opts) -> on('connection') -> conn.on('open')
 *   客机：window.joinGame(room)  -> new Peer(opts)      -> on('open') -> connect(room) -> conn.on('open')
 * 然后通过 UI 按钮走完"文本 SDP"流程（粘贴交换），最后验证游戏包真的互通。
 *
 * 运行：node test/mdz_ui.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const polyfill = require('node-datachannel/polyfill');

const WEB = path.join(__dirname, '..', 'web');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

/** 造一个"设备"：jsdom + 按 index.html 顺序加载联机相关脚本 + lan_bridge 替身 */
function makeDevice(name) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="c2canvasdiv"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:8765/index.html'
  });
  const w = dom.window;
  w.isSecureContext = false;                 // 让 UI 默认走文本模式（jsdom 无摄像头）
  w.RTCPeerConnection = polyfill.RTCPeerConnection;
  w.RTCSessionDescription = polyfill.RTCSessionDescription;
  w.RTCIceCandidate = polyfill.RTCIceCandidate;
  w.QRCode = { toCanvas: (c, t, o, cb) => cb && cb(null) };   // jsdom 没有 canvas 2d

  const load = (rel) => w.eval(fs.readFileSync(path.join(WEB, rel), 'utf8'));
  load('vendor/pako.min.js');
  load('mdz_core.js');
  load('mdz_p2p.js');
  w.eval('MDZP2P.install(window);');

  // ---- lan_bridge.js 替身：调用序列与真实文件一致（含 conn.bufferSize 读取）----
  const rec = { startHostCalls: [], joinGameCalls: [], packets: [], errors: [], peer: null, conn: null, connOpen: false };
  w.eval(`
    window.__rec = { packets: [] };
    window.startHost = function (room) {
      if (typeof Peer === 'undefined') return;
      room = String(room).trim(); if (!room) return;
      window.__rec.role = 'host'; window.__rec.room = room;
      var peer = new Peer(room, { host: location.hostname || 'localhost', port: 9000, path: '/myapp', secure: false, debug: 1 });
      window.__rec.peer = peer;
      peer.on('open', function () { window.__rec.peerOpen = true; });
      peer.on('connection', function (conn) {
        window.__rec.conn = conn;
        conn.on('open', function () {
          window.__rec.connOpen = true;
          conn.on('data', function (m) { window.__rec.packets.push(m); });
        });
      });
      return peer;
    };
    window.joinGame = function (room) {
      if (typeof Peer === 'undefined') return;
      room = String(room).trim(); if (!room) return;
      window.__rec.role = 'client'; window.__rec.room = room;
      var peer = new Peer({ host: location.hostname || 'localhost', port: 9000, path: '/myapp', secure: false, debug: 1 });
      window.__rec.peer = peer;
      peer.on('open', function () {
        var conn = peer.connect(room);
        window.__rec.conn = conn;
        conn.on('open', function () {
          window.__rec.connOpen = true;
          conn.on('data', function (m) { window.__rec.packets.push(m); });
        });
        conn.on('error', function (e) { window.__rec.errors.push(String(e && e.message || e)); });
      });
      return peer;
    };
    window.leaveRoom = function () { window.__rec.left = true; };
  `);
  load('mdz_ui.js');                          // 面板最后加载（与 index.html 一致）

  return { name, dom, w, rec, doc: w.document };
}

const $ = (d, sel) => d.doc.querySelector(sel);
function byText(d, text) {
  return Array.from(d.doc.querySelectorAll('button')).find(b => b.textContent.indexOf(text) >= 0);
}
function statusText(d) {
  try { return d.w.MDZUI._ui.status.textContent || ''; } catch (e) { return ''; }
}

(async () => {
  console.log('Mini DAYZ WebRTC —— UI 全流程测试（两个 jsdom 实例 + 真实 DataChannel）');

  const host = makeDevice('host');
  const client = makeDevice('client');

  // mdz_ui.js 在 document 还是 loading 时会等 DOMContentLoaded 再建面板，这里等它就绪
  await until(() => byText(host, '房主：创建房间') && byText(client, '房主：创建房间'), 8000);
  await until(() => host.doc.querySelectorAll('textarea').length >= 2 &&
                    client.doc.querySelectorAll('textarea').length >= 2, 8000);

  console.log('\n=== 1. 面板初始化 ===');
  ok('房主设备：面板已注入（找到操作按钮）', !!byText(host, '房主：创建房间'));
  ok('客机设备：面板已注入', !!byText(client, '客机：加入房间'));
  ok('房主设备：window.Peer 已被垫片接管', host.w.eval('typeof Peer === "function"') === true);
  ok('客机设备：window.Peer 已被垫片接管', client.w.eval('typeof Peer === "function"') === true);
  ok('window.MDZP2P 已挂载', host.w.eval('typeof MDZP2P === "object"'));

  console.log('\n=== 2. 切到"异地文本 SDP"模式 ===');
  host.w.MDZUI.switchMode('text');
  client.w.MDZUI.switchMode('text');
  ok('房主模式 = text', host.w.MDZP2P.getMode() === 'text', host.w.MDZP2P.getMode());
  ok('客机模式 = text', client.w.MDZP2P.getMode() === 'text');
  const hostRoom = host.doc.querySelector('input[placeholder*="房间名"]');
  const clientRoom = client.doc.querySelector('input[placeholder*="房间名"]');
  hostRoom.value = 'room-test'; clientRoom.value = 'room-test';
  ok('房间名输入框存在且已填', hostRoom.value === 'room-test' && clientRoom.value === 'room-test');
  ok('文本模式下面板显示 SDP 文本框', host.doc.querySelectorAll('textarea').length >= 2 &&
    host.doc.querySelectorAll('textarea')[0].style.display !== 'none',
    'textarea 数量=' + host.doc.querySelectorAll('textarea').length);

  console.log('\n=== 3. 房主点"创建房间" ===');
  byText(host, '房主：创建房间').click();
  const gotOffer = await until(() => {
    const ta = host.doc.querySelectorAll('textarea')[0];
    return ta && ta.value && ta.value.indexOf('MDZ1.') === 0;
  });
  ok('Offer 文本框已填充', gotOffer, (host.doc.querySelectorAll('textarea')[0].value || '').slice(0, 24) + '…');
  ok('已调用 window.startHost（游戏原逻辑接管）', host.w.eval('!!window.__rec.role') && host.w.eval('window.__rec.role') === 'host');
  await until(() => host.w.eval('!!window.__rec.peerOpen'));
  ok('房主 Peer 触发 open 且已注册 connection 监听', host.w.eval('!!window.__rec.peerOpen') === true);

  console.log('\n=== 4. 客机点"加入房间"，再粘贴 Offer 并点"生成 Answer" ===');
  byText(client, '客机：加入房间').click();     // 按面板上的编号流程走
  await until(() => !!client.w.MDZP2P.currentClient());
  ok('客机会话已就绪（等房主握手串）', !!client.w.MDZP2P.currentClient());
  const offerText = host.doc.querySelectorAll('textarea')[0].value;
  client.doc.querySelectorAll('textarea')[0].value = offerText;
  byText(client, '客机：生成 Answer').click();
  const gotAnswer = await until(() => {
    const ta = client.doc.querySelectorAll('textarea')[1];
    return ta && ta.value && ta.value.indexOf('MDZ1.') === 0;
  });
  ok('Answer 文本框已填充', gotAnswer, (client.doc.querySelectorAll('textarea')[1].value || '').slice(0, 24) + '…');
  const joinCalled = await until(() => client.w.eval('!!window.__rec.role'));
  ok('已调用 window.joinGame（游戏原逻辑接管）', joinCalled && client.w.eval('window.__rec.role') === 'client');
  ok('客机 peer.connect() 已返回 conn', await until(() => client.w.eval('!!window.__rec.conn')));

  console.log('\n=== 5. 房主粘贴 Answer 并点"确认 Answer 建立连接" ===');
  host.doc.querySelectorAll('textarea')[1].value = client.doc.querySelectorAll('textarea')[1].value;
  byText(host, '房主：确认 Answer 建立连接').click();
  const hostConnected = await until(() => host.w.eval('!!window.__rec.connOpen'));
  const clientConnected = await until(() => client.w.eval('!!window.__rec.connOpen'));
  ok('房主 conn 打开（lan_bridge 替身收到 conn.on("open")）', hostConnected);
  ok('客机 conn 打开', clientConnected);
  await until(() => statusText(host).indexOf('已连接') >= 0, 5000);
  ok('房主面板显示"已连接"', statusText(host).indexOf('已连接') >= 0, statusText(host).slice(0, 40));
  ok('客机面板显示"已连接"', statusText(client).indexOf('已连接') >= 0, statusText(client).slice(0, 40));

  console.log('\n=== 6. 游戏包真的互通（走垫片注入的 conn.send） ===');
  host.w.eval('window.__rec.conn.send({type:"visual_ready"})');
  host.w.eval('window.__rec.conn.send({type:"mpj_chunk", id:1, i:0, s:"Y".repeat(12000)})');
  client.w.eval('window.__rec.conn.send({type:"player_state", x:3, seq:42})');
  await until(() => client.w.eval('window.__rec.packets.length') >= 2 && host.w.eval('window.__rec.packets.length') >= 1, 8000);
  const cp = client.w.eval('JSON.stringify(window.__rec.packets.map(function(m){return m.type}))');
  const hp = host.w.eval('JSON.stringify(window.__rec.packets.map(function(m){return m.type}))');
  ok('客机收到房主的两个包', cp === '["visual_ready","mpj_chunk"]', cp);
  ok('房主收到客机的 player_state（无序副通道）', hp === '["player_state"]', hp);
  ok('12000 字节分块内容完整', client.w.eval('window.__rec.packets[1].s.length') === 12000);
  ok('conn.bufferSize 可读（背压契约）', typeof host.w.eval('window.__rec.conn.bufferSize') === 'number');

  console.log('\n=== 7. 取消 / 断开 ===');
  byText(host, '取消 / 断开').click();
  await sleep(500);
  ok('取消后会话已清空', host.w.eval('MDZP2P.currentHost() === null') === true);
  ok('取消后 conn.open 变 false', host.w.eval('window.__rec.conn ? window.__rec.conn.open : false') === false);

  host.dom.window.close(); client.dom.window.close();

  /* ---------------------------------------------------------------------
   * 8. 走"游戏原面板"入口：直接调用 lan_bridge 的 startHost / joinGame
   *    （即用户在游戏里点 HOST / JOIN 按钮），我们这边应该自动亮出面板
   * ------------------------------------------------------------------- */
  console.log('\n=== 8. 游戏原面板入口（HOST/JOIN 按钮）也能拉起我们的面板 ===');
  const host3 = makeDevice('host3');
  const client3 = makeDevice('client3');
  await until(() => byText(host3, '房主：创建房间') && byText(client3, '房主：创建房间'), 8000);
  // 原面板入口走的是 CFG 默认 ICE 超时（模式B 会等 STUN，最多 12s），测试里缩短以免抖动
  host3.w.eval('MDZP2P.CFG.ICE_TIMEOUT_TEXT = 3000');
  client3.w.eval('MDZP2P.CFG.ICE_TIMEOUT_TEXT = 3000');

  // 模拟"收起面板"后点原面板按钮
  host3.w.MDZUI._ui.panel.style.display = 'none';
  host3.w.MDZUI._ui.toggleBtn.style.display = '';
  host3.w.eval("window.startHost('legacy-room')");           // 游戏原面板 HOST 按钮做的就是这件事
  const offerFilled = await until(() => {
    const ta = host3.doc.querySelectorAll('textarea')[0];
    return ta && ta.value.indexOf('MDZ1.') === 0;
  }, 25000);
  ok('点原面板 HOST 后自动生成了 Offer 握手串', offerFilled,
    (host3.doc.querySelectorAll('textarea')[0].value || '').slice(0, 20) + '…');
  // 面板展开与握手串就绪是同一段代码做的，所以在拿到握手串之后再断言
  ok('点原面板 HOST 后我们的面板自动展开（收起状态被解除）',
    host3.w.MDZUI._ui.panel.style.display !== 'none',
    'panel.display=' + JSON.stringify(host3.w.MDZUI._ui.panel.style.display));
  ok('小按钮重新隐藏', host3.w.MDZUI._ui.toggleBtn.style.display === 'none');
  ok('已创建房主会话', host3.w.eval('!!MDZP2P.currentHost()') === true);

  // 客机：直接调 window.joinGame（等价于点原面板 JOIN）
  client3.w.eval("window.joinGame('legacy-room')");
  const needsPayload = await until(() => client3.w.eval('!!MDZP2P.currentClient()'), 8000);
  ok('点原面板 JOIN 后自动创建客机会话', needsPayload);
  const hintShown = await until(() => statusText(client3).length > 0, 5000);
  ok('客机面板给出"等房主握手串"的引导', hintShown, statusText(client3).slice(0, 46));

  host3.dom.window.close(); client3.dom.window.close();

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL: 未预期异常 ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
