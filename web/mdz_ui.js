/* ============================================================================
 * mdz_ui.js —— 双模式联机面板（模式A 扫码 / 模式B 文本 SDP）
 * ----------------------------------------------------------------------------
 * 只做界面与流程编排，不碰游戏逻辑：
 *   - 生成握手串/二维码、摄像头扫码、SDP 文本框，都交给 MDZP2P
 *   - 真正的"开始联机"仍然是调用游戏原本的 window.startHost() / window.joinGame()
 *     （这样 lan_bridge.js 与 mp_*.js 一行都不用改）
 *
 * 扫码能力优先级：
 *   1) Capacitor 原生插件 BarcodeScanner（App 内最可靠，WebView 摄像头流不可靠）
 *   2) html5-qrcode（网页 + https/localhost 时才可用）
 *   3) 都没有 -> 提示改用模式B（符合需求文档"权限拒绝自动切模式B"的要求）
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-ui-1';

  /** 面板起不来时也要让用户"看得见"错误，而不是界面上一片空白 */
  function fatal(msg, detail) {
    try {
      console.error('[MDZ-UI] ' + msg, detail || '');
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483600;background:#7a1c1c;' +
        'color:#fff;padding:8px 12px;font:13px/1.6 "Microsoft YaHei",sans-serif;white-space:pre-wrap';
      d.textContent = '【MDZ 联机面板没能启动】' + msg + '　（按 F12 打开控制台看详细报错）';
      (document.body || document.documentElement).appendChild(d);
    } catch (e) { /* 连错误条都插不进去就算了 */ }
  }

  var P = window.MDZP2P;
  var Core = window.MdzCore;
  if (!P) { fatal('window.MDZP2P 不存在 —— mdz_p2p.js 没有加载成功（检查 web/mdz_p2p.js 与 index.html 的引用）'); return; }
  if (!Core) { fatal('window.MdzCore 不存在 —— mdz_core.js 或 vendor/pako.min.js 没有加载成功'); return; }
  console.log('%c[MDZ-UI] ' + BUILD + ' 已加载', 'color:#3fb950;font-weight:bold');

  var Z = 2147483000;
  var ui = {};                 // DOM 缓存
  var state = {
    mode: 'qr',                // qr | text
    role: null,                // host | client
    stage: 'idle',             // idle | offered | answered | connected
    room: '',
    hint: null,                // 'mdns' 表示只拿到 mDNS 候选，需要引导用户授权摄像头
    lastPayload: null,         // 最近一次生成的握手串（收起二维码后可再显示）
    scanMethod: null,          // 'native' | 'web'，App 内默认 native（MLKit 识别率更高）
    scanFrames: 0,             // 已分析帧数（诊断"摄像头有没有出画面"）
    scanWatchdog: null,        // 8 秒未识别的提示定时器
    useBarcodeDetector: false, // 默认关闭：安卓 WebView 里 BarcodeDetector 缺失模块时会静默失败
    scanner: null,             // html5-qrcode 实例
    scanning: false,
    log: []
  };

  /* ------------------------------------------------------------ 能力探测 */

  function isNative() {
    try {
      return !!(window.Capacitor && (window.Capacitor.isNativePlatform
        ? window.Capacitor.isNativePlatform()
        : window.Capacitor.platform && window.Capacitor.platform !== 'web'));
    } catch (e) { return false; }
  }
  function nativeScanner() {
    try {
      var plugins = window.Capacitor && window.Capacitor.Plugins;
      var bs = plugins && (plugins.BarcodeScanner || plugins.CapacitorBarcodeScanner);
      if (!bs) return null;
      // startScan 用捆绑模型（离线可用）；scan 是 Google Code Scanner（需要 GMS 模块）
      return (typeof bs.startScan === 'function' || typeof bs.scan === 'function') ? bs : null;
    } catch (e) { return null; }
  }
  function webScannerAvailable() {
    return typeof window.Html5Qrcode === 'function' && window.isSecureContext !== false;
  }
  // 网页端"有可能"扫码：https 或 localhost 都属于安全上下文
  function webScannerPossible() {
    return window.isSecureContext !== false &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function canScan() { return !!nativeScanner() || webScannerAvailable() || webScannerPossible(); }

  // html5-qrcode 有 367KB，启动时不加载；真正要扫码时才按需注入（App 内用原生插件，根本不需要它）
  var scannerLoading = null;
  function ensureWebScanner() {
    if (webScannerAvailable()) return Promise.resolve(true);
    if (scannerLoading) return scannerLoading;
    scannerLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'vendor/html5-qrcode.min.js';
      s.onload = function () { resolve(webScannerAvailable()); };
      s.onerror = function () { log('vendor/html5-qrcode.min.js 加载失败', '#ff6b6b'); resolve(false); };
      document.head.appendChild(s);
    });
    return scannerLoading;
  }

  /* ---------------------------------------------------------------- 工具 */

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }
  function log(msg, cls) {
    var line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + msg;
    state.log.push({ t: line, c: cls || '#ddd' });
    if (state.log.length > 200) state.log.shift();
    if (ui.logBox) {
      ui.logBox.textContent = state.log.slice(-6).map(function (l) { return l.t; }).join('\n');
      ui.logBox.scrollTop = ui.logBox.scrollHeight;
    }
    if (P.CFG.DEBUG) console.log('[MDZ-UI]', msg);
  }
  function setStatus(msg, color) {
    if (ui.status) { ui.status.textContent = msg; ui.status.style.color = color || '#9fe8ff'; }
    log(msg, color);
  }
  function show(node, on) { if (node) node.style.display = on ? '' : 'none'; }

  /** 展开面板（原面板入口触发握手时，自动把界面亮出来，避免用户"找不到界面"） */
  function expandPanel() {
    if (ui.panel) ui.panel.style.display = '';
    if (ui.toggleBtn) ui.toggleBtn.style.display = 'none';
    mirrorPos(ui.panel);
  }

  /** 收起面板，只留右上角一个小按钮 */
  function collapsePanel() {
    if (ui.panel) ui.panel.style.display = 'none';
    if (ui.toggleBtn) ui.toggleBtn.style.display = '';
    mirrorPos(ui.toggleBtn);
  }

  /* ------------------------------------------------------- 面板拖动 / 悬浮
     游戏自己的按钮有时就在右上角，面板挡住时用户没法点。所以：
       - 面板标题栏可拖
       - 收起后的「☰ 联机面板」小按钮也可拖
       - 位置记在 localStorage，下次打开还在原处
       - 底部有「重置面板位置」一键复位                                      */
  var POS_KEY = 'mdz.ui.pos.v1';
  var uiPos = null;

  function loadPos() {
    try { var s = localStorage.getItem(POS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function savePos() {
    try { if (uiPos) localStorage.setItem(POS_KEY, JSON.stringify(uiPos)); } catch (e) {}
  }
  function clampPos(el, x, y) {
    var w = (el && el.offsetWidth) || 340, h = (el && el.offsetHeight) || 240;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600;
    // 允许拖到边缘、甚至大半移出屏幕（游戏按钮常在小角落），但至少留 52px 能抓回来
    x = Math.min(Math.max(x, 52 - w), vw - 52);
    y = Math.min(Math.max(y, 0), Math.max(0, vh - 40));
    return { x: x, y: y };
  }
  function applyPos(el, x, y) {
    if (!el) return null;
    var p = clampPos(el, x, y);
    el.style.left = Math.round(p.x) + 'px';
    el.style.top = Math.round(p.y) + 'px';
    el.style.right = 'auto';
    return p;
  }
  /** 面板与收起按钮共用同一个位置：source 是"刚刚显示出来/刚被拖动"的那个，
   *  它自己以及另一个还可见的元素都要摆到 uiPos；隐藏的元素不用管。 */
  function mirrorPos(source) {
    if (!uiPos) return;
    [ui.panel, ui.toggleBtn].forEach(function (el) {
      if (!el || el === source) return;
      if (el.style.display === 'none') return;
      applyPos(el, uiPos.x, uiPos.y);
    });
    if (source) applyPos(source, uiPos.x, uiPos.y);
  }
  function resetPos() {
    uiPos = null;
    try { localStorage.removeItem(POS_KEY); } catch (e) {}
    [ui.panel, ui.toggleBtn].forEach(function (el) {
      if (!el) return;
      el.style.left = 'auto'; el.style.top = '12px'; el.style.right = '12px';
    });
    setStatus('面板位置已复位到右上角', '#7bd88f');
  }
  /** 把某个元素变成"可拖动手柄"，拖动目标 target；没拖动则算点击（onTap） */
  function enableDrag(handle, target) {
    if (!handle || !target) return;
    var st = null;
    function pt(e) {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX || 0, y: e.clientY || 0 };
    }
    function move(e) {
      if (!st) return;
      var p = pt(e), dx = p.x - st.x, dy = p.y - st.y;
      if (!st.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) st.moved = true;
      if (!st.moved) return;
      try { if (e.cancelable && e.preventDefault) e.preventDefault(); } catch (_) {}
      var q = applyPos(target, st.left + dx, st.top + dy);
      uiPos = { x: q.x, y: q.y };
      mirrorPos(target);
    }
    function up() {
      if (!st) return;
      var dragged = st.moved; st = null;
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', up, true);
      document.removeEventListener('touchcancel', up, true);
      if (dragged) {
        savePos();
        setStatus('面板已移动：位置会记住，点底部「重置面板位置」可复位', '#9fe8ff');
        // 拖完还会补一个 click，屏蔽掉以免误触发展开/收起
        var blocker = function (ev) { ev.stopPropagation(); ev.preventDefault(); target.removeEventListener('click', blocker, true); };
        target.addEventListener('click', blocker, true);
        setTimeout(function () { target.removeEventListener('click', blocker, true); }, 400);
      }
    }
    function down(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var p = pt(e), r = target.getBoundingClientRect();
      st = { x: p.x, y: p.y, left: r.left, top: r.top, moved: false };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      document.addEventListener('touchmove', move, true);
      document.addEventListener('touchend', up, true);
      document.addEventListener('touchcancel', up, true);
    }
    handle.addEventListener('mousedown', down);
    handle.addEventListener('touchstart', down, { passive: true });
    handle.style.cursor = 'move';
  }

  /* ------------------------------------------------------------ 面板构建 */

  var PANEL_CSS = [
    'position:fixed', 'right:12px', 'top:12px', 'width:340px', 'max-height:92vh', 'overflow:auto',
    'background:rgba(14,18,24,0.94)', 'color:#e8eef5', 'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:10px', 'padding:10px 12px', 'font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif',
    'z-index:' + Z, 'box-shadow:0 6px 24px rgba(0,0,0,0.5)', 'pointer-events:auto'
  ].join(';');
  var BTN_CSS = [
    'background:#1f6feb', 'color:#fff', 'border:0', 'border-radius:6px', 'padding:6px 10px',
    'margin:3px 4px 3px 0', 'cursor:pointer', 'font-size:12.5px'
  ].join(';');
  var BTN2_CSS = BTN_CSS.replace('#1f6feb', '#39424e');
  var INPUT_CSS = [
    'width:100%', 'box-sizing:border-box', 'background:#0b0f14', 'color:#e8eef5',
    'border:1px solid rgba(255,255,255,0.22)', 'border-radius:6px', 'padding:5px 7px',
    'font:12px/1.45 Consolas,monospace', 'margin:3px 0'
  ].join(';');

  function buildPanel() {
    var wrap = el('div', 'position:fixed;inset:0;pointer-events:none;z-index:' + Z + ';');
    wrap.id = 'mdz-panel-wrap';       // 原生扫码时按这个 id 把面板整体隐藏，好让相机预览露出来
    var panel = el('div', PANEL_CSS);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);

    // 标题栏
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px');
    var titleWrap = el('div', 'display:flex;align-items:baseline;min-width:0');
    titleWrap.appendChild(el('b', 'font-size:14px;white-space:nowrap', 'Mini DAYZ 联机'));
    titleWrap.appendChild(el('span', 'font-size:11px;opacity:.55;margin-left:6px;white-space:nowrap', BUILD));
    head.appendChild(titleWrap);
    var collapse = el('button', BTN2_CSS, '收起');
    collapse.onclick = collapsePanel;
    head.appendChild(collapse);
    panel.appendChild(head);

    // 收起后的小按钮。
    // 注意：祖先 wrap 设了 pointer-events:none（避免挡住游戏画布），而 pointer-events 是
    // **继承属性**，所以这个按钮必须自己显式写 pointer-events:auto，否则点了没有任何反应。
    var toggleBtn = el('button', BTN_CSS +
      ';position:fixed;right:12px;top:12px;display:none;pointer-events:auto;' +
      'z-index:' + (Z + 1) + ';box-shadow:0 4px 16px rgba(0,0,0,0.55)', '☰ 联机面板');
    toggleBtn.onclick = expandPanel;
    wrap.appendChild(toggleBtn);
    ui.panel = panel;
    ui.toggleBtn = toggleBtn;

    // 标题栏拖面板、小按钮自己也能拖（挡住游戏角落按钮时移开即可）
    enableDrag(head, panel);
    enableDrag(toggleBtn, toggleBtn);
    uiPos = loadPos();
    if (uiPos) { applyPos(panel, uiPos.x, uiPos.y); applyPos(toggleBtn, uiPos.x, uiPos.y); }
    window.addEventListener('resize', function () {
      if (!uiPos) return;
      var q = applyPos(ui.panel, uiPos.x, uiPos.y);
      if (q) { uiPos = { x: q.x, y: q.y }; mirrorPos(ui.panel); }
    });

    // 模式选择
    var modeRow = el('div', 'margin:6px 0');
    modeRow.appendChild(el('div', 'opacity:.85;margin-bottom:2px', '联机方式'));
    ui.modeQr = el('input'); ui.modeQr.type = 'radio'; ui.modeQr.name = 'mdzMode';
    ui.modeTxt = el('input'); ui.modeTxt.type = 'radio'; ui.modeTxt.name = 'mdzMode';
    var l1 = el('label', 'margin-right:12px;cursor:pointer');
    l1.appendChild(ui.modeQr); l1.appendChild(el('span', '', ' 面对面扫码联机'));
    var l2 = el('label', 'cursor:pointer');
    l2.appendChild(ui.modeTxt); l2.appendChild(el('span', '', ' 异地文本 SDP 联机'));
    modeRow.appendChild(l1); modeRow.appendChild(l2);
    panel.appendChild(modeRow);
    ui.modeQr.checked = true;
    ui.modeQr.onchange = function () { switchMode('qr'); };
    ui.modeTxt.onchange = function () { switchMode('text'); };

    // 房间
    ui.room = el('input', INPUT_CSS);
    ui.room.placeholder = '房间名 / 你的昵称（双方都填一样更好认）';
    ui.room.value = 'mdz-' + Math.random().toString(36).slice(2, 6);
    panel.appendChild(el('div', 'opacity:.85;margin-top:4px', '房间名（同时也是你的昵称）'));
    panel.appendChild(ui.room);

    // 操作按钮
    ui.btns = el('div', 'margin:6px 0');
    ui.btnHost = el('button', BTN_CSS, '① 房主：创建房间');
    ui.btnJoin = el('button', BTN_CSS, '① 客机：加入房间');
    ui.btnScanPeer = el('button', BTN_CSS, '② 房主：扫对方回码');
    ui.btnGenAnswer = el('button', BTN_CSS, '② 客机：生成 Answer');
    ui.btnAcceptAnswer = el('button', BTN_CSS, '③ 房主：确认 Answer 建立连接');
    ui.btnUnobf = el('button', BTN2_CSS, '②b 只拿到 mDNS：授权摄像头后重出码');
    ui.btnSwitchScan = el('button', BTN2_CSS, '换个扫码方式（原生 ⇄ 网页）');
    ui.btnShowQr = el('button', BTN2_CSS, '显示二维码');
    ui.btnCancel = el('button', BTN2_CSS, '取消 / 断开');
    [ui.btnHost, ui.btnJoin, ui.btnScanPeer, ui.btnGenAnswer, ui.btnAcceptAnswer,
     ui.btnUnobf, ui.btnSwitchScan, ui.btnShowQr, ui.btnCancel]
      .forEach(function (b) { ui.btns.appendChild(b); });
    panel.appendChild(ui.btns);

    ui.btnHost.onclick = onHost;
    ui.btnJoin.onclick = onJoin;
    ui.btnScanPeer.onclick = function () { startScan('host-answer'); };
    ui.btnGenAnswer.onclick = onGenAnswer;
    ui.btnAcceptAnswer.onclick = onAcceptAnswer;
    ui.btnUnobf.onclick = onUnobfuscate;
    ui.btnSwitchScan.onclick = function () {
      // 手动切换：原生 MLKit ⇄ WebView(html5-qrcode)
      var next = (state.scanMethod === 'native') ? 'web' : 'native';
      if (next === 'native' && !nativeScanner()) { setStatus('本环境没有原生扫码插件，只能用网页扫码', '#ffcc66'); return; }
      var purpose = (state.role === 'host') ? 'host-answer' : 'client-offer';
      log('手动切换扫码方式：' + state.scanMethod + ' -> ' + next, '#ffcc66');
      state.scanMethod = next;
      startScan(purpose, next);
    };
    ui.btnCancel.onclick = onCancel;
    ui.btnShowQr.onclick = function () {
      if (state.lastPayload) { renderQr(state.lastPayload); setStatus('二维码已重新显示', '#7bd88f'); }
      else setStatus('还没有生成二维码', '#ffcc66');
    };
    show(ui.btnSwitchScan, false);
    show(ui.btnShowQr, false);

    // 状态
    ui.status = el('div', 'min-height:20px;margin:6px 0;font-weight:600', '未开始');
    panel.appendChild(ui.status);

    // 二维码不放在侧边面板里：横屏手机面板只有 ~92vh 高，二维码塞进去会被裁掉，
    // 对端摄像头看到的是"半个码"。改成点按钮时弹全屏居中浮层（见 ensureQrOverlay）。

    // 摄像头预览区（模式A 扫码）
    ui.camBox = el('div', 'margin:6px 0');
    ui.camHolder = el('div', 'width:100%;min-height:180px;background:#000;border-radius:6px;overflow:hidden');
    ui.camHolder.id = 'mdz-camera';
    ui.camBox.appendChild(ui.camHolder);
    show(ui.camBox, false);
    panel.appendChild(ui.camBox);

    // 文本 SDP 区（两种模式下都显示：扫码扫不上时的退路，尤其是电脑摄像头）
    ui.textBox = el('div', 'margin:6px 0');
    ui.textBox.appendChild(el('div', 'opacity:.85;color:#ffcc66',
      '扫不上码？用下面这段文本也行（复制发给对方，让对方粘到对应框里）'));
    ui.textBox.appendChild(el('div', 'opacity:.85;margin-top:4px', '房主 Offer（房主生成 / 客机粘贴到这里）'));
    ui.offer = el('textarea', INPUT_CSS + ';height:64px;resize:vertical');
    ui.offer.placeholder = 'MDZ1.……';
    ui.textBox.appendChild(ui.offer);
    ui.btnCopyOffer = el('button', BTN2_CSS, '复制 Offer');
    ui.btnCopyOffer.onclick = function () { copy(ui.offer.value, 'Offer'); };
    ui.textBox.appendChild(ui.btnCopyOffer);

    ui.textBox.appendChild(el('div', 'opacity:.85;margin-top:4px', '客机 Answer（客机生成 / 房主粘贴到这里）'));
    ui.answer = el('textarea', INPUT_CSS + ';height:64px;resize:vertical');
    ui.answer.placeholder = 'MDZ1.……';
    ui.textBox.appendChild(ui.answer);
    ui.btnCopyAnswer = el('button', BTN2_CSS, '复制 Answer');
    ui.btnCopyAnswer.onclick = function () { copy(ui.answer.value, 'Answer'); };
    ui.textBox.appendChild(ui.btnCopyAnswer);
    show(ui.textBox, false);
    panel.appendChild(ui.textBox);

    // 底部：日志 + 统计
    var foot = el('div', 'margin-top:6px');
    ui.btnStats = el('button', BTN2_CSS, '连接统计');
    ui.btnStats.onclick = function () {
      var s = P.stats();
      console.log('[MDZ-UI] stats =', s);
      setStatus(s ? ('通道 ' + s.reliable + '/' + s.fast + '，ICE ' + s.ice + '，候选 ' +
        (s.iceStats ? s.iceStats.total : 0) + '，收发 ' + s.tx.txMsgs + '/' + s.tx.rxMsgs) : '当前没有会话', '#9fe8ff');
    };
    foot.appendChild(ui.btnStats);
    ui.btnLog = el('button', BTN2_CSS, '清空日志');
    ui.btnLog.onclick = function () { state.log = []; if (ui.logBox) ui.logBox.textContent = ''; };
    foot.appendChild(ui.btnLog);
    ui.btnResetPos = el('button', BTN2_CSS, '重置面板位置');
    ui.btnResetPos.onclick = resetPos;
    foot.appendChild(ui.btnResetPos);
    ui.logBox = el('div', [
      'margin-top:4px', 'background:#080b0f', 'border-radius:6px', 'padding:5px 6px',
      'font:11px/1.45 Consolas,monospace', 'white-space:pre-wrap', 'max-height:96px', 'overflow:auto', 'opacity:.9'
    ].join(';'));
    foot.appendChild(ui.logBox);
    panel.appendChild(foot);

    return panel;
  }

  /* ------------------------------------------------------------ 二维码 / 扫码 */

  /* 二维码用全屏居中的浮层显示：
     侧边面板在横屏手机上只有 ~92vh 高（约 400px），把二维码塞进去必然被裁，
     对端摄像头看到的就是半个码。做成浮层后尺寸可以按 min(宽,高) 算，且不挡按钮。 */
  function ensureQrOverlay() {
    if (ui.qrOverlay) return ui.qrOverlay;
    var ov = el('div', 'position:fixed;inset:0;background:rgba(6,8,10,0.96);display:none;' +
      'flex-direction:column;align-items:center;justify-content:center;z-index:' + (Z + 2) + ';pointer-events:auto;padding:8px');
    ov.id = 'mdz-qr-overlay';
    ui.qrTitle = el('div', 'color:#9fe8ff;font:14px/1.5 "Microsoft YaHei",sans-serif;margin-bottom:6px;text-align:center',
      '让另一台设备扫描这个二维码');
    ov.appendChild(ui.qrTitle);
    ui.qrCanvas = el('canvas', 'background:#fff;border-radius:8px;max-width:96vw;max-height:82vh');
    ov.appendChild(ui.qrCanvas);
    ui.qrHint = el('div', 'color:#c8d6e5;font:12px/1.5 "Microsoft YaHei",sans-serif;margin-top:6px;text-align:center;max-width:94vw', '');
    ov.appendChild(ui.qrHint);
    ui.qrTip = el('div', 'color:#ffcc66;font:12px/1.5 "Microsoft YaHei",sans-serif;margin-top:4px;text-align:center;max-width:94vw',
      '提示：让对方用手机扫最稳；电脑摄像头扫手机屏幕容易失败，电脑建议改用「异地文本 SDP」');
    ov.appendChild(ui.qrTip);
    ui.qrClose = el('button', BTN2_CSS + ';margin-top:8px', '收起二维码（继续游戏）');
    ui.qrClose.onclick = function () {
      show(ui.qrOverlay, false);
      if (ui.btnShowQr) show(ui.btnShowQr, true);
      setStatus('二维码已收起。需要时点「显示二维码」再打开', '#ffcc66');
    };
    ov.appendChild(ui.qrClose);
    // 扫码扫不上时的退路：握手串本来就是文本，直接复制发给对方粘贴即可
    ui.qrCopy = el('button', BTN2_CSS + ';margin-top:6px', '复制握手串（对方扫不上时用文本）');
    ui.qrCopy.onclick = function () { copy(state.lastPayload || '', '握手串'); };
    ov.appendChild(ui.qrCopy);
    document.body.appendChild(ov);
    ui.qrOverlay = ov;
    return ov;
  }

  function renderQr(payload) {
    state.lastPayload = payload;
    var ov = ensureQrOverlay();
    show(ov, true);
    ov.style.display = 'flex';
    if (ui.btnShowQr) show(ui.btnShowQr, false);

    var vw = window.innerWidth || 800, vh = window.innerHeight || 600;
    // 横屏手机高度很小（约 400px）：这时把标题/提示/按钮全部收起来，
    // 只留一个角上的关闭按钮，把整屏高度让给二维码本身。
    var compact = vh < 620;
    show(ui.qrTitle, !compact);
    show(ui.qrHint, !compact);
    show(ui.qrTip, !compact);
    ov.style.padding = compact ? '4px' : '8px';
    if (ui.qrClose) {
      ui.qrClose.style.cssText = compact
        ? 'position:fixed;right:10px;top:10px;font-size:12px;padding:4px 8px;background:#39424e;color:#fff;' +
          'border:0;border-radius:6px;z-index:' + (Z + 3)
        : (BTN2_CSS + ';margin-top:8px');
    }
    if (ui.qrCopy) {
      ui.qrCopy.style.cssText = compact
        ? 'position:fixed;right:10px;bottom:10px;font-size:12px;padding:4px 8px;background:#39424e;color:#fff;' +
          'border:0;border-radius:6px;z-index:' + (Z + 3)
        : (BTN2_CSS + ';margin-top:6px');
    }
    var size = compact ? (Math.min(vw, vh) - 26) : Math.min(vw * 0.8, vh - 170, 680);
    size = Math.max(160, Math.floor(size));

    var fit = Core.qrFit(payload);
    if (window.QRCode && window.QRCode.toCanvas) {
      // 纠错等级用 L：同样内容模块数更少（实测 89x89 vs 101x101）= 每格像素更大 = 小屏更好扫
      window.QRCode.toCanvas(ui.qrCanvas, payload, {
        errorCorrectionLevel: 'L', margin: 1, width: size
      }, function (err) {
        if (err) { setStatus('二维码生成失败：' + err.message, '#ff6b6b'); return; }
        if (compact) setStatus('二维码已全屏显示（' + size + 'px）—— 让对方扫；扫完点右上角「收起」', '#7bd88f');
        else ui.qrHint.textContent = fit.chars + ' 字符 / ' + fit.bytes + ' 字节 · 显示尺寸 ' + size + 'px —— ' + fit.hint;
      });
    } else {
      setStatus('缺少 qrcode.min.js，无法渲染二维码（请检查 web/vendor/）', '#ff6b6b');
    }
  }

  /** 隐藏二维码浮层（保留 payload，可再点「显示二维码」打开） */
  function hideQr() {
    if (ui.qrOverlay) show(ui.qrOverlay, false);
    if (ui.btnShowQr) show(ui.btnShowQr, !!(state.lastPayload && state.role === 'host' && state.mode === 'qr'));
  }

  function stopScan() {
    state.scanning = false;
    show(ui.camBox, false);
    show(ui.btnSwitchScan, false);
    if (state.scanWatchdog) { clearTimeout(state.scanWatchdog); state.scanWatchdog = null; }
    if (state.scanner) {
      try {
        state.scanner.stop().then(function () { try { state.scanner.clear(); } catch (e) {} }).catch(function () {});
      } catch (e) {}
      state.scanner = null;
    }
    // 原生扫码用的透明态也要收回
    try { exitNativeScanVisual(); } catch (e) {}
    var nat = nativeScanner();
    if (nat) {
      try { if (nat.stopScan) nat.stopScan(); } catch (e) {}
      try { if (nat.removeAllListeners) nat.removeAllListeners(); } catch (e) {}
    }
  }

  /* ---- 原生扫码的可视状态：原生相机预览是画在 WebView *后面* 的，所以要把
         游戏画面和面板隐藏、背景设成透明，用户才看得见取景画面 ---- */
  function enterNativeScanVisual() {
    if (document.getElementById('mdz-scan-style')) return;
    var st = document.createElement('style');
    st.id = 'mdz-scan-style';
    st.textContent =
      'html.mdz-scanning, html.mdz-scanning body { background: transparent !important; }' +
      'html.mdz-scanning #c2canvasdiv { visibility: hidden !important; }' +
      'html.mdz-scanning #mdz-panel-wrap { display: none !important; }';
    document.head.appendChild(st);
    document.documentElement.classList.add('mdz-scanning');
    var tip = el('div', 'position:fixed;left:0;right:0;bottom:20px;text-align:center;color:#fff;' +
      'font:15px/1.6 "Microsoft YaHei",sans-serif;text-shadow:0 0 8px #000;pointer-events:none;z-index:2147483600',
      '把二维码放进取景框…（原生 MLKit 扫码）');
    tip.id = 'mdz-scan-tip';
    document.body.appendChild(tip);
  }
  function exitNativeScanVisual() {
    var st = document.getElementById('mdz-scan-style');
    if (st && st.parentNode) st.parentNode.removeChild(st);
    var tip = document.getElementById('mdz-scan-tip');
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    try { document.documentElement.classList.remove('mdz-scanning'); } catch (e) {}
  }

  /** 列出摄像头，尽量挑到后置的（安卓 WebView 常常不认 facingMode 软约束，
   *  会选到前置摄像头 —— 那样用户对着屏幕永远扫不到） */
  function pickBackCameraId() {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve(null);
    return md.enumerateDevices().then(function (list) {
      var cams = (list || []).filter(function (d) { return d.kind === 'videoinput'; });
      if (!cams.length) return null;
      log('摄像头设备：' + cams.map(function (d) { return d.label || ('id:' + String(d.deviceId).slice(0, 6)); }).join(' / '), '#9fe8ff');
      var back = cams.filter(function (d) { return /back|rear|environment|后置|背面/i.test(d.label || ''); })[0];
      if (back) { log('选用后置摄像头：' + (back.label || back.deviceId), '#9fe8ff'); return back.deviceId; }
      // 有些机型标签为空，最后一个通常是后置
      if (cams.length > 1 && !cams[0].label) { log('标签为空，按惯例取最后一个作为后置', '#ffcc66'); return cams[cams.length - 1].deviceId; }
      return null;
    }).catch(function () { return null; });
  }

  /** 方案：WebView 内嵌扫码（html5-qrcode / ZXing）。
   *  注意 useBarCodeDetectorIfSupported 默认关闭：安卓 WebView 里 BarcodeDetector
   *  存在但底层模块缺失时会静默失败 —— 一帧都不回调，表现就是"完全没反应"。
   *  另外两个对"电脑摄像头扫手机屏幕"很关键的点：
   *    1) 不设 qrbox —— 设了会把画面裁到中间一块，二维码稍偏一点就永远扫不到
   *    2) 明确要高分辨率 —— 默认 stream 可能只有 640x480，89x89 的密集码根本不够看 */
  function startWebViewScan(purpose) {
    return ensureWebScanner().then(function (ready) {
      if (!ready) throw new Error('html5-qrcode 不可用');
      return pickBackCameraId();
    }).then(function (backId) {
      var HD = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      // 约束从强到弱依次尝试，避免某些机型直接抛 OverconstrainedError
      var chain = [];
      if (backId) chain.push({ deviceId: { exact: backId }, width: HD.width, height: HD.height });
      chain.push({ facingMode: { exact: 'environment' }, width: HD.width, height: HD.height });
      chain.push({ facingMode: 'environment' });
      chain.push({ width: HD.width, height: HD.height });   // 电脑：任意摄像头 + 高分辨率
      chain.push({});                                       // 兜底
      var lastErr = null;
      function tryNext(i) {
        if (i >= chain.length) throw (lastErr || new Error('没有可用摄像头'));
        var cfg = chain[i];
        var inst = new window.Html5Qrcode('mdz-camera', {
          verbose: false,
          experimentalFeatures: { useBarCodeDetectorIfSupported: state.useBarcodeDetector === true }
        });
        return inst.start(
          cfg,
          { fps: 15 },          // 不设 qrbox：全画面扫描，容错最高
          function (decoded) { stopScan(); onScanned(decoded, purpose); },
          function () {                                  // 每帧未识别都会回调，用它统计帧数做诊断
            state.scanFrames = (state.scanFrames || 0) + 1;
            if (state.scanFrames % 60 === 0) {
              log('已分析 ' + state.scanFrames + ' 帧，仍未识别到二维码', '#ffcc66');
            }
          }
        ).then(function () {
          state.scanner = inst;
          var v = document.querySelector('#mdz-camera video');
          if (v) {
            var res = v.videoWidth + 'x' + v.videoHeight;
            log('取景分辨率：' + res + '，约束=' + JSON.stringify(cfg), '#9fe8ff');
            // 分辨率太低基本扫不动密集二维码，提前说清楚
            if (v.videoWidth && v.videoWidth < 640) {
              setStatus('摄像头分辨率偏低（' + res + '），密集二维码可能扫不动 —— 建议改用「复制握手串」文本方式', '#ffcc66');
            }
          }
          return true;
        }).catch(function (e) {
          lastErr = e;
          try { inst.clear(); } catch (_) {}
          log('摄像头约束失败（' + JSON.stringify(cfg) + '）：' + (e && e.message || e) + '，换下一个', '#ffcc66');
          return tryNext(i + 1);
        });
      }
      return tryNext(0);
    }).then(function () {
      setStatus(purpose === 'host-answer' ? '把客机的回码放进画面里（全画面识别，不用对准框）'
                                          : '把房主的二维码放进画面里（全画面识别，不用对准框）', '#ffcc66');
      return true;
    });
  }

  /** 方案：Capacitor 原生插件（用**捆绑模型** startScan，离线、不依赖 Google Play 服务）
   *  MLKit 对密集二维码的识别率远高于 ZXing，所以 App 内优先用它。
   *  注意不要用 scan()：那是 Google Code Scanner，需要先下载 GMS 模块。 */
  function startNativeScan(purpose) {
    var nat = nativeScanner();
    if (!nat || !nat.startScan) return Promise.reject(new Error('原生扫码插件不可用'));
    enterNativeScanVisual();
    return Promise.resolve(nat.addListener('barcodesScanned', function (ev) {
      var b = ev && ev.barcodes && ev.barcodes[0];
      var v = b && (b.rawValue || b.displayValue);
      exitNativeScanVisual();
      stopScan();
      if (v) onScanned(v, purpose);
      else setStatus('没有识别到二维码，请再试一次', '#ffcc66');
    })).then(function () {
      return nat.checkPermissions ? nat.checkPermissions() : null;
    }).then(function (st) {
      if (st && st.camera === 'granted') return null;
      return nat.requestPermissions ? nat.requestPermissions() : null;
    }).then(function () {
      return nat.startScan({ formats: ['QR_CODE'], lensFacing: 'BACK' });
    }).then(function () {
      setStatus('把二维码放进取景框（原生 MLKit 扫码）', '#ffcc66');
      return true;
    }).catch(function (e) {
      exitNativeScanVisual();
      throw e;
    });
  }

  /** 启动后 8 秒还没有识别到就给出可操作的提示，并亮出"换个扫码方式"按钮 */
  function isDesktop() {
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    return !touch && (window.innerWidth || 0) >= 900;
  }
  function startScanWatchdog(purpose) {
    if (state.scanWatchdog) clearTimeout(state.scanWatchdog);
    state.scanWatchdog = setTimeout(function () {
      if (!state.scanning) return;
      show(ui.btnSwitchScan, true);
      var desk = isDesktop();
      if (state.scanMethod === 'native') {
        setStatus('原生扫码 8 秒内没识别到：把二维码占满取景框，或点「换个扫码方式」', '#ffcc66');
      } else if (!state.scanFrames) {
        setStatus('摄像头没有输出画面（可能选到了前置摄像头或被占用）→ 点「换个扫码方式」', '#ff6b6b');
      } else if (desk) {
        // 电脑上 Chrome 没有 BarcodeDetector，只能靠 ZXing-JS，扫手机屏幕上的密集码命中率很低
        setStatus('已分析 ' + state.scanFrames + ' 帧仍未识别（电脑摄像头扫手机屏幕本来就难）→ ' +
          '可靠办法：让对方点「复制握手串」把文本发给你，粘到下面文本框再点对应按钮', '#ffcc66');
      } else {
        setStatus('已分析 ' + state.scanFrames + ' 帧仍未识别：让二维码更大更清晰，或点「换个扫码方式」', '#ffcc66');
      }
    }, 8000);
  }

  function startScan(purpose, methodOverride) {
    if (!canScan()) {
      ui.modeTxt.checked = true;
      switchMode('text');
      setStatus('本环境不能扫码（网页需 https/localhost，App 内需摄像头权限），已切到文本模式', '#ffcc66');
      return;
    }
    stopScan();
    state.scanning = true;
    state.scanFrames = 0;
    show(ui.camBox, true);

    // App 内优先原生 MLKit（密集二维码识别率最高、离线）；网页只有 WebView 方案
    var method = methodOverride || state.scanMethod || (nativeScanner() ? 'native' : 'web');
    state.scanMethod = method;
    var run = (method === 'native') ? startNativeScan : startWebViewScan;
    var alt = (method === 'native') ? startWebViewScan : startNativeScan;
    var altName = (method === 'native') ? 'web' : 'native';

    setStatus((method === 'native' ? '正在启动原生扫码（MLKit）…' : '正在启动摄像头…'), '#ffcc66');

    run(purpose).then(function () {
      startScanWatchdog(purpose);
    }).catch(function (e1) {
      var m1 = (e1 && (e1.message || e1.name)) || String(e1);
      log('扫码方式 ' + method + ' 不可用：' + m1 + '，自动换 ' + altName, '#ffcc66');
      return alt(purpose).then(function () {
        state.scanMethod = altName;
        startScanWatchdog(purpose);
      }).catch(function (e2) {
        var m2 = (e2 && (e2.message || e2.name)) || String(e2);
        throw new Error(m1 + ' / ' + m2);
      });
    }).catch(function (e) {
      stopScan();
      var msg = (e && (e.message || e.name)) || String(e);
      ui.modeTxt.checked = true;
      switchMode('text');
      // 注意：switchMode 会重写状态行，所以原因必须在它之后再写一次，否则用户看不到
      if (/permission|NotAllowed/i.test(msg)) {
        setStatus('摄像头权限被拒绝，已切到文本模式：可直接把 Offer/Answer 复制发给对方', '#ff6b6b');
      } else {
        setStatus('扫码不可用（' + msg + '），已切到文本模式：把 Offer/Answer 复制发给对方', '#ff6b6b');
      }
    });
  }

  function onScanned(payload, purpose) {
    setStatus('已识别二维码，正在处理…', '#9fe8ff');
    if (purpose === 'host-answer') {
      P.hostAcceptPeer(payload)
        .then(function () { if (state.stage !== 'connected') setStatus('已应用客机回码，等待直连…', '#7bd88f'); })
        .catch(function (e) { setStatus('应用客机回码失败：' + e.message, '#ff6b6b'); });
    } else {
      P.clientAcceptHost(payload)
        .then(function (r) {
          ui.offer.value = payload;
          ui.answer.value = r.payload;
          if (state.mode === 'qr') renderQr(r.payload);
          setStatus('Answer 已生成，请让房主扫这个回码', '#7bd88f');
          afterClientAnswerReady();
        })
        .catch(function (e) { setStatus('处理房主二维码失败：' + e.message, '#ff6b6b'); });
    }
  }

  /* ---------------------------------------------------------------- 流程 */

  function switchMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    P.setMode(mode);
    stopScan();
    // 文本握手区在两种模式下都显示：扫码扫不上时（尤其电脑摄像头）随时可以退回复制文本，
    // 而且握手串本身与模式无关 —— QR 只是它的一个载体。
    show(ui.textBox, true);
    hideQr();
    if (mode === 'qr' && !canScan()) {
      setStatus('当前环境扫码不可用（网页需 https/localhost，App 内需原生插件）', '#ffcc66');
    } else {
      setStatus(mode === 'qr' ? '模式A：面对面扫码（同一 Wi-Fi）' : '模式B：异地文本 SDP（可跨网络）', '#9fe8ff');
    }
    refreshButtons();
  }

  function refreshButtons() {
    var isHost = state.role === 'host';
    var isClient = state.role === 'client';
    show(ui.btnHost, !state.role);
    show(ui.btnJoin, !state.role);
    show(ui.btnScanPeer, isHost && state.mode === 'qr');
    show(ui.btnGenAnswer, isClient);
    show(ui.btnAcceptAnswer, isHost);
    // 只有"只拿到 mDNS 候选"时才需要这一步：申请摄像头权限换真实内网 IP
    show(ui.btnUnobf, isHost && state.hint === 'mdns');
    // 二维码浮层被收起后，留一个按钮能再打开
    show(ui.btnShowQr, isHost && state.mode === 'qr' && !!state.lastPayload &&
      !(ui.qrOverlay && ui.qrOverlay.style.display === 'flex'));
    show(ui.btnCancel, !!state.role || state.stage === 'connected');
  }

  function roomName() {
    var v = (ui.room.value || '').trim();
    return v || ('mdz-' + Math.random().toString(36).slice(2, 6));
  }

  function onHost() {
    state.role = 'host'; state.stage = 'offered';
    setStatus('正在生成 Offer 并收集局域网候选…', '#ffcc66');
    refreshButtons();
    P.hostBegin({ mode: state.mode, room: roomName() })
      .then(function (r) {
        ui.offer.value = r.payload;
        state.hint = r.hint;
        if (state.mode === 'qr') renderQr(r.payload);
        refreshButtons();
        if (r.hint === 'mdns') {
          setStatus('已生成：只拿到 mDNS 候选（.local）。多数情况同网仍可连；若对方连不上，点「②b」授权摄像头后重出码', '#ffcc66');
        } else {
          setStatus(state.mode === 'qr' ? '房间已创建：请让客机扫码' : '房间已创建：把 Offer 复制发给队友', '#7bd88f');
        }
        // 交给游戏原逻辑：lan_bridge 会挂上 on('connection')，通道一开就自动开始同步
        if (typeof window.startHost === 'function') window.startHost(roomName());
        else setStatus('未找到 window.startHost（lan_bridge.js 没加载？）', '#ff6b6b');
      })
      .catch(function (e) { setStatus('创建房间失败：' + describeErr(e), '#ff6b6b'); state.role = null; refreshButtons(); });
  }

  /**
   * 方案 (c) 的兜底路径：只拿到 mDNS 候选（.local）时，向用户申请一次摄像头权限。
   * 拿到权限后浏览器就不再混淆 host candidate，我们能得到真实的 192.168.x.x，局域网直连更稳。
   * 这一步会重新生成 Offer（旧 pc 已被 hostBegin 关闭），所以必须再次调用 startHost 让游戏重新挂监听。
   */
  function onUnobfuscate() {
    if (state.role !== 'host') { setStatus('只有房主需要做这一步', '#ffcc66'); return; }
    setStatus('正在申请摄像头权限以取消 mDNS 混淆…（授权后只是读一下权限，不会录像）', '#ffcc66');
    ui.btnUnobf.disabled = true;
    P.hostBegin({ mode: state.mode, room: roomName(), unobfuscated: true })
      .then(function (r) {
        ui.btnUnobf.disabled = false;
        ui.offer.value = r.payload;
        state.hint = r.hint;
        if (state.mode === 'qr') renderQr(r.payload);
        refreshButtons();
        var st = r.iceStats || {};
        if ((st.lan || 0) > 0) {
          setStatus('已重新生成：拿到真实内网 IP（' + (st.lanAddresses || []).join(', ') + '），请让客机重新扫码', '#7bd88f');
        } else {
          setStatus('已重新生成，但仍是 mDNS 候选（摄像头权限可能被拒绝）。可先直接试扫码，或改用「异地文本 SDP」模式', '#ffcc66');
        }
        if (typeof window.startHost === 'function') window.startHost(roomName());
      })
      .catch(function (e) {
        ui.btnUnobf.disabled = false;
        setStatus('重新生成失败：' + describeErr(e), '#ff6b6b');
      });
  }

  function onJoin() {
    state.role = 'client'; state.stage = 'joining';
    refreshButtons();
    P.clientBegin({ mode: state.mode }).then(function () {
      if (state.mode === 'qr') {
        startScan('client-offer');
      } else {
        setStatus('请把房主发来的 Offer 粘贴到上面的文本框，然后点"② 客机：生成 Answer"', '#ffcc66');
      }
    });
  }

  function onGenAnswer() {
    var offer = (ui.offer.value || '').trim();
    if (!offer) { setStatus('请先把房主的 Offer 粘贴到上面的文本框', '#ffcc66'); return; }
    setStatus('正在解析 Offer 并生成 Answer…', '#ffcc66');
    state.role = state.role || 'client';
    refreshButtons();
    // 容错：用户可能直接点"生成 Answer"而没先点"加入房间"，这里自动补上会话初始化
    var arm = P.currentClient() ? Promise.resolve() : P.clientBegin({ mode: state.mode });
    arm
      .then(function () { return P.clientAcceptHost(offer); })
      .then(function (r) {
        ui.answer.value = r.payload;
        setStatus('Answer 已生成：复制发给房主', '#7bd88f');
        afterClientAnswerReady();
      })
      .catch(function (e) { setStatus('生成 Answer 失败：' + describeErr(e), '#ff6b6b'); });
  }

  function afterClientAnswerReady() {
    state.stage = 'answered';
    // 交给游戏原逻辑：joinGame -> new Peer -> connect() -> 通道打开后开始同步
    if (typeof window.joinGame === 'function') window.joinGame(roomName());
    else setStatus('未找到 window.joinGame（lan_bridge.js 没加载？）', '#ff6b6b');
    refreshButtons();
  }

  function onAcceptAnswer() {
    var ans = (ui.answer.value || '').trim();
    if (!ans) {
      if (state.mode === 'qr') { startScan('host-answer'); return; }
      setStatus('请先把客机发回的 Answer 粘贴到下面的文本框', '#ffcc66');
      return;
    }
    setStatus('正在应用 Answer…', '#ffcc66');
    P.hostAcceptPeer(ans)
      .then(function () {
        // 通道可能在 hostAcceptPeer 返回前就已经打开并触发过"已连接"，
        // 这里不能再覆盖掉那条更新的状态
        if (state.stage !== 'connected') setStatus('已应用 Answer，等待直连…', '#7bd88f');
      })
      .catch(function (e) { setStatus('建立连接失败：' + describeErr(e), '#ff6b6b'); });
  }

  function onCancel() {
    stopScan();
    P.cancel();
    try { if (typeof window.leaveRoom === 'function' && state.stage === 'connected') window.leaveRoom(); } catch (e) {}
    state.role = null; state.stage = 'idle';
    hideQr(); show(ui.camBox, false);
    ui.offer.value = ''; ui.answer.value = '';
    setStatus('已取消', '#ffcc66');
    refreshButtons();
  }

  function describeErr(e) {
    var map = {};
    map[P.ERR.NO_CANDIDATES] = '没有收集到局域网候选，扫码模式无法工作 —— 建议切换"异地文本 SDP"模式';
    map[P.ERR.ICE_FAILED] = '直连失败（异地多为 NAT 限制，局域网请确认同一 Wi-Fi 且未开客户端隔离）';
    map[P.ERR.PARSE] = '握手串解析失败（可能复制不完整或被聊天软件改写）';
    map[P.ERR.TIMEOUT] = '等待对端超时';
    map[P.ERR.CAMERA] = '摄像头不可用';
    return (e && e.code && map[e.code]) ? (map[e.code] + '（' + e.message + '）') : ((e && e.message) || String(e));
  }

  function copy(text, what) {
    if (!text) { setStatus('没有可复制的' + what, '#ffcc66'); return; }
    var done = function () { setStatus(what + ' 已复制到剪贴板', '#7bd88f'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, what); });
    } else fallbackCopy(text, what);
  }
  function fallbackCopy(text, what) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      setStatus(what + ' 已复制（兼容模式）', '#7bd88f');
    } catch (e) { setStatus('复制失败，请手动选择文本框内容复制', '#ff6b6b'); }
  }

  /* ------------------------------------------------------------ 事件订阅 */

  function subscribe() {
    P.on('payload', function (d) {
      // 不管入口是"我们的面板"还是"游戏原面板"，只要握手串就绪就把界面亮出来
      expandPanel();
      state.role = d.role;
      state.stage = 'offered';
      state.hint = d.hint || null;
      refreshButtons();
      if (d.role === 'host') { ui.offer.value = d.payload; if (state.mode === 'qr') renderQr(d.payload); }
      else { ui.answer.value = d.payload; if (state.mode === 'qr') renderQr(d.payload); }
      log((d.role === 'host' ? 'Offer' : 'Answer') + ' 握手串就绪：' + d.fit.chars + ' 字符', '#7bd88f');
    });
    // 用户点的是游戏原面板的"加入"：我们没拿到房主握手串，主动引导扫码/粘贴
    P.on('needsHostPayload', function (d) {
      expandPanel();
      state.role = 'client';
      state.stage = 'joining';
      refreshButtons();
      if (d && d.mode === 'qr') startScan('client-offer');
      else setStatus('请把房主发来的 Offer 粘贴到上面的文本框，然后点"② 客机：生成 Answer"', '#ffcc66');
    });
    P.on('connected', function (d) {
      state.stage = 'connected';
      setStatus('已连接！游戏同步已开始（' + (d.role === 'host' ? '房主' : '客机') + '）', '#7bd88f');
      stopScan();
      hideQr();
      refreshButtons();
    });
    P.on('error', function (e) {
      setStatus('连接错误：' + describeErr(e), '#ff6b6b');
      // 局域网直连失败且当时只有 mDNS 候选 -> 明确给出"授权摄像头重出码"这条路
      if (e && e.code === P.ERR.ICE_FAILED && state.hint === 'mdns' && state.role === 'host') {
        state.hint = 'mdns'; refreshButtons();
        setStatus('直连失败，且当前只有 mDNS 候选 → 请点「②b 授权摄像头后重出码」再让客机扫一次', '#ffcc66');
      }
    });
    P.on('state', function (s) {
      if (!s) return;
      if (s.stage === 'camera-denied') {
        ui.modeTxt.checked = true;
        switchMode('text');
        setStatus('摄像头权限被拒绝，已切到文本模式（用复制粘贴完成握手）', '#ff6b6b');
      }
      if (s.channel === 'closed') { setStatus('连接已断开', '#ff6b6b'); state.stage = 'idle'; refreshButtons(); }
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  function init() {
    try {
      if (!document.body) { setTimeout(init, 50); return; }
      // App 内：隐藏状态栏，让画面真正铺满（配合 AndroidManifest 的横屏锁定）
      try {
        var plugins = window.Capacitor && window.Capacitor.Plugins;
        var sb = plugins && plugins.StatusBar;
        if (sb) {
          if (sb.setOverlaysWebView) sb.setOverlaysWebView({ overlay: false });
          if (sb.hide) sb.hide();
          console.log('[MDZ-UI] 已请求隐藏状态栏（全屏）');
        }
      } catch (e) { console.warn('[MDZ-UI] 隐藏状态栏失败', e); }
      buildPanel();
      subscribe();
      switchMode(canScan() ? 'qr' : 'text');
      if (!canScan()) ui.modeTxt.checked = true;
      // 桌面浏览器（Mac/ChromeOS）上的 BarcodeDetector 比 ZXing 强得多，能用就用；
      // 但 App 的 WebView 里它会静默失败，所以原生 App 内一律关掉。
      try { state.useBarcodeDetector = !isNative() && (typeof window.BarcodeDetector === 'function'); } catch (e) {}
      P.setMode(state.mode);
      refreshButtons();
      log('面板就绪。扫码能力：' + (nativeScanner() ? '原生插件' : (webScannerAvailable() ? 'html5-qrcode' : '不可用')), '#9fe8ff');
      log('面板可用手指/鼠标拖动标题栏移动位置（挡住游戏按钮时拖开即可）', '#9fe8ff');
      console.log('[MDZ-UI] 调试提示：MDZP2P.stats() 看统计；MDZP2P.setFastLane(false) 关闭副通道；MDZP2P.CFG.DEBUG=false 关日志');
    } catch (e) {
      fatal('初始化异常：' + (e && e.message ? e.message : e), e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.MDZUI = {
    init: init,
    state: state,
    canScan: canScan,
    switchMode: switchMode,
    startScan: startScan,
    _ui: ui
  };
})();
