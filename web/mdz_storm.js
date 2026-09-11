/* ============================================================================
 * mdz_storm.js —— 交互请求风暴刹车 + bushes 重同步（外挂式，不改 mp_*.js）
 * ----------------------------------------------------------------------------
 * 真机现象：手机烫、耗电快。日志里量到了元凶：
 *     Interactions.requestsRejected 394 → 932（约每秒 50 次）
 *     [MOD] host_reject reason=stale_revision
 *
 * 机制（读 mp_interactions.js 确认）：客机每隔一小段时间就会对"它自己认为能采的
 * bushes"发 mp_bush_request；请求进 pending，3 秒后 pending 过期又重发。
 * 只要**客机的 bushes 表和房主对不上**，房主就会一直拒 → 客机一直重发 → 死循环。
 *
 * 治根的办法（用的还是 MOD 自己的公开 API）：
 *     MPInteractions.reset();                 // 清掉本地 pending / 表状态
 *     MPInteractions.setRole("client");
 *     MPInteractions.setSender(sendFn);       // ← 这一步会让客机重新发
 *                                             //   {type:"mp_bush_request"} 拉取全量 bushes
 * 两边表对齐后，客机就不会再对"其实采不了"的 bushes 反复请求，风暴自停。
 *
 * 只在**客机**侧刹车（房主是权威，重置它反而会把正确的表清掉），
 * 并有冷却与次数上限：治不好会明确报出来，而不是无脑重试。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-storm-1';
  var CFG = {
    intervalMs: 4000,
    rejectDelta: 25,      // 一个采样周期内被拒超过这个数 → 判定风暴
    cooldownMs: 15000,    // 两次刹车之间的最小间隔
    maxBrakes: 6,         // 刹车次数上限（治不好就报出来，别无限重试）
    debug: true,
    autoStart: true
  };

  function ui(action, a, b) {
    try {
      var U = window.MDZUI;
      if (U && typeof U[action] === 'function') return U[action](a, b);
    } catch (e) { /* 忽略 */ }
    if (action === 'log' && typeof console !== 'undefined' && console.log) {
      console.log('[MDZ-STORM] ' + a);
    }
  }
  function log(m, c) { if (CFG.debug) ui('log', m, c); }

  var st = {
    role: null, lastRejected: null, lastSent: null,
    brakes: 0, lastBrakeAt: 0, storms: 0, warned: false, timer: null
  };

  function roleNow() {
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

  function iaStats() {
    try {
      var I = window.MPInteractions;
      if (!I || typeof I.stats !== 'function') return null;
      var s = I.stats();
      if (!s) return null;
      return { rejected: Number(s.requestsRejected) || 0, sent: Number(s.requestsSent) || 0 };
    } catch (e) { return null; }
  }

  /** 让客机重新拉取全量 bushes：reset + 重新挂 role/sender */
  function brake(reason) {
    var I = window.MPInteractions;
    var c = null;
    try { c = window.MDZP2P && window.MDZP2P.currentConn ? window.MDZP2P.currentConn(st.role) : null; } catch (e) { c = null; }
    if (!I || typeof I.reset !== 'function' || typeof I.setSender !== 'function') {
      log('风暴刹车不可用（MPInteractions 缺 reset/setSender）', '#ff6b6b');
      return false;
    }
    st.brakes++;
    st.lastBrakeAt = Date.now();
    try {
      I.reset();
      if (typeof I.setRole === 'function') I.setRole('client');
      I.setSender(function (msg) { try { if (c && c.open) c.send(msg); } catch (e) { /* 忽略 */ } });
      log('★ 检测到交互请求风暴（' + reason + '）→ 已重置交互状态并重新拉取 bushes 全量，' +
        '两边表对齐后风暴应停止（第 ' + st.brakes + ' 次）', '#ffcc66');
      return true;
    } catch (e) {
      log('风暴刹车失败：' + ((e && e.message) || e), '#ff6b6b');
      return false;
    }
  }

  function tick() {
    var r = roleNow();
    if (r !== st.role) {
      st.role = r; st.lastRejected = null; st.lastSent = null; st.brakes = 0; st.warned = false;
      if (r) log('风暴监视开始（' + r + '）', '#9fe8ff');
    }
    if (st.role !== 'client') return { skip: 'not-client' };   // 只在客机侧刹车
    var s = iaStats();
    if (!s) return { skip: 'no-stats' };
    if (st.lastRejected === null) { st.lastRejected = s.rejected; st.lastSent = s.sent; return { skip: 'first-sample' }; }
    var dRej = s.rejected - st.lastRejected;
    var dSent = s.sent - (st.lastSent || 0);
    st.lastRejected = s.rejected; st.lastSent = s.sent;

    if (dRej < CFG.rejectDelta) return { rejectedDelta: dRej, sentDelta: dSent };

    st.storms++;
    if (Date.now() - st.lastBrakeAt < CFG.cooldownMs) return { rejectedDelta: dRej, cooling: true };
    if (st.brakes >= CFG.maxBrakes) {
      if (!st.warned) {
        st.warned = true;
        log('风暴自愈失败：已刹车 ' + CFG.maxBrakes + ' 次仍持续（最近 ' + dRej +
          ' 次/周期被拒）。请把日志发我 —— 说明客机与房主的 bushes 表结构性不一致', '#ff6b6b');
      }
      return { rejectedDelta: dRej, exhausted: true };
    }
    brake('一个周期内被拒 ' + dRej + ' 次，发出 ' + dSent + ' 次请求');
    return { rejectedDelta: dRej, braked: true };
  }

  function start() {
    if (st.timer) return;
    if (CFG.autoStart) st.timer = setInterval(tick, CFG.intervalMs);
    log('风暴刹车就绪（' + BUILD + '）：检测到交互请求风暴会重置并重新拉取 bushes', '#9fe8ff');
  }
  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  window.MDZStorm = {
    BUILD: BUILD,
    CFG: CFG,
    start: start,
    stop: stop,
    tick: tick,
    brakeNow: function () { return brake('手动'); },
    state: function () {
      return {
        role: st.role, brakes: st.brakes, storms: st.storms,
        lastRejected: st.lastRejected, lastSent: st.lastSent
      };
    }
  };

  start();
})();
