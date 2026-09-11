/* ============================================================================
 * mdz_island.js —— 跨岛/换图「检测 + 断开提示重连」（路线1）
 * ----------------------------------------------------------------------------
 * ⚠️ 重要：**不要再用"整张世界快照"来同步地图**。
 *   实测过：C2 的 saveToJSONString 会把"运行布局里所有实例 + 每个实例的实例变量"
 *   一起序列化（c2runtime.js: types[sid].instances.push(saveInstanceToJSON(inst))），
 *   其中就包括**房主的角色实例和背包**。把它当"中途热重载"用，客机会把房主的角色/
 *   装备一起加载进来；而 MOD 的"载入后恢复自己的角色检查点"在反复推送时会被污染
 *   （第二次推送时抓到的检查点已经是上一次载入后的状态），于是装备彻底变成房主的，
 *   且因为授权账本里那些物品不属于客机，任何卸下都会被回滚（"脱不下来"）。
 *
 * 所以本模块现在只做两件事：
 *   1. 检测跨岛/换图：两端各采 MDZ.fingerprint() 的地形指纹，房主广播，客机比对；
 *   2. 一旦检测到（房主换岛 / 客机自己乱跑换岛）→ 明说原因 + 断开联机 +
 *      提示"到同一个岛后重新连接"（重新加入走的是正规加入流程，
 *      那时客机自己的角色/装备会被正确恢复 —— 这是加入流程本来就设计好的）。
 *
 * 为什么不做"热同步"：跨岛 = 在同一张 Map 布局里重新生成世界，而联机层没有任何
 * "换图"消息；两端各自生成必然不同；唯一能对齐的手段就是搬整张世界状态，
 * 而那正好会把玩家数据一起搬过去（上面那段）。要做得漂亮，得让客机**本地**
 * 用同一个种子重新生成（需要先攻下"如何触发本地换岛"，见 README-DEV 待办）。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-island-2';
  var CFG = {
    mode: 'reconnect',       // 'reconnect' = 跨岛即断开并提示重连；'off' = 只诊断、不动连接
    intervalMs: 2500,        // 指纹采样间隔
    stableNeeded: 2,         // 连续多少次采样相同才算"稳定"（换图过程中会跳变）
    keepaliveMs: 15000,      // 房主即使没变化也定期广播（后加入的客机需要基准）
    mismatchConfirm: 2,      // 客机连续几次"稳定但不一致"才判定跨岛（防误判）
    debug: true,
    autoStart: true,
    now: null                // 测试可注入假时钟
  };

  function now() { return (typeof CFG.now === 'function') ? CFG.now() : Date.now(); }
  function short(h) { return h ? String(h).slice(0, 6) : '?'; }

  function ui(action, a, b) {
    try {
      var U = window.MDZUI;
      if (U && typeof U[action] === 'function') return U[action](a, b);
    } catch (e) { /* 面板不在也无所谓 */ }
    if (action === 'log' && typeof console !== 'undefined' && console.log) {
      console.log('[MDZ-ISLAND] ' + a);
    }
  }
  function log(m, c) { if (CFG.debug) ui('log', m, c); }
  function status(m, c) { ui('setStatus', m, c); }

  var st = {
    role: null, conn: null, attached: false,
    worldReady: false,
    rawHash: null, stableN: 0, fp: null,
    hostHash: null, hostSize: 0, hostHashAt: 0,
    sentHash: null, sentAt: 0,
    mismatchN: 0,
    aborted: false,          // 已经判定跨岛并断开，等下一次联机
    aborts: 0,
    timer: null, errs: 0, lastErr: null
  };

  /* ------------------------------------------------------------ 环境读取 */

  function moduleRole() {
    try {
      if (window.MPJoin && typeof window.MPJoin.role === 'function') {
        var r = window.MPJoin.role();
        if (r) return r;
      }
    } catch (e) { /* 忽略 */ }
    try {
      if (window.MDZP2P) {
        if (window.MDZP2P.currentHost && window.MDZP2P.currentHost()) return 'host';
        if (window.MDZP2P.currentClient && window.MDZP2P.currentClient()) return 'client';
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function worldReadyFlag() {
    try {
      if (window.MPEntities && typeof window.MPEntities.stats === 'function') {
        var s = window.MPEntities.stats();
        if (s && typeof s.worldReady === 'boolean') return s.worldReady;
      }
    } catch (e) { /* 忽略 */ }
    return st.worldReady;
  }

  function readFp() {
    try {
      if (!window.MDZ || typeof window.MDZ.fingerprint !== 'function') return null;
      var f = window.MDZ.fingerprint();
      if (!f || f.error) return null;
      var h = f.mapHash == null ? '' : String(f.mapHash);
      if (!h) return null;
      return { h: h, sz: Number(f.mapSize) || 0, seed: (f.seed == null ? null : String(f.seed)) };
    } catch (e) {
      st.errs++; st.lastErr = (e && e.message) || String(e);
      if (st.errs === 1) log('读取地图指纹失败（不影响游戏）：' + st.lastErr, '#ffcc66');
      return null;
    }
  }

  function attach() {
    if (!window.MDZP2P || !st.role) return false;
    var c = null;
    try { c = window.MDZP2P.currentConn(st.role); } catch (e) { c = null; }
    if (!c || typeof c.on !== 'function') { st.conn = null; st.attached = false; return false; }
    if (c === st.conn && st.attached) return true;
    st.conn = c; st.attached = true;
    try { c.on('data', onData); } catch (e) { st.attached = false; st.conn = null; return false; }
    log('已挂上联机通道（' + st.role + '），开始监视地图指纹', '#9fe8ff');
    return true;
  }

  function send(msg) {
    try {
      if (!st.conn || !st.conn.open) return false;
      st.conn.send({ __mdzIsland: msg });
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------ 收包处理 */

  function onData(obj) {
    if (!obj || typeof obj !== 'object' || !obj.__mdzIsland) return;
    var m = obj.__mdzIsland;
    if (!m || typeof m !== 'object') return;
    if (m.k === 'hb') return onHeartbeat(m);
    if (m.k === 'bye') return onBye(m);
  }

  function onHeartbeat(m) {
    st.hostHash = m.h == null ? '' : String(m.h);
    st.hostSize = Number(m.sz) || 0;
    st.hostHashAt = now();
    if (st.role !== 'client' || st.aborted) return;
    var mine = st.fp && st.fp.h;
    if (!mine || !st.hostHash) return;
    if (mine === st.hostHash) { st.mismatchN = 0; return; }
    st.mismatchN++;
    if (st.mismatchN >= CFG.mismatchConfirm) {
      islandChange('房主那张图是 ' + short(st.hostHash) + '，你是 ' + short(mine));
    }
  }

  function onBye(m) {
    if (st.aborted) return;
    st.aborted = true;
    st.aborts++;
    log('对面报告跨岛/换图 → 断开联机：' + ((m && m.why) || ''), '#ffcc66');
    status('房主已前往别的岛（或你已离开房主所在岛）→ 联机已断开。' +
      '请到同一个岛后重新连接：房主点「①创建房间」，客机点「①加入房间」', '#ff6b6b');
    teardown();
  }

  /* -------------------------------------------------- 判定跨岛 → 断开并提示 */

  function teardown() {
    try { if (window.MDZP2P && typeof window.MDZP2P.cancel === 'function') window.MDZP2P.cancel(); } catch (e) { /* 忽略 */ }
    st.attached = false; st.conn = null;
  }

  function islandChange(reason) {
    if (st.aborted) return;
    if (CFG.mode === 'off') {
      log('检测到跨岛/换图（' + reason + '），但热同步已关闭、只做诊断', '#ffcc66');
      status('检测到你和房主不在同一张地图（跨岛热同步已关闭，不会自动处理）', '#ffcc66');
      return;
    }
    st.aborted = true;
    st.aborts++;
    log('检测到跨岛/换图：' + reason + ' → 联机断开，等双方在同一个岛后重连', '#ffcc66');
    log('原因：跨岛无法热同步（搬整张世界会把房主的角色/背包一起带过来）', '#ffcc66');
    send({ k: 'bye', why: reason });
    status('跨岛了：联机已断开。请和房主到同一个岛后重新连接 —— ' +
      '房主点「①创建房间」，客机点「①加入房间」', '#ff6b6b');
    teardown();
  }

  /* ------------------------------------------------------------ 主循环 */

  function tick() {
    var r = moduleRole();
    if (r !== st.role) {
      st.role = r; st.attached = false; st.conn = null; st.sentHash = null; st.sentAt = 0;
      st.hostHash = null; st.mismatchN = 0;
      if (r) { st.aborted = false; log('联机角色：' + r + '，开始监视地图指纹（跨岛模式=' + CFG.mode + '）'); }
    }
    if (!st.role) { st.aborted = false; return { skip: 'no-role' }; }
    if (!st.worldReady) {
      if (!worldReadyFlag()) return { skip: 'world-not-ready' };
      st.worldReady = true;
    }
    attach();

    var f = readFp();
    if (!f) return { skip: 'no-fingerprint' };

    if (st.rawHash === f.h) st.stableN++;
    else { st.stableN = 1; st.rawHash = f.h; }
    if (st.stableN < CFG.stableNeeded) return { skip: 'unstable' };
    st.fp = f;

    if (st.role === 'host') {
      var changed = (st.sentHash !== f.h);
      var due = !st.sentAt || (now() - st.sentAt >= CFG.keepaliveMs);
      if (changed || due) {
        send({ k: 'hb', h: f.h, sz: f.sz });
        if (changed && st.sentHash) {
          islandChange('本机地图指纹变化 ' + short(st.sentHash) + ' → ' + short(f.h));
        } else {
          st.sentHash = f.h; st.sentAt = now();
        }
      }
      return { role: 'host', hash: f.h, changed: changed };
    }

    // 客机：本地指纹变了（自己换岛）也要判定
    if (!st.hostHash) return { skip: 'no-host-hash-yet' };
    if (f.h === st.hostHash) { st.mismatchN = 0; return { role: 'client', hash: f.h, match: true }; }
    st.mismatchN++;
    if (st.mismatchN >= CFG.mismatchConfirm) {
      islandChange('你自己这边是 ' + short(f.h) + '，房主是 ' + short(st.hostHash));
    }
    return { role: 'client', hash: f.h, match: false, mismatchN: st.mismatchN };
  }

  /* ------------------------------------------------------------ 启动 */

  // 事件监听在加载时就挂上（不依赖 DOMContentLoaded 时序）
  try {
    window.addEventListener('mdz-mp-world-ready', function () { st.worldReady = true; });
    window.addEventListener('mdz-mp-before-client-snapshot', function () {
      log('正在载入房主的世界…（注意：只有加入流程会走这里）', '#9fe8ff');
    });
  } catch (e) { /* 忽略 */ }

  function start() {
    if (st.timer) return;
    if (CFG.autoStart) st.timer = setInterval(tick, CFG.intervalMs);
    log('跨岛检测就绪（' + BUILD + '，模式=' + CFG.mode +
      '：检测到跨岛就断开并提示重连，不做热同步）', '#9fe8ff');
  }
  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  window.MDZIsland = {
    BUILD: BUILD,
    CFG: CFG,
    start: start,
    stop: stop,
    tick: tick,
    onData: onData,
    /** 供 UI「跨岛后重连」按钮用：立刻断开并给出提示 */
    reconnectNow: function (why) {
      st.aborted = false;
      islandChange(why || '手动断开重连');
      return true;
    },
    state: function () {
      return {
        role: st.role, worldReady: st.worldReady, attached: st.attached,
        myHash: st.fp ? st.fp.h : null, hostHash: st.hostHash,
        mismatchN: st.mismatchN, aborted: st.aborted, aborts: st.aborts,
        errs: st.errs, lastErr: st.lastErr
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
