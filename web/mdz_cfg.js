/* ============================================================================
 * mdz_cfg.js —— 联机增强模块的配置中枢（稳定模式 + 逐模块开关）
 * ----------------------------------------------------------------------------
 * 为什么需要它：
 *   为了排查真机问题，我陆续加了 5 个增强模块（跨岛检测/诊断/命中兼容/角色自保/
 *   风暴刹车）。上线后需要能"现场关掉任意一个、并且省电"，而不是每次都让我重新出包。
 *
 * 能力：
 *   · 「稳定模式（省电）」：把各模块的采样频率降到省电档（默认开启）
 *   · 逐模块开关：关掉就不跑它（立即生效，不需要重装）
 *   · 配置存 localStorage，重开 App 仍然有效
 *   · 面板上有一排勾选框（见 mdz_ui.js 的「稳定模式 / 模块开关」），另有「恢复默认」
 *
 * 用法（其他模块）：
 *   MDZCFG.isOn('hitfix')            // 该模块是否启用
 *   MDZCFG.isStable()               // 是否处于省电档
 *   MDZCFG.interval(normal, stable) // 取当前该用哪个采样间隔
 *   MDZCFG.onChange(function(all){})// 配置变化时回调（用于 start/stop）
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-cfg-1';
  var KEY = 'mdz.cfg.v1';

  // 默认值：稳定模式开；功能模块全开（命中兼容/风暴刹车是修复项，不能默认关）
  var DEFAULTS = {
    stable: true,     // 省电档
    island: true,     // 跨岛/换图检测（检测到就断开提示重连）
    diag: true,       // 诊断（MDZTrace / 计数器 / 游戏内提示镜像）
    hitfix: true,     // 命中兼容（客机打不到怪的修复）
    players: true,    // 角色自保（防止装备被房主版本覆盖）
    storm: true       // 交互请求风暴刹车（治发热）
  };
  var LABELS = {
    stable: '稳定模式（省电）',
    island: '跨岛检测',
    diag: '诊断日志',
    hitfix: '命中兼容',
    players: '角色自保',
    storm: '风暴刹车'
  };

  var cfg = null;
  var listeners = [];

  function read() {
    var out = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage && window.localStorage.getItem(KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k2 in out) {
          if (out.hasOwnProperty(k2) && typeof saved[k2] === 'boolean') out[k2] = saved[k2];
        }
      }
    } catch (e) { /* 隐私模式/无 localStorage：用默认值 */ }
    return out;
  }

  function write() {
    try {
      if (window.localStorage) window.localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) { /* 忽略 */ }
  }

  function notify(reason, name) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](cfg, reason, name); } catch (e) { /* 忽略 */ }
    }
  }

  cfg = read();

  window.MDZCFG = {
    BUILD: BUILD,
    KEY: KEY,
    DEFAULTS: DEFAULTS,
    LABELS: LABELS,

    all: function () {
      var out = {};
      for (var k in cfg) if (cfg.hasOwnProperty(k)) out[k] = cfg[k];
      return out;
    },
    isOn: function (name) { return cfg[name] !== false; },
    isStable: function () { return cfg.stable !== false; },
    /** 取该用哪个采样间隔：稳定模式用省电档 */
    interval: function (normal, stable) {
      return (cfg.stable !== false) ? stable : normal;
    },

    set: function (name, on) {
      if (!DEFAULTS.hasOwnProperty(name)) return false;
      var v = !!on;
      if (cfg[name] === v) return false;
      cfg[name] = v;
      write();
      notify('set', name);
      return true;
    },

    /** 一键稳定模式：只切 stable（各模块按省电档重启自己的定时器） */
    setStable: function (on) { return window.MDZCFG.set('stable', on); },

    reset: function () {
      var changed = [];
      for (var k in DEFAULTS) {
        if (DEFAULTS.hasOwnProperty(k) && cfg[k] !== DEFAULTS[k]) { cfg[k] = DEFAULTS[k]; changed.push(k); }
      }
      write();
      notify('reset', null);
      return changed;
    },

    onChange: function (cb) {
      if (typeof cb === 'function') listeners.push(cb);
      return window.MDZCFG;
    },

    /** 供 UI/排查显示用 */
    describe: function () {
      var on = [], off = [];
      for (var k in DEFAULTS) {
        if (!DEFAULTS.hasOwnProperty(k)) continue;
        (cfg[k] !== false ? on : off).push(LABELS[k] || k);
      }
      return '稳定模式=' + (cfg.stable !== false ? '开' : '关') +
        '；启用：' + (on.join('、') || '无') + (off.length ? '；已关：' + off.join('、') : '');
    }
  };

  try { console.log('[MDZ-CFG] ' + BUILD + ' 已加载：' + window.MDZCFG.describe()); } catch (e) { /* 忽略 */ }
})();
