/* ============================================================================
 * mdz_hitfix.js —— 「客机打不到怪」兼容层 + 命中诊断（外挂式，不改 mp_*.js）
 * ----------------------------------------------------------------------------
 * 现象：房主能打怪，客机怎么打都没用；但怪碰到客机会扣血。
 *
 * 机制（读 mp_entities.js 确认）：
 *   客机本地判定"子弹×僵尸"相交后，发 {type:'mp_entity_hit', id, bulletType,
 *   bulletUid, x, y} 给房主；房主 `_x6f` 逐条校验，任一不过就 hitsRejected++
 *   什么都不做（不扣血、不回包）：
 *     ① 弹种必须在白名单里（29 种，见下 WHITELIST）
 *     ② 实体存在、活着、phase !== 'dead'、有血量变量
 *     ③ 同一颗子弹 1 秒内不能重复命中
 *     ④ 1 秒内最多 60 次命中
 *     ⑤ 上报的命中点必须在**房主侧僵尸位置 120px 内**
 *     ⑥ 客机的 player_state 必须 **不超过 3000ms** 没到房主（否则全拒）
 *     ⑦ 僵尸必须在**房主所知的客机位置 2000px 内**
 *     ⑧ 拿不到血量变量 → 拒
 *   而"怪打客机"走的是另一条路（房主算好直接发 {type:'damage', source:'zombie'}），
 *   没有任何客户端校验 → 所以永远生效。这就是那个不对称。
 *
 * 本模块做的事（都是外挂，不碰原文件）：
 *   1. 缓存房主同步过来的实体权威坐标（mp_entity_add/state/death/reconcile 都带 x/y）；
 *   2. 客机发送 mp_entity_hit 时，把 x/y **校正成房主侧该实体的坐标**
 *      → ⑤ 必然通过（客机看到的是插值位置，这才是被拒的主因之一）；
 *   3. 房主收到 mp_entity_hit 时，如果它记的客机位置已过期（⑥ 会全拒），
 *      就用我们自己缓存的客机最新位置喂一次 MPEntities.observe()，把时间戳刷新；
 *   4. 把**每一条命中的判定结果**（已结算 / 被拒 / 房主宣布僵尸死亡…）打进面板日志，
 *      下次复现就能一眼看出是哪一条校验挂了。
 * ==========================================================================*/
(function () {
  'use strict';

  var BUILD = 'mdz-hitfix-1';
  var CFG = {
    intervalMs: 2000,
    repairHitCoords: true,     // 命中点校正到房主权威坐标
    refreshHostStalePos: true, // 房主侧位置过期时刷新一次
    posFreshMs: 3000,          // 缓存的实体坐标多久算新鲜
    staleMs: 2500,             // 房主侧客机位置超过这个年龄就补刷新（MOD 的硬阈值是 3000）
    debug: true,
    autoStart: true
  };

  // mp_entities.js 里的弹种白名单（_xe5a），不在表里的弹种房主一定拒
  var WHITELIST = {
    t243: 1, t244: 1, t466: 1, t940: 1, t394: 1, t395: 1, t880: 1, t259: 1, t771: 1, t709: 1,
    t273: 1, t882: 1, t923: 1, t280: 1, t192: 1, t883: 1, t245: 1, t204: 1, t188: 1, t562: 1,
    t186: 1, t468: 1, t227: 1, t253: 1, t467: 1, t884: 1, t563: 1, t761: 1, t881: 1
  };

  function ui(action, a, b) {
    try {
      var U = window.MDZUI;
      if (U && typeof U[action] === 'function') return U[action](a, b);
    } catch (e) { /* 忽略 */ }
    if (action === 'log' && typeof console !== 'undefined' && console.log) {
      console.log('[MDZ-HIT] ' + a);
    }
  }
  function log(m, c) { if (CFG.debug) ui('log', m, c); }

  var st = {
    role: null, conn: null, attached: false,
    hostPos: {},            // 客机侧：实体 id -> {x,y,at}（房主权威坐标）
    myPos: null,            // 双方：本机最近一次上报的 player_state 位置
    remotePos: null,        // 房主侧：客机最近一次 player_state（我们自己观察到的）
    lastC: { applied: 0, rejected: 0, sent: 0, initialized: false },
    hits: 0, repaired: 0, refreshed: 0, deaths: 0,
    timer: null
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

  function counters() {
    var z = { applied: 0, rejected: 0, sent: 0 };
    try {
      var s = window.MPEntities && window.MPEntities.stats && window.MPEntities.stats();
      var c = s && s.counters;
      if (c) {
        z.applied = Number(c.hitsApplied) || 0;
        z.rejected = Number(c.hitsRejected) || 0;
        z.sent = Number(c.hitsSent) || 0;
      }
    } catch (e) { /* 忽略 */ }
    return z;
  }

  function noteEntity(e) {
    if (!e || !e.id) return;
    var x = Number(e.x), y = Number(e.y);
    if (!isFinite(x) || !isFinite(y)) return;
    st.hostPos[e.id] = { x: x, y: y, at: Date.now() };
  }

  /* --------------------------------------------------------- 入包处理 */
  function onInbound(obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return;
    var t = obj.type;

    if (t === 'mp_entity_add' || t === 'mp_entity_death') { noteEntity(obj.entity); }
    else if (t === 'mp_entity_state' || t === 'mp_entity_reconcile') {
      if (Array.isArray(obj.states)) for (var i = 0; i < obj.states.length; i++) noteEntity(obj.states[i]);
    } else if (t === 'mp_entity_del') { delete st.hostPos[obj.id]; }

    if (st.role === 'client') {
      if (t === 'mp_entity_damage') {
        log('房主结算了伤害：id=' + obj.id + ' 伤害=' + obj.amount + ' 剩余血量=' + obj.hp, '#7bd88f');
      } else if (t === 'mp_entity_death') {
        st.deaths++;
        log('房主宣布死亡：id=' + (obj.entity && obj.entity.id) +
          '（此后你再打它，房主会以 phase=dead 拒掉 —— 若你还看得到它在咬你，那就是死亡状态没同步干净）', '#ffcc66');
      } else if (t === 'damage' && obj.source === 'zombie') {
        log('你被僵尸打了：伤害=' + obj.amount + '（这条是房主直接下发的，没有客户端校验，所以必然生效）', '#ff6b6b');
      }
    }

    if (st.role === 'host' && t === 'player_state') {
      var x = Number(obj.x), y = Number(obj.y);
      if (isFinite(x) && isFinite(y)) st.remotePos = { x: x, y: y, at: Date.now() };
    }
    if (t === 'player_state') {
      var px = Number(obj.x), py = Number(obj.y);
      if (isFinite(px) && isFinite(py)) st.myPos = { x: px, y: py, at: Date.now() };
    }

    if (st.role === 'host' && t === 'mp_entity_hit') onHostHit(obj);
  }

  /** 房主侧：这条命中被结算了还是被拒了？（对照统计计数） */
  function onHostHit(msg) {
    st.hits++;
    var c = counters();
    var dA = c.applied - st.lastC.applied;
    var dR = c.rejected - st.lastC.rejected;
    var first = !st.lastC.initialized;
    st.lastC = c; st.lastC.initialized = true;

    var inList = !!WHITELIST[msg.bulletType];
    var verdict;
    if (dA > 0) verdict = '✅ 已结算（扣血并回包）';
    else if (dR > 0) verdict = '❌ 被房主拒绝（这一条等于白打）';
    else verdict = first ? '（首次记录，累计值）' : '？没看到结算/拒绝计数变化';

    log('收到客机命中：弹种=' + msg.bulletType + (inList ? '（在白名单 ✓）' : '（⚠ 不在白名单，必被拒）') +
      ' → ' + verdict, dA > 0 ? '#7bd88f' : '#ff9955');

    // ⑥ 客机位置过期会让**所有**命中被拒 —— 用我们观察到的最近位置补刷新一次
    if (CFG.refreshHostStalePos) {
      var rp = null;
      try {
        var s = window.MPEntities && window.MPEntities.stats && window.MPEntities.stats();
        rp = s && s.remotePlayer;
      } catch (e) { /* 忽略 */ }
      var age = rp ? (Date.now() - Number(rp.receivedAt || 0)) : Infinity;
      if (age > CFG.staleMs && st.remotePos && (Date.now() - st.remotePos.at) < 1500) {
        try {
          if (window.MPEntities && typeof window.MPEntities.observe === 'function') {
            window.MPEntities.observe({ type: 'player_state', x: st.remotePos.x, y: st.remotePos.y });
            st.refreshed++;
            log('房主侧记的客机位置已过期 ' + Math.round(age) + 'ms → 用缓存的最近位置刷新一次，避免命中被全拒', '#ffcc66');
          }
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  /* --------------------------------------------------------- 出包改写 */
  function wrapSend(conn) {
    if (!conn || conn.__mdzHitWrapped) return;
    var orig = conn.send;
    if (typeof orig !== 'function') return;
    conn.send = function (msg) {
      try {
        if (msg && typeof msg === 'object' && msg.type === 'mp_entity_hit') {
          var inList = !!WHITELIST[msg.bulletType];
          var p = st.hostPos[msg.id];
          var dist = null;
          if (p && (Date.now() - p.at) < CFG.posFreshMs) {
            dist = Math.sqrt(Math.pow(Number(msg.x) - p.x, 2) + Math.pow(Number(msg.y) - p.y, 2));
            if (CFG.repairHitCoords && dist > 1) {
              st.repaired++;
              msg.x = p.x; msg.y = p.y;
            }
          }
          log('上报命中：弹种=' + msg.bulletType + (inList ? '（白名单 ✓）' : '（⚠ 不在白名单，房主必拒）') +
            (dist === null ? '（没有房主侧坐标可校正）'
              : (dist > 1 ? '（命中点按房主权威坐标校正了 ' + Math.round(dist) + 'px）' : '（与房主坐标一致）')),
            inList ? '#9fe8ff' : '#ff9955');
        }
      } catch (e) { /* 改写失败就用原包发出去，不影响游戏 */ }
      return orig.apply(conn, arguments);
    };
    conn.__mdzHitWrapped = true;
  }

  function attach() {
    if (!window.MDZP2P || !st.role) return false;
    var c = null;
    try { c = window.MDZP2P.currentConn(st.role); } catch (e) { c = null; }
    if (!c || typeof c.on !== 'function') { st.conn = null; st.attached = false; return false; }
    if (c === st.conn && st.attached) return true;
    st.conn = c; st.attached = true;
    try { c.on('data', onInbound); } catch (e) { st.attached = false; st.conn = null; return false; }
    wrapSend(c);
    log('命中兼容层已挂上（' + st.role + '）：房主侧实体坐标缓存 ' + Object.keys(st.hostPos).length + ' 个', '#9fe8ff');
    return true;
  }

  /* --------------------------------------------------------- 主循环 */
  function tick() {
    var r = roleNow();
    if (r !== st.role) {
      st.role = r; st.conn = null; st.attached = false;
      st.hostPos = {}; st.remotePos = null;
      st.lastC = { applied: 0, rejected: 0, sent: 0, initialized: false };
      if (r) log('命中兼容层角色：' + r, '#9fe8ff');
    }
    if (!st.role) return { skip: 'no-role' };
    attach();
    return { role: st.role, entities: Object.keys(st.hostPos).length };
  }

  function start() {
    if (st.timer) return;
    if (CFG.autoStart) st.timer = setInterval(tick, CFG.intervalMs);
    log('命中兼容层就绪（' + BUILD + '）', '#9fe8ff');
  }
  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  window.MDZHit = {
    BUILD: BUILD,
    CFG: CFG,
    WHITELIST: WHITELIST,
    start: start,
    stop: stop,
    tick: tick,
    onInbound: onInbound,
    isAllowedAmmo: function (t) { return !!WHITELIST[t]; },
    state: function () {
      return {
        role: st.role, attached: st.attached,
        knownEntities: Object.keys(st.hostPos).length,
        hitsSeen: st.hits, coordsRepaired: st.repaired, hostPosRefreshed: st.refreshed,
        deathsSeen: st.deaths, counters: counters()
      };
    }
  };

  start();
})();
