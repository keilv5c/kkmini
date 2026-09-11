/* ============================================================================
 * mdz_players.js —— 客机角色/背包自保层（外挂式，不改 mp_players.js）
 * ----------------------------------------------------------------------------
 * 真机问题："客机重新进岛/重连后，装备变成了初始（或房主的）"。
 * 单机模式下坐木筏去岛二装备是保留的 → 所以不是游戏设计，是 MOD 的恢复链路。
 *
 * 机制（读 mp_players.js 确认）：
 *   1. 载入房主世界**之前**，MOD 会先存一个"检查点"：
 *        _xd = _x894bd || 本地存档 || 旧值 || capture()
 *      注意它**优先用房主的权威副本**，只有房主没有记录时才退回"抓我自己现在的状态"。
 *   2. 载入之后客机发 mp_player_restore_request，房主回 mp_player_restore，内容就是
 *        store[playerId]     ← 房主为"你"存的那份检查点
 *      房主账本里若是空的/初始的 → 你就变初始 ✗
 *   3. 而 MOD 的 checkpoint(silent, state) 是**可以显式传入状态**的，并且会把它
 *      作为你自己的权威检查点**发给房主存档**（带 revision/transactionId/diff）。
 *
 * 于是修法很直接（全部用 MOD 自己的公开 API）：
 *   在 mdz-mp-before-client-snapshot（= 载入房主世界的前一刻，**必须同步执行**，
 *   因为 mp_join 在派发完这个事件后立刻 loadFromJson）里：
 *     capture() 我自己此刻的角色 → checkpoint(true, 我这份)
 *   ⇒ 房主账本更新成"我的角色/背包"；随后它把检查点还回来时，还的就是我自己那份，
 *     而且我的物品在房主账本里有记录，不会在后续交互里被判"未授权"。
 *
 * 另外：载入后 2.5 秒（等 MOD 的恢复流程走完）比对一次物品数量，把结论写进面板日志 ——
 * 保住没保住一眼可见，不用再靠猜。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-players-1';
  var CFG = {
    captureAtSnapshot: true,   // 载入房主世界前，把自己的角色交给房主存档
    compareAfterMs: 2500,      // 载入后多久比对物品数量（等 MOD 的恢复流程结束）
    debug: true
  };

  function ui(action, a, b) {
    try {
      var U = window.MDZUI;
      if (U && typeof U[action] === 'function') return U[action](a, b);
    } catch (e) { /* 忽略 */ }
    if (action === 'log' && typeof console !== 'undefined' && console.log) {
      console.log('[MDZ-PLAYERS] ' + a);
    }
  }
  function log(m, c) { if (CFG.debug) ui('log', m, c); }

  var st = {
    mine: null, mineItems: null, afterItems: null,
    pushed: 0, checks: 0, lastRestored: null, errors: 0
  };

  function players() { return window.MPPlayers || null; }

  function itemCount(s) {
    try {
      var inv = s && s.inventory;
      if (!inv) return null;
      if (Array.isArray(inv.items)) return inv.items.length;
      if (typeof inv.items === 'number') return inv.items;
      return null;
    } catch (e) { return null; }
  }

  function captureNow() {
    var M = players();
    if (!M || typeof M.capture !== 'function') return null;
    try { return M.capture(); } catch (e) {
      st.errors++;
      log('capture() 失败：' + ((e && e.message) || e), '#ff6b6b');
      return null;
    }
  }

  /**
   * 载入房主世界的前一刻：把自己的角色/背包交给房主存档。
   * ⚠️ 必须**同步**执行：mp_join 派发完这个事件后立刻 loadFromJson，
   *    一旦延后（setTimeout）抓到的就是"房主的世界"了，等于白做。
   */
  function pushMyState() {
    if (!CFG.captureAtSnapshot) return;
    var M = players();
    if (!M || typeof M.capture !== 'function' || typeof M.checkpoint !== 'function') {
      log('MPPlayers 不可用，跳过"把自己交给房主存档"', '#ffcc66');
      return;
    }
    st.mine = captureNow();
    if (!st.mine) return;                       // 可能还没真正联机
    st.mineItems = itemCount(st.mine);
    var ok = null;
    try { ok = M.checkpoint(true, st.mine); } catch (e) {
      st.errors++;
      log('把自己的状态交给房主存档失败：' + ((e && e.message) || e), '#ff6b6b');
      return;
    }
    st.pushed++;
    log('★ 已把自己的角色/背包交给房主存档（物品 ' + st.mineItems + ' 件' +
      (ok === false ? '，但 MOD 校验没通过 → 可能仍会丢' : '') + '）', ok === false ? '#ffcc66' : '#7bd88f');
  }

  function compareAfter() {
    var M = players();
    if (!M || typeof M.capture !== 'function') return;
    var now = captureNow();
    var n = itemCount(now);
    st.afterItems = n;
    st.checks++;
    var s = null;
    try { s = (typeof M.stats === 'function') ? M.stats() : null; } catch (e) { /* 忽略 */ }
    var restored = s ? s.restored : null;
    st.lastRestored = restored;

    if (st.mineItems === null) {
      log('载入房主世界后：物品 ' + n + ' 件（载入前没抓到基准，无法比对）', '#9fe8ff');
      return;
    }
    if (n === st.mineItems) {
      log('✅ 装备保住了：载入前后都是 ' + n + ' 件（MOD restored=' + restored + '）', '#7bd88f');
    } else {
      log('⚠️ 装备数量变了：载入前 ' + st.mineItems + ' 件 → 载入后 ' + n +
        ' 件（MOD restored=' + restored + '）。若少了，把这行连同 [游戏] 开头的行一起发我',
        '#ff9955');
    }
  }

  // 事件监听在加载时就挂（且必须比 mp_players 晚注册 → 后执行 → 覆盖它的检查点）
  try {
    window.addEventListener('mdz-mp-before-client-snapshot', function () {
      pushMyState();                                  // 同步！不要 setTimeout
      setTimeout(compareAfter, CFG.compareAfterMs);   // 等 MOD 恢复流程走完再比对
    });
  } catch (e) { /* 忽略 */ }

  window.MDZPlayers = {
    BUILD: BUILD,
    CFG: CFG,
    captureNow: captureNow,
    pushNow: pushMyState,
    compareNow: compareAfter,
    state: function () {
      return {
        mineItems: st.mineItems, afterItems: st.afterItems,
        pushed: st.pushed, checks: st.checks,
        lastRestored: st.lastRestored, errors: st.errors,
        haveCapture: typeof (players() || {}).capture === 'function',
        haveCheckpoint: typeof (players() || {}).checkpoint === 'function'
      };
    }
  };

  log('客机角色自保层就绪（' + BUILD + '）：载入房主世界前会把自己的角色/背包交给房主存档', '#9fe8ff');
})();
