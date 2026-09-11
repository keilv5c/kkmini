/* ============================================================================
 * mdz_diag.js —— 联机模块可观测性钩子（把 MOD 内部 trace 与计数器摊到面板上）
 * ----------------------------------------------------------------------------
 * 为什么需要：
 *   原 MOD 在关键路径上留了 window.MDZTrace.log(事件, 数据) 这个钩子，比如
 *     MDZTrace.log('auth_deferred', {need:'gain', amount:1})   // 房主把授权延后一拍再看
 *     MDZTrace.log('host_reject',   {reason:'inventory_gain_not_authorized'})
 *     MDZTrace.log('rollback',      {items:5, slots:8})        // 回滚背包
 *   但默认没人实现 MDZTrace，于是这些关键信息全丢了 —— 真机上出现
 *   "捡到的东西点一下就消失"这类问题时只能靠猜。本文件把 MDZTrace 接上，
 *   转发进联机面板的日志，并定期汇报各模块计数器的**变化**。
 *
 * 只读，不拦截任何游戏函数：只挂一个日志接收器 + 定时读 stats()。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-diag-1';
  var CFG = {
    intervalMs: 3000,
    debug: true,
    autoStart: true,
    maxTraces: 300,
    // 这些字段一直在变、没有诊断价值，不报
    ignoreKey: /At$|Time$|sequence|revision|hash|buffered/i
  };

  function ui(action, a, b) {
    try {
      var U = window.MDZUI;
      if (U && typeof U[action] === 'function') return U[action](a, b);
    } catch (e) {}
    if (action === 'log' && typeof console !== 'undefined' && console.log) {
      console.log('[MDZ-DIAG] ' + a);
    }
  }
  function log(m, c) { if (CFG.debug) ui('log', m, c); }

  var traces = [];
  var prev = null;
  var timer = null;

  /* ---------------------------------------------- 1. 接上 MOD 的 trace 钩子 */
  function formatTrace(evt, data) {
    var line = String(evt || '?');
    if (data && typeof data === 'object') {
      try {
        var parts = [];
        Object.keys(data).forEach(function (k) {
          var v = data[k];
          if (v === null || v === undefined || typeof v === 'object') return;
          parts.push(k + '=' + v);
        });
        if (parts.length) line += ' ' + parts.join(' ');
      } catch (e) { /* 忽略 */ }
    } else if (data !== undefined) {
      line += ' ' + data;
    }
    return line;
  }

  function pushTrace(line) {
    traces.push(line);
    if (traces.length > CFG.maxTraces) traces.shift();
    // 拒绝/回滚类事件用醒目颜色，方便一眼看到
    var hot = /reject|rollback|not_authorized|deferred|mismatch/i.test(line);
    log('[MOD] ' + line, hot ? '#ff9955' : '#9fe8ff');
  }

  function installTrace() {
    var existing = window.MDZTrace;
    var oldLog = (existing && typeof existing.log === 'function') ? existing.log : null;
    window.MDZTrace = {
      entries: traces,
      log: function (evt, data) {
        // 别人先挂过就链式保留，别把别人的分析器挤掉
        if (oldLog) { try { oldLog.call(existing, evt, data); } catch (e) {} }
        pushTrace(formatTrace(evt, data));
      }
    };
    log('已接上 MOD 的调试钩子 MDZTrace（授权/回滚/拒绝都会记进面板日志）', '#7bd88f');
  }

  /* ------------------------------------- 2. 定时汇报各模块计数器的变化 */
  var MODULES = ['MPJoin', 'MPWorldState', 'MPEntities', 'MPPlayers', 'MPInteractions', 'MDZIsland'];

  function snapshot() {
    var out = {};
    MODULES.forEach(function (name) {
      var m = window[name];
      if (!m) return;
      // MDZIsland 是我们自己的模块，用 state()
      var s = null;
      try {
        if (typeof m.stats === 'function') s = m.stats();
        else if (typeof m.state === 'function') s = m.state();
      } catch (e) { return; }
      if (!s || typeof s !== 'object') return;
      Object.keys(s).forEach(function (k) {
        var v = s[k];
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
          out[name + '.' + k] = v;
        }
      });
    });
    return out;
  }

  function tick() {
    var now = snapshot();
    if (prev) {
      var changes = [];
      Object.keys(now).forEach(function (k) {
        if (CFG.ignoreKey.test(k)) return;
        if (prev[k] !== now[k]) changes.push(k.replace(/^MP/, '') + ' ' + prev[k] + '→' + now[k]);
      });
      if (changes.length) {
        var hot = changes.some(function (c) { return /Reject|reject|restor|Restor|rollback/i.test(c); });
        log('[统计] ' + changes.slice(0, 8).join('，') + (changes.length > 8 ? ' …(+' + (changes.length - 8) + ')' : ''),
          hot ? '#ff9955' : '#9fe8ff');
      }
    }
    prev = now;
  }

  function start() {
    if (timer) return;
    if (CFG.autoStart) timer = setInterval(tick, CFG.intervalMs);
    var have = MODULES.filter(function (n) { return !!window[n]; });
    log('诊断模块就绪（' + BUILD + '）：可见模块 ' + (have.join(',') || '无') +
      '；日志可点「复制日志」发出来', '#9fe8ff');
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  window.MDZDiag = {
    BUILD: BUILD,
    CFG: CFG,
    start: start,
    stop: stop,
    tick: tick,
    traces: function () { return traces.slice(); },
    stats: function () { return snapshot(); },
    clear: function () { traces = []; prev = null; }
  };

  installTrace();
  start();
})();
