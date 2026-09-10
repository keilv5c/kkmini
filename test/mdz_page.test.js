/* ============================================================================
 * mdz_page.test.js —— 按 index.html 的真实脚本顺序做页面集成检查
 * ----------------------------------------------------------------------------
 * 目的：确认"磁盘上的 index.html 装出来的页面"确实会出现联机面板，
 *       而不是像被 Service Worker 缓存住的旧页面那样——什么都没有。
 *
 * 做法：解析 index.html 的 <script src> 顺序，在 jsdom 里逐个执行；
 *       跳过 c2runtime.js（它需要完整的 Construct 2 运行时环境，jsdom 跑不起来），
 *       但正因为跳过它，才能单独验证"我们的脚本 + lan_bridge + mp_*"这条链。
 *
 * 运行：node test/mdz_page.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const polyfill = require('node-datachannel/polyfill');

const WEB = path.join(__dirname, '..', 'web');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const srcs = [];
const reSrc = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g;
let m;
while ((m = reSrc.exec(html))) srcs.push(m[1]);

const inlines = [];
const stripped = html
  .replace(reSrc, '')
  .replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (mm, code) => { inlines.push(code); return ''; });

console.log('Mini DAYZ WebRTC —— index.html 页面集成检查');
console.log('发现 ' + srcs.length + ' 个外部脚本、' + inlines.length + ' 段内联脚本');

// 本测试刻意不加载 c2runtime.js，页面里那句 cr_createRuntime 会抛错；
// 用 VirtualConsole 把它吞掉，保持输出干净、退出码明确。
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(stripped, {
  runScripts: 'outside-only', pretendToBeVisual: true,
  url: 'http://localhost:8765/index.html', virtualConsole: vc
});
const w = dom.window;
const errors = [];
w.RTCPeerConnection = polyfill.RTCPeerConnection;
w.RTCSessionDescription = polyfill.RTCSessionDescription;
w.RTCIceCandidate = polyfill.RTCIceCandidate;
w.QRCode = { toCanvas: (c, t, o, cb) => cb && cb(null) };
w.console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
w.console.warn = function () {};

const skipped = [];
const loadStatus = [];
for (const src of srcs) {
  if (src === 'c2runtime.js') { skipped.push(src); continue; }
  const p = path.join(WEB, src);
  if (!fs.existsSync(p)) { loadStatus.push([src, '文件不存在']); continue; }
  try {
    w.eval(fs.readFileSync(p, 'utf8'));
    loadStatus.push([src, 'OK']);
  } catch (e) {
    loadStatus.push([src, '抛错: ' + e.message]);
  }
}
for (const code of inlines) { try { w.eval(code); } catch (e) { loadStatus.push(['<inline>', '抛错: ' + e.message]); } }

console.log('\n脚本加载情况：');
for (const [f, s] of loadStatus) console.log('  ' + (s === 'OK' ? 'OK  ' : '!!  ') + f.padEnd(26) + s);
if (skipped.length) console.log('  --  ' + skipped.join(', ') + '（需要 C2 运行时，已跳过）');

(async () => {
  console.log('\n=== 1. 关键全局对象 ===');
  ok('window.MdzCore 已就绪', typeof w.MdzCore === 'object');
  ok('window.MDZP2P 已就绪', typeof w.MDZP2P === 'object');
  ok('window.Peer 已被我们的垫片接管（不再需要 PeerJS）',
    typeof w.Peer === 'function' && w.Peer === w.MDZP2P.MdzPeer);
  ok('构建标记存在（用来分辨是否被缓存住旧页面）',
    w.MDZ_BUILD === 'mdz-webrtc-web-1', String(w.MDZ_BUILD));
  ok('lan_bridge.js 已加载并暴露游戏入口',
    typeof w.startHost === 'function' && typeof w.joinGame === 'function' && typeof w.leaveRoom === 'function');
  ok('vendor/pako 已就绪', typeof w.pako === 'object' && typeof w.pako.deflateRaw === 'function');
  ok('vendor/qrcode 已就绪', typeof w.QRCode === 'object' && typeof w.QRCode.toCanvas === 'function');

  console.log('\n=== 2. 联机面板是否真的出现在页面上（这就是"扫码图标在哪"的答案）===');
  const appeared = await until(() => !!Array.from(w.document.querySelectorAll('button'))
    .find(b => b.textContent.indexOf('房主：创建房间') >= 0));
  ok('右上角联机面板已注入', appeared);
  const panelBtns = Array.from(w.document.querySelectorAll('button')).map(b => b.textContent);
  ok('面板上有"房主：创建房间"按钮', panelBtns.some(t => t.indexOf('房主：创建房间') >= 0));
  ok('面板上有"客机：加入房间"按钮', panelBtns.some(t => t.indexOf('客机：加入房间') >= 0));
  ok('面板上有"取消 / 断开"按钮', panelBtns.some(t => t.indexOf('取消 / 断开') >= 0));
  ok('面板标题带构建号', w.document.body.textContent.indexOf('mdz-ui-1') >= 0);
  ok('没有出现红色致命错误条', w.document.body.textContent.indexOf('联机面板没能启动') < 0);

  console.log('\n=== 3. 我们的脚本没有在加载期报错 ===');
  const ourErrors = errors.filter(e => /MDZ|mdz_/.test(e));
  ok('没有 [MDZ-*] 级别的错误输出', ourErrors.length === 0, ourErrors.slice(0, 2).join(' | ') || '无');

  console.log('\n=== 4. Service Worker 已被禁用（防止再吃到旧页面）===');
  ok('C2_RegisterSW 已被替换为不注册', /禁用/.test(String(w.C2_RegisterSW)));

  /* ------------------------------------------------------------------
   * 5. 命中测试审计：祖先 pointer-events:none 会"吃掉"子元素的鼠标事件，
   *    而 jsdom 的 .click() 不检查 CSS —— 只能自己沿祖先链审计。
   *    （踩过的坑：收起面板后那个"☰ 联机面板"按钮没写 pointer-events:auto，
   *      于是收起后再也点不开。）
   * ---------------------------------------------------------------- */
  console.log('\n=== 5. 可点击性审计（pointer-events 继承）===');
  const audit = [];
  const interactive = Array.from(w.document.querySelectorAll('button,input,textarea,canvas,select,a'));
  for (const el of interactive) {
    let node = el, auto = false, sawNone = false;
    while (node && node.style) {
      const pe = node.style.pointerEvents;
      if (pe === 'auto') { auto = true; break; }
      if (pe === 'none') sawNone = true;
      node = node.parentElement;
    }
    if (sawNone && !auto) audit.push(el.tagName + ' 「' + (el.textContent || el.placeholder || '').slice(0, 14) + '」');
  }
  ok('面板里没有任何"被 pointer-events:none 吃掉"的可点元素', audit.length === 0, audit.join(' | ') || '无');

  const toggleBtn = Array.from(w.document.querySelectorAll('button')).find(b => b.textContent.indexOf('联机面板') >= 0);
  ok('收起按钮存在（右上角小按钮）', !!toggleBtn);
  ok('收起按钮自身声明了 pointer-events:auto', !!toggleBtn && /pointer-events:\s*auto/.test(toggleBtn.getAttribute('style') || ''));

  console.log('\n=== 6. 收起 → 再打开 ===');
  const collapseBtn = Array.from(w.document.querySelectorAll('button')).find(b => b.textContent === '收起');
  ok('面板上有"收起"按钮', !!collapseBtn);
  collapseBtn.click();
  ok('点击收起后面板隐藏、小按钮出现',
    w.MDZUI._ui.panel.style.display === 'none' && w.MDZUI._ui.toggleBtn.style.display !== 'none',
    'panel=' + w.MDZUI._ui.panel.style.display + ' toggle=' + w.MDZUI._ui.toggleBtn.style.display);
  toggleBtn.click();
  ok('点击小按钮后面板重新出现、小按钮隐藏',
    w.MDZUI._ui.panel.style.display !== 'none' && w.MDZUI._ui.toggleBtn.style.display === 'none',
    'panel=' + w.MDZUI._ui.panel.style.display + ' toggle=' + w.MDZUI._ui.toggleBtn.style.display);
  // 再收再开一次，确认可反复
  collapseBtn.click(); toggleBtn.click();
  ok('可以反复收起/展开', w.MDZUI._ui.panel.style.display !== 'none');

  /* ------------------------------------------------------------------
   * 7. mDNS 兜底：只拿到 mDNS 候选时，UI 必须能真的去申请摄像头权限
   *    （方案 (c) 的"失败引导 b"这一半，之前只写了提示文字、没接按钮）
   * ---------------------------------------------------------------- */
  console.log('\n=== 7. mDNS 兜底："授权摄像头后重出码"按钮 ===');
  ok('默认情况下"②b"按钮是隐藏的', w.MDZUI._ui.btnUnobf.style.display === 'none',
    'display=' + JSON.stringify(w.MDZUI._ui.btnUnobf.style.display));

  w.MDZP2P.emit('payload', {
    role: 'host', payload: 'MDZ1.abcdef.1',
    fit: { chars: 12, bytes: 12, hint: '轻松识别' },
    hint: 'mdns', iceStats: { mdns: 2, lan: 0, total: 2 }
  });
  ok('收到 mDNS 提示后"②b"按钮出现', w.MDZUI._ui.btnUnobf.style.display !== 'none',
    'display=' + JSON.stringify(w.MDZUI._ui.btnUnobf.style.display));

  w.eval('window.__gum = 0;' +
    'navigator.mediaDevices = { getUserMedia: function () { window.__gum++;' +
    ' return Promise.resolve({ getTracks: function () { return [{ stop: function () {} }]; } }); } };');
  try { w.MDZUI._ui.btnUnobf.click(); } catch (e) { /* jsdom 里 startHost 可能抛错，不影响本断言 */ }
  const gumCalled = await until(() => w.eval('window.__gum') > 0, 20000);
  ok('点击后确实申请了摄像头权限（用于取消 mDNS 混淆）', gumCalled === true,
    'getUserMedia 调用次数=' + w.eval('window.__gum'));
  // 重新生成是异步的，等它结束再看按钮是否恢复可点
  const reEnabled = await until(() => w.MDZUI._ui.btnUnobf.disabled === false, 25000);
  ok('重新生成结束后按钮恢复可点（失败可重试）', reEnabled === true);

  /* ------------------------------------------------------------------
   * 8. 面板可拖动 / 位置记忆（挡住游戏角落按钮时能拖开）
   * ---------------------------------------------------------------- */
  console.log('\n=== 8. 面板拖动 / 位置记忆 ===');
  const head = w.MDZUI._ui.panel.firstChild;
  ok('标题栏被标记为可拖动（cursor:move）', head.style.cursor === 'move', 'cursor=' + JSON.stringify(head.style.cursor));

  const md = (type, x, y, el) => (el || w.document).dispatchEvent(
    new w.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));

  md('mousedown', 100, 50, head);
  md('mousemove', 220, 110, w.document);
  md('mouseup', 220, 110, w.document);
  const pv = w.MDZUI._ui.panel;
  ok('拖动后改用 left/top 定位', pv.style.right === 'auto' && parseFloat(pv.style.left) > 0,
    'left=' + pv.style.left + ' top=' + pv.style.top + ' right=' + pv.style.right);
  ok('位置写入 localStorage（下次打开还在原处）', !!w.localStorage.getItem('mdz.ui.pos.v1'),
    String(w.localStorage.getItem('mdz.ui.pos.v1')));

  // 拖动后 400ms 内会屏蔽一次 click（防止误触发展开/收起），等它过期再验证点击仍然有效
  await sleep(450);
  const collapse2 = Array.from(w.document.querySelectorAll('button')).find(b => b.textContent === '收起');
  collapse2.click();
  ok('拖动之后点击收起仍然有效（拖动不吞掉点击）', w.MDZUI._ui.panel.style.display === 'none');
  ok('收起后小按钮沿用同一位置（不会跳回右上角）', w.MDZUI._ui.toggleBtn.style.right === 'auto',
    'left=' + w.MDZUI._ui.toggleBtn.style.left + ' right=' + w.MDZUI._ui.toggleBtn.style.right);

  // 小按钮也能拖
  const tg = w.MDZUI._ui.toggleBtn;
  md('mousedown', 300, 30, tg);
  md('mousemove', 360, 90, w.document);
  md('mouseup', 360, 90, w.document);
  ok('收起状态的小按钮也能拖动', parseFloat(tg.style.left) > 0, 'left=' + tg.style.left + ' top=' + tg.style.top);

  const resetBtn = Array.from(w.document.querySelectorAll('button')).find(b => b.textContent.indexOf('重置面板位置') >= 0);
  ok('面板底部有「重置面板位置」按钮', !!resetBtn);
  await sleep(450);
  resetBtn.click();
  ok('重置后面板回到右上角', w.MDZUI._ui.panel.style.right === '12px' && w.MDZUI._ui.panel.style.left === 'auto',
    'left=' + w.MDZUI._ui.panel.style.left + ' right=' + w.MDZUI._ui.panel.style.right);
  ok('重置后 localStorage 已清空', !w.localStorage.getItem('mdz.ui.pos.v1'));

  w.close();
  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL: 未预期异常 ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
