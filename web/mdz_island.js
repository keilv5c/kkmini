/* ============================================================================
 * mdz_island.js —— 跨岛 / 换图「重同步」协调器（方案B 第一步）
 * ----------------------------------------------------------------------------
 * 为什么需要它（真机现象）：
 *   Mini DAYZ 的 5 个岛都在同一个 `Map` 布局里，靠程序化生成造地形
 *   （generate_array_locations / generate_mapgen_toelements / generate_minimap …）。
 *   而联机层只在**加入时**推一次全量世界快照（mpj_begin/chunk/end + 指纹校验），
 *   协议里没有任何"换岛/换图"消息。于是：
 *     · 房主换岛 → 客机收不到通知，还留在原岛（"图分开了"）
 *     · 客机自己换岛 → 本地随机生成另一张图，和房主对不上 → 看不到对方
 *
 * 做法（不改游戏本体，不碰 mp_*.js 一个字节）：
 *   1. 两端每 2.5 秒采一次 MDZ.fingerprint() 的**地形指纹** mapHash；
 *      连续两次相同才算稳定（换图过程中指纹会跳变）。
 *   2. 房主指纹变了 → 广播心跳 {k:'hb'}（另每 15 秒补一次，照顾后加入的客机）。
 *   3. 客机发现"自己的指纹 ≠ 房主广播的指纹"（不管是房主换了岛，
 *      还是自己乱跑换的岛）→ 发 {k:'need'} 请求重同步。
 *   4. 房主收到 need → 调 MPJoin.sendSnapshot()，把**当前世界整张快照**重推一遍。
 *   5. 客机走现有 mpj_* 加载路径重载世界，mp_join 会重新派发 mdz-mp-world-ready，
 *      各同步模块随之重启 —— 全程复用"加入时"那条成熟路径。
 *
 *   ⇒ 结果：永远只有房主那一张权威地图。客机单独换岛会被自动带回房主所在岛
 *     （符合我们定下的"只允许房主带队换岛"约定）。
 *
 * 为什么敢用"指纹比对"而不是去逆向游戏的"开船/去下一个岛"入口：
 *   · 指纹比对是**内容级**的：不管换图是怎么触发的、谁触发的，只要两张图不一样就会被发现
 *   · 不需要依赖任何游戏内部函数名，游戏改了也不会失效
 *   · 顺便还兜住了"进地堡/室内等其他布局切换"这类同类问题
 *
 * 网络包用独立的 __mdzIsland 命名空间、且不带 type 字段 —— 已验证游戏的消息分发器
 * 对未知包是静默忽略（末尾是一串 if (msg.type === …)），不会报错也不会误处理。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-island-1';
  var CFG = {
    intervalMs: 2500,        // 指纹采样间隔
    stableNeeded: 2,         // 连续多少次采样相同才算"稳定"
    keepaliveMs: 15000,      // 房主即使没变化也定期广播（后加入的客机需要拿基准）
    needCooldownMs: 6000,    // 两次请求之间的最小间隔（防抖，别对房主刷屏）
    resyncTimeoutMs: 30000,  // 请求后多久没等到世界，就判一次失败
    maxAttempts: 4,          // 连续失败上限（防死循环）
    attemptsResetMs: 120000, // 稳定这么久没出问题，就把失败计数清零
    worldReadyDelayMs: 800,  // world-ready 之后等一会儿再校验指纹（让世界真正装载完）
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
    rawHash: null, stableN: 0, fp: null,          // 采样与去抖
    hostHash: null, hostSize: 0, hostSeed: null, hostHashAt: 0,
    sentHash: null, sentAt: 0,                    // 房主上次广播的指纹
    resyncing: false, attempts: 0, attemptAt: 0, decidedAt: 0,
    needAt: 0, resyncTimer: null,
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

  /** 只取地形指纹（mapHash / mapSize / seed），拿不到就返回 null */
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

  /** 通道懒挂载：握手完成、conn 才存在；角色或会话换了要重挂 */
  function attach() {
    if (!window.MDZP2P || !st.role) return false;
    var c = null;
    try { c = window.MDZP2P.currentConn(st.role); } catch (e) { c = null; }
    if (!c || typeof c.on !== 'function') { st.conn = null; st.attached = false; return false; }
    if (c === st.conn && st.attached) return true;
    st.conn = c; st.attached = true;
    try { c.on('data', onData); } catch (e) { st.attached = false; st.conn = null; return false; }
    log('已挂上联机通道（' + st.role + '），开始比对地图指纹', '#9fe8ff');
    return true;
  }

  function send(msg) {
    try {
      if (!st.conn || !st.conn.open) return false;
      st.conn.send({ __mdzIsland: msg });
      return true;
    } catch (e) {
      log('发送失败：' + ((e && e.message) || e), '#ff6b6b');
      return false;
    }
  }

  /* ------------------------------------------------------------ 收包处理 */

  function onData(obj) {
    if (!obj || typeof obj !== 'object' || !obj.__mdzIsland) return;
    var m = obj.__mdzIsland;
    if (!m || typeof m !== 'object') return;
    if (m.k === 'hb') return onHeartbeat(m);
    if (m.k === 'need') return onNeed();
  }

  function onHeartbeat(m) {
    st.hostHash = m.h == null ? '' : String(m.h);
    st.hostSize = Number(m.sz) || 0;
    st.hostSeed = (m.seed == null ? null : String(m.seed));
    st.hostHashAt = now();
    if (st.role !== 'client' || st.resyncing) return;
    var mine = st.fp && st.fp.h;
    if (!mine || !st.hostHash || mine === st.hostHash) return;
    requestResync('房主那张图是 ' + short(st.hostHash) + '，我这边是 ' + short(mine));
  }

  function onNeed() {
    if (st.role !== 'host') return;
    log('客机报告地图不一致 → 重推当前世界的快照', '#ffcc66');
    status('客机地图不一致，正在把当前世界推给它…', '#ffcc66');
    pushWorld();
  }

  /* -------------------------------------------------------- 世界快照重推 */

  function pushWorld() {
    if (st.role !== 'host') return false;
    if (!window.MPJoin || typeof window.MPJoin.sendSnapshot !== 'function') {
      log('MPJoin.sendSnapshot 不可用，无法重推世界（联机脚本没加载？）', '#ff6b6b');
      return false;
    }
    try {
      if (typeof window.MPJoin.busy === 'function' && window.MPJoin.busy()) {
        log('上一次快照还在发，等它发完', '#ffcc66');
        return false;
      }
      window.MPJoin.sendSnapshot();
      log('已开始重推世界快照（分块发送）', '#7bd88f');
      return true;
    } catch (e) {
      log('重推快照失败：' + ((e && e.message) || e), '#ff6b6b');
      return false;
    }
  }

  /* -------------------------------------------------------- 客机请求重同步 */

  function requestResync(why) {
    if (st.resyncing) return false;
    if (st.attempts >= CFG.maxAttempts) {
      log('已连续 ' + st.attempts + ' 次同步失败，先停手避免死循环。可点「重新同步地图」手动再试', '#ff6b6b');
      status('地图同步失败多次：请让房主退回你所在的岛，或双方都重进一次游戏', '#ff6b6b');
      return false;
    }
    if (st.needAt && now() - st.needAt < CFG.needCooldownMs) return false;

    st.resyncing = true;
    st.attempts++; st.attemptAt = now(); st.needAt = now();
    log('地图不一致 → 请求重同步（' + why + '）', '#ffcc66');
    status('检测到和房主不在同一张地图，正在同步房主的世界…', '#ffcc66');

    if (!send({ k: 'need', h: st.fp ? st.fp.h : null })) {
      st.resyncing = false;
      log('请求发不出去（通道未就绪？）', '#ff6b6b');
      return false;
    }
    clearTimeout(st.resyncTimer);
    st.resyncTimer = setTimeout(function () {
      if (!st.resyncing) return;
      st.resyncing = false;
      log('等了 ' + Math.round(CFG.resyncTimeoutMs / 1000) + ' 秒没收到房主的世界快照', '#ff6b6b');
      status('同步超时：房主那边可能正在忙，稍后会自动重试', '#ffcc66');
    }, CFG.resyncTimeoutMs);
    return true;
  }

  /** 世界载入完成（mdz-mp-world-ready）后校验一次：真的对上了吗 */
  function onWorldReady() {
    st.worldReady = true;
    if (st.role !== 'client' || !st.resyncing) return;
    st.resyncing = false;
    clearTimeout(st.resyncTimer);

    var fresh = readFp();
    if (fresh) st.fp = fresh;
    var mine = st.fp && st.fp.h;
    if (st.hostHash && mine && mine !== st.hostHash) {
      log('载入后仍然不一致（我=' + short(mine) + ' 房主=' + short(st.hostHash) + '），再试一次', '#ff6b6b');
      st.needAt = 0;                    // 允许立刻重试
      requestResync('载入的世界与房主指纹仍然不一致');
      return;
    }
    st.attempts = 0;
    log('已同步到房主的世界 ✅（指纹 ' + short(mine) + '）', '#7bd88f');
    status('已同步到房主的世界，继续游戏', '#7bd88f');
  }

  /* ------------------------------------------------------------ 主循环 */

  function tick() {
    var r = moduleRole();
    if (r !== st.role) {
      st.role = r; st.attached = false; st.conn = null; st.sentHash = null; st.sentAt = 0;
      st.hostHash = null; st.resyncing = false; st.attempts = 0;
      if (r) log('联机角色：' + r + '，开始监视地图指纹');
    }
    if (!st.role) return { skip: 'no-role' };
    if (!st.worldReady) {
      if (!worldReadyFlag()) return { skip: 'world-not-ready' };
      st.worldReady = true;
    }
    attach();

    var f = readFp();
    if (!f) return { skip: 'no-fingerprint' };

    // 去抖：换图过程中指纹会连续跳变，连续 stableNeeded 次相同才算稳定
    if (st.rawHash === f.h) st.stableN++;
    else { st.stableN = 1; st.rawHash = f.h; }
    if (st.stableN < CFG.stableNeeded) return { skip: 'unstable' };
    st.fp = f;

    if (st.role === 'host') {
      var changed = (st.sentHash !== f.h);
      var due = !st.sentAt || (now() - st.sentAt >= CFG.keepaliveMs);
      if (changed || due) {
        if (changed && st.sentHash) {
          log('本机地图指纹变化：' + short(st.sentHash) + ' → ' + short(f.h) + '（换岛/换图），通知客机', '#ffcc66');
          status('已换到新地图，正在让客机跟过来…', '#ffcc66');
        }
        send({ k: 'hb', h: f.h, sz: f.sz, seed: f.seed });
        st.sentHash = f.h; st.sentAt = now();
      }
      return { role: 'host', hash: f.h, changed: changed };
    }

    // 客机
    if (!st.hostHash) return { skip: 'no-host-hash-yet' };
    if (f.h === st.hostHash) {
      if (st.attempts && st.attemptAt && (now() - st.attemptAt) > CFG.attemptsResetMs) st.attempts = 0;
      return { role: 'client', hash: f.h, match: true };
    }
    requestResync('本机 ' + short(f.h) + ' ≠ 房主 ' + short(st.hostHash));
    return { role: 'client', hash: f.h, match: false };
  }

  /* ------------------------------------------------------------ 启动 */

  // 事件监听在**加载时**就挂上：不能依赖 DOMContentLoaded 的时序
  // （实测：脚本在 DOMContentLoaded 之后才被求值时，start() 里的监听就永远挂不上）
  try {
    window.addEventListener('mdz-mp-world-ready', function () {
      st.worldReady = true;
      // 稍等一下再校验，让世界真正装载完
      setTimeout(onWorldReady, CFG.worldReadyDelayMs);
    });
    window.addEventListener('mdz-mp-before-client-snapshot', function () {
      log('正在载入房主的世界…', '#9fe8ff');
    });
  } catch (e) { /* 忽略 */ }

  function start() {
    if (st.timer) return;
    if (CFG.autoStart) st.timer = setInterval(tick, CFG.intervalMs);
    log('跨岛同步协调器就绪（' + BUILD + '，每 ' + CFG.intervalMs + 'ms 比对一次地图指纹）', '#9fe8ff');
  }

  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  window.MDZIsland = {
    BUILD: BUILD,
    CFG: CFG,
    start: start,
    stop: stop,
    tick: tick,
    onData: onData,
    pushNow: pushWorld,
    forceResync: function (why) { st.needAt = 0; return requestResync(why || '手动触发'); },
    reset: function () { st.resyncing = false; st.attempts = 0; clearTimeout(st.resyncTimer); },
    state: function () {
      return {
        role: st.role, worldReady: st.worldReady, attached: st.attached,
        myHash: st.fp ? st.fp.h : null, hostHash: st.hostHash,
        mySize: st.fp ? st.fp.sz : 0, hostSize: st.hostSize,
        resyncing: st.resyncing, attempts: st.attempts, errs: st.errs, lastErr: st.lastErr
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
