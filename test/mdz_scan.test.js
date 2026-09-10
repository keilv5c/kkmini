/* ============================================================================
 * mdz_scan.test.js —— App 内扫码链路回归测试
 * ----------------------------------------------------------------------------
 * 历史上踩过的坑（都由这个测试守住）：
 *   坑1：调了 Google Code Scanner 的 scan()（需要 GMS 下载模块），真机上报
 *        "The Google Barcode Scanner Module is not available"，然后代码直接掉进模式B。
 *   坑2：WebView 扫码开着 useBarCodeDetectorIfSupported，安卓 WebView 里
 *        BarcodeDetector 缺模块时**静默失败**——一帧都不回调，用户看到的就是
 *        "二维码放框里完全没反应"。
 *
 * 现在的约定：
 *   - App 内**优先原生 startScan**（捆绑 MLKit 模型，离线，密集二维码识别率最高）
 *   - 失败才退到 WebView（html5-qrcode，BarcodeDetector 默认关闭）+ 多档摄像头约束
 *   - 两条都失败才切文本模式，并把失败原因留在状态行
 *   - 提供「换个扫码方式」手动切换
 *
 * 运行：node test/mdz_scan.test.js
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
async function until(fn, ms = 20000, step = 50) {
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

function boot(fake) {
  const vc = new VirtualConsole(); vc.on('jsdomError', () => {});
  const dom = new JSDOM(stripped, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://localhost/index.html', virtualConsole: vc
  });
  const w = dom.window;
  w.isSecureContext = true;
  w.RTCPeerConnection = polyfill.RTCPeerConnection;
  w.RTCSessionDescription = polyfill.RTCSessionDescription;
  w.RTCIceCandidate = polyfill.RTCIceCandidate;
  w.QRCode = { toCanvas: (c, t, o, cb) => cb && cb(null) };
  Object.defineProperty(w.navigator, 'mediaDevices', {
    value: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: () => Promise.resolve([
        { kind: 'videoinput', deviceId: 'front-id', label: 'camera2 0, facing front' },
        { kind: 'videoinput', deviceId: 'back-id', label: 'camera2 1, facing back' }
      ])
    },
    configurable: true
  });
  w.Capacitor = {
    isNativePlatform: () => true, platform: 'android',
    Plugins: {
      StatusBar: { hide: () => { w.__statusBarHidden = true; return Promise.resolve(); },
                   setOverlaysWebView: () => Promise.resolve() },
      BarcodeScanner: fake.plugin
    }
  };
  // html5-qrcode 假实现：记录约束、提供每帧回调
  w.Html5Qrcode = function (id, opts) {
    this.opts = opts;
    this.start = function (cam, cfg, onOk, onErr) {
      w.__webScanStarted = true; w.__webScanOnOk = onOk; w.__webScanOnErr = onErr;
      w.__webScanCam = cam; w.__webScanCfg = cfg; w.__webScanOpts = opts;
      w.__webScanTries = (w.__webScanTries || 0) + 1;
      if (fake.webStartFailsOn && fake.webStartFailsOn === w.__webScanTries) {
        return Promise.reject(new Error(fake.webStartFailsMsg || 'NotReadableError'));
      }
      return Promise.resolve();
    };
    this.stop = function () { return Promise.resolve(); };
    this.clear = function () {};
  };

  for (const src of srcs) {
    if (src === 'c2runtime.js') continue;
    w.eval(fs.readFileSync(path.join(WEB, src), 'utf8'));
  }
  for (const code of inlines) w.eval(code);
  return { dom, w, doc: w.document };
}

function makeFakePlugin(opts) {
  opts = opts || {};
  const st = { startScanCalls: 0, scanCalls: 0, stopped: 0, listener: null, removeAll: 0 };
  const plugin = {
    scan: function () { st.scanCalls++; return Promise.reject(new Error('不该调用 scan()（需要 GMS 模块）')); },
    startScan: function (o) {
      st.startScanCalls++; st.startOpts = o;
      if (opts.startScanFails) return Promise.reject(new Error(opts.startScanFails));
      return Promise.resolve();
    },
    stopScan: function () { st.stopped++; return Promise.resolve(); },
    removeAllListeners: function () { st.removeAll++; st.listener = null; return Promise.resolve(); },
    addListener: function (evt, cb) { if (evt === 'barcodesScanned') st.listener = cb; return Promise.resolve({ remove() {} }); },
    checkPermissions: function () { return Promise.resolve({ camera: 'granted' }); },
    requestPermissions: function () { return Promise.resolve({ camera: 'granted' }); }
  };
  return { plugin, st };
}

const btn = (d, text) => Array.from(d.doc.querySelectorAll('button')).find(b => b.textContent.indexOf(text) >= 0);

(async () => {
  console.log('Mini DAYZ WebRTC —— App 内扫码链路回归测试');

  /* ------------------------------------------ 1. App 内优先原生 MLKit 扫码 */
  console.log('\n=== 1. App 内优先原生 MLKit（离线捆绑模型）===');
  const f1 = makeFakePlugin();
  const d1 = boot({ plugin: f1.plugin });
  await until(() => !!d1.w.MDZUI && !!d1.w.MDZUI._ui.panel, 8000);

  ok('App 内隐藏了状态栏（全屏）', d1.w.__statusBarHidden === true);
  ok('默认模式是"面对面扫码"', d1.w.MDZUI.state.mode === 'qr', d1.w.MDZUI.state.mode);

  btn(d1, '客机：加入房间').click();
  const natFirst = await until(() => f1.st.startScanCalls > 0, 8000);
  ok('点了客机后**先**走原生 startScan', natFirst, 'startScan=' + f1.st.startScanCalls);
  ok('没有去调需要 GMS 的 scan()', f1.st.scanCalls === 0, 'scan()=' + f1.st.scanCalls);
  ok('此时还没动 WebView 扫码', !d1.w.__webScanStarted);
  ok('模式仍是扫码（没掉进模式B）', d1.w.MDZUI.state.mode === 'qr', d1.w.MDZUI.state.mode);
  ok('扫码方式记为 native', d1.w.MDZUI.state.scanMethod === 'native', String(d1.w.MDZUI.state.scanMethod));

  /* ------------------------------- 2. 原生回调 -> 生成 Answer（闭环） */
  console.log('\n=== 2. 原生扫码识别成功 -> 生成 Answer ===');
  const host1 = await d1.w.MDZP2P.hostBegin({ mode: 'qr', iceTimeoutMs: 1500 });
  f1.st.listener({ barcodes: [{ rawValue: host1.payload }] });
  const ans1 = await until(() => {
    const ta = d1.doc.querySelectorAll('textarea')[1];
    return ta && ta.value.indexOf('MDZ1.') === 0;
  }, 15000);
  ok('识别后自动生成 Answer', ans1, (d1.doc.querySelectorAll('textarea')[1].value || '').slice(0, 16) + '…');
  ok('模式仍是扫码', d1.w.MDZUI.state.mode === 'qr');

  /* ------------------------- 3. 原生失败 -> WebView 接手（不掉进模式B） */
  console.log('\n=== 3. 原生失败（GMS 模块缺失那种）→ WebView 接手 ===');
  const f3 = makeFakePlugin({ startScanFails: 'The Google Barcode Scanner Module is not available.' });
  const d3 = boot({ plugin: f3.plugin });
  await until(() => !!d3.w.MDZUI && !!d3.w.MDZUI._ui.panel, 8000);
  btn(d3, '客机：加入房间').click();
  const webTook = await until(() => d3.w.__webScanStarted === true, 10000);
  ok('原生失败后 WebView 扫码接手', webTook === true);
  ok('仍然没有掉进模式B', d3.w.MDZUI.state.mode === 'qr', d3.w.MDZUI.state.mode);
  ok('扫码方式已切到 web', d3.w.MDZUI.state.scanMethod === 'web', String(d3.w.MDZUI.state.scanMethod));
  ok('BarcodeDetector 默认关闭（防静默失败）', d3.w.__webScanOpts.experimentalFeatures.useBarCodeDetectorIfSupported === false,
    JSON.stringify(d3.w.__webScanOpts.experimentalFeatures));
  ok('按标签选中了后置摄像头', d3.w.__webScanCam.deviceId && d3.w.__webScanCam.deviceId.exact === 'back-id',
    JSON.stringify(d3.w.__webScanCam));
  ok('同时要高分辨率（密集二维码需要）', d3.w.__webScanCam.width && d3.w.__webScanCam.width.ideal >= 1280,
    JSON.stringify(d3.w.__webScanCam.width));
  ok('不再用 qrbox 裁剪画面（全画面扫描更不容易漏）', d3.w.__webScanCfg.qrbox === undefined,
    'cfg=' + JSON.stringify(d3.w.__webScanCfg));
  ok('提供了每帧回调（用于统计帧数做诊断）', typeof d3.w.__webScanOnErr === 'function');
  // 模拟一帧未识别 -> 帧计数应增长
  d3.w.__webScanOnErr(new Error('not found'));
  ok('帧计数会增长（能区分"没画面"和"识别不出"）', d3.w.MDZUI.state.scanFrames > 0,
    'frames=' + d3.w.MDZUI.state.scanFrames);

  const host3 = await d3.w.MDZP2P.hostBegin({ mode: 'qr', iceTimeoutMs: 1500 });
  d3.w.__webScanOnOk(host3.payload);
  const ans3 = await until(() => {
    const ta = d3.doc.querySelectorAll('textarea')[1];
    return ta && ta.value.indexOf('MDZ1.') === 0;
  }, 15000);
  ok('WebView 识别成功也能生成 Answer', ans3);

  /* ---------------------- 4. 摄像头约束降级（前置/精确约束失败时继续试） */
  console.log('\n=== 4. 摄像头约束失败时逐档降级重试 ===');
  const f4 = makeFakePlugin({ startScanFails: '原生不可用' });
  const d4 = boot({ plugin: f4.plugin, webStartFailsOn: 1, webStartFailsMsg: 'OverconstrainedError' });
  await until(() => !!d4.w.MDZUI && !!d4.w.MDZUI._ui.panel, 8000);
  btn(d4, '客机：加入房间').click();
  const retried = await until(() => (d4.w.__webScanTries || 0) >= 2, 10000);
  ok('第一档约束失败后自动换下一档（不会直接放弃）', retried === true, '尝试次数=' + d4.w.__webScanTries);
  ok('换档后仍保持扫码模式', d4.w.MDZUI.state.mode === 'qr');

  /* --------------------------- 5. 都失败才切文本 + 保留原因 */
  console.log('\n=== 5. 两条都失败才切文本模式，且保留失败原因 ===');
  const f5 = makeFakePlugin({ startScanFails: 'The Google Barcode Scanner Module is not available.' });
  const d5 = boot({ plugin: f5.plugin, webStartFailsOn: 99, webStartFailsMsg: '摄像头不可用' });
  // 让所有档约束都失败
  d5.w.__forceAllFail = true;
  await until(() => !!d5.w.MDZUI && !!d5.w.MDZUI._ui.panel, 8000);
  // 直接把 Html5Qrcode.start 改成总是失败
  d5.w.eval('window.Html5Qrcode = function(){ this.start=function(){ return Promise.reject(new Error("摄像头不可用")); }; this.stop=function(){return Promise.resolve();}; this.clear=function(){}; };');
  btn(d5, '客机：加入房间').click();
  const toText = await until(() => d5.w.MDZUI.state.mode === 'text', 15000);
  ok('确实都失败后才切文本模式', toText === true, 'mode=' + d5.w.MDZUI.state.mode);
  ok('状态行保留了失败原因', /扫码|摄像头/.test(d5.w.MDZUI._ui.status.textContent),
    d5.w.MDZUI._ui.status.textContent.slice(0, 46));

  /* ------------------------------------ 6. 手动「换个扫码方式」 */
  console.log('\n=== 6. 「换个扫码方式」按钮 ===');
  const f6 = makeFakePlugin();
  const d6 = boot({ plugin: f6.plugin });
  await until(() => !!d6.w.MDZUI && !!d6.w.MDZUI._ui.panel, 8000);
  ok('按钮默认隐藏', d6.w.MDZUI._ui.btnSwitchScan.style.display === 'none');
  btn(d6, '客机：加入房间').click();
  await until(() => d6.w.MDZUI.state.scanMethod === 'native', 8000);
  btn(d6, '换个扫码方式').click();
  const switched = await until(() => d6.w.__webScanStarted === true, 10000);
  ok('点按钮后从 native 切到 web 扫码', switched === true, 'method=' + d6.w.MDZUI.state.scanMethod);

  d1.dom.window.close(); d3.dom.window.close(); d4.dom.window.close();
  d5.dom.window.close(); d6.dom.window.close();
  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL: 未预期异常 ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
