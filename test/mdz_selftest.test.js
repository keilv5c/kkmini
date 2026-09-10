/* ============================================================================
 * mdz_selftest.test.js —— 直接测"自测页"本身（回归测试）
 * ----------------------------------------------------------------------------
 * 起因：mdz_selftest.html 曾经漏掉 clientBegin 就调用 clientAcceptHost，
 *       浏览器里点"运行自测"直接 FAIL（"当前没有等待握手的客机会话"）。
 *       这个测试把页面按真实顺序加载进 jsdom，点按钮、读页面上的 PASS/FAIL，
 *       保证以后不会再出现"页面自己跑不通"的情况。
 *
 * 运行：node test/mdz_selftest.test.js
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
async function until(fn, ms = 30000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

/** 把自测页按 index/selftest 里的真实顺序装进 jsdom */
function bootPage() {
  const html = fs.readFileSync(path.join(WEB, 'mdz_selftest.html'), 'utf8');

  // 收集并摘掉所有内联脚本，改由我们控制执行时机（外部脚本在 jsdom 里也取不到）
  const inline = [];
  const stripped = html
    .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
    .replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (m, code) => { inline.push(code); return ''; });

  const dom = new JSDOM(stripped, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'http://localhost:8765/mdz_selftest.html'
  });
  const w = dom.window;
  w.RTCPeerConnection = polyfill.RTCPeerConnection;
  w.RTCSessionDescription = polyfill.RTCSessionDescription;
  w.RTCIceCandidate = polyfill.RTCIceCandidate;
  // jsdom 没有 canvas 2d：二维码渲染打桩，只验证"调用了且没报错"
  w.QRCode = { toCanvas: (c, t, o, cb) => { w.__qrRendered = (w.__qrRendered || 0) + 1; cb && cb(null); } };

  w.eval(fs.readFileSync(path.join(WEB, 'vendor', 'pako.min.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(WEB, 'mdz_core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(WEB, 'mdz_p2p.js'), 'utf8'));
  for (const code of inline) w.eval(code);     // MDZP2P.install(window) 与页面逻辑

  return { dom, w, doc: w.document };
}

function logText(doc) { return doc.getElementById('log').textContent || ''; }
function resultLine(doc) {
  const m = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(logText(doc));
  return m ? { pass: +m[1], fail: +m[2] } : null;
}

(async () => {
  console.log('Mini DAYZ WebRTC —— 自测页回归测试（jsdom 加载 mdz_selftest.html 并点按钮）');

  /* ------------------------------------------------ 模式A（扫码流程） */
  console.log('\n=== 1. 页面加载 & 模式A 自测 ===');
  const page = bootPage();
  ok('页面脚本已就绪（window.Peer 垫片已安装）', page.w.eval('typeof Peer === "function"') === true);
  ok('内联脚本执行完毕（自测按钮已绑定）', typeof page.doc.getElementById('run').onclick === 'function');

  page.doc.getElementById('run').click();
  const doneA = await until(() => { const r = resultLine(page.doc); return r && (r.pass + r.fail) > 0; }, 45000);
  const rA = resultLine(page.doc);
  ok('模式A 自测跑出了结果', doneA && !!rA, rA ? (rA.pass + ' 通过 / ' + rA.fail + ' 失败') : '超时');
  ok('模式A 自测 0 失败', !!rA && rA.fail === 0);
  ok('模式A 自测通过项 >= 8', !!rA && rA.pass >= 8, rA ? String(rA.pass) : '-');
  const tA = logText(page.doc);
  ok('没有"当前没有等待握手的客机会话"这类错误', tA.indexOf('没有等待握手') < 0);
  ok('页面里模拟的 lan_bridge 调用顺序全部 PASS', tA.indexOf('客机 new Peer(opts) -> connect() 拿到 conn') >= 0 &&
    tA.indexOf('4 个游戏包按序到达') >= 0);
  // 逐条检查页面上有没有 FAIL 行
  const failLinesA = tA.split('\n').filter(l => l.indexOf('FAIL') >= 0);
  ok('页面上没有任何 FAIL 行', failLinesA.length === 0, failLinesA.slice(0, 3).join(' | ') || '无');

  /* ------------------------------------------------ 模式B（文本流程） */
  console.log('\n=== 2. 模式B 自测 ===');
  page.doc.getElementById('runB').click();
  const doneB = await until(() => {
    const r = resultLine(page.doc);
    return r && r.fail === 0 && logText(page.doc).indexOf('模式B') >= 0 && (r.pass + r.fail) > 0;
  }, 45000);
  const rB = resultLine(page.doc);
  ok('模式B 自测跑出了结果', doneB && !!rB, rB ? (rB.pass + ' 通过 / ' + rB.fail + ' 失败') : '超时');
  ok('模式B 自测 0 失败', !!rB && rB.fail === 0);
  const failLinesB = logText(page.doc).split('\n').filter(l => l.indexOf('FAIL') >= 0);
  ok('模式B 页面上也没有 FAIL 行', failLinesB.length === 0, failLinesB.slice(0, 3).join(' | ') || '无');

  /* ------------------------------------------------ 二维码按钮 */
  console.log('\n=== 3. "生成一张真二维码"按钮 ===');
  page.doc.getElementById('qrBtn').click();
  const okQr = await until(() => (page.w.__qrRendered || 0) > 0, 15000);
  ok('二维码渲染被调用（真实浏览器里由 qrcode.min.js 绘制）', okQr === true);
  ok('二维码信息行已填充', (page.doc.getElementById('qrinfo').textContent || '').length > 0,
    page.doc.getElementById('qrinfo').textContent);

  page.dom.window.close();
  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL: 未预期异常 ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
