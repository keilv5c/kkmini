/* ============================================================================
 * mdz_hitfix.test.js —— 「客机打不到怪」兼容层的行为测试
 * ----------------------------------------------------------------------------
 * 覆盖：
 *   · 缓存房主同步过来的实体权威坐标
 *   · 客机上报命中时把 x/y 校正到房主坐标（房主那 120px 位置校验）
 *   · 弹种白名单判定（不在白名单 → 房主必拒，直接告警）
 *   · 房主侧逐条命中的判定（已结算 / 被拒）
 *   · 房主侧"客机位置过期"时补刷新（否则 3000ms 过期会让所有命中被拒）
 *   · 死亡/受伤事件的日志
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HITFIX = path.join(__dirname, '..', 'web', 'mdz_hitfix.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

function makeEnv(role) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:8765/index.html' });
  const w = dom.window;

  const logs = [];
  w.MDZUI = { log: (m) => logs.push(String(m)), setStatus: (m) => logs.push('STATUS: ' + m) };

  let counters = { hitsApplied: 0, hitsRejected: 0, hitsSent: 0 };
  let remotePlayer = null;
  const observed = [];
  w.MPEntities = {
    stats: () => ({ role: role, worldReady: true, counters: Object.assign({}, counters), remotePlayer: remotePlayer }),
    observe: (m) => {
      observed.push(m);
      if (m && m.type === 'player_state') remotePlayer = { x: m.x, y: m.y, receivedAt: Date.now() };
    }
  };

  const sent = [];
  const conn = {
    open: true,
    send: function (o) { sent.push(o); return true; },
    on: (evt, cb) => { if (evt === 'data') conn._cb = cb; }
  };
  w.MDZP2P = {
    currentConn: () => conn,
    currentHost: () => (role === 'host' ? {} : null),
    currentClient: () => (role === 'client' ? {} : null)
  };
  w.MPJoin = { role: () => role };

  w.eval(fs.readFileSync(HITFIX, 'utf8'));
  const H = w.MDZHit;
  H.stop();

  return {
    w, H, logs, sent, conn, observed,
    feed: (o) => conn._cb(o),
    setCounters: (c) => { counters = Object.assign({}, c); },
    bump: (a, r) => { counters.hitsApplied += (a || 0); counters.hitsRejected += (r || 0); },
    setRemote: (x, y, ageMs) => {
      remotePlayer = (x === null) ? null : { x: x, y: y, receivedAt: Date.now() - (ageMs || 0) };
    },
    lastLog: () => logs[logs.length - 1] || '',
    anyLog: (re) => logs.some((l) => re.test(l))
  };
}

console.log('Mini DAYZ WebRTC —— 命中兼容层测试');

(() => {
  /* --------------------------------------------- 1. 客机：缓存房主权威坐标 */
  section('1. 客机：缓存房主同步的实体坐标');
  const c = makeEnv('client');
  c.H.tick();
  eq('挂上通道', c.H.state().attached, true);
  c.feed({ type: 'mp_entity_state', states: [{ id: 'z1', x: 100, y: 200 }, { id: 'z2', x: 300, y: 400 }] });
  eq('缓存了两个实体', c.H.state().knownEntities, 2);
  c.feed({ type: 'mp_entity_add', entity: { id: 'z3', x: 500, y: 600 } });
  eq('新增实体也会缓存', c.H.state().knownEntities, 3);
  c.feed({ type: 'mp_entity_del', id: 'z3' });
  eq('删除实体后缓存移除', c.H.state().knownEntities, 2);

  /* --------------------------------- 2. ★ 命中点校正到房主权威坐标 */
  section('2. ★ 客机上报命中时把命中点校正到房主坐标（过 120px 校验）');
  c.sent.length = 0;
  c.conn.send({ type: 'mp_entity_hit', id: 'z1', bulletType: 't192', bulletUid: 7, x: 180, y: 260 });
  eq('消息仍被发出去', c.sent.length, 1);
  eq('★ x 被校正成房主坐标', c.sent[0].x, 100);
  eq('★ y 被校正成房主坐标', c.sent[0].y, 200);
  eq('弹种等其它字段保持原样', c.sent[0].bulletType, 't192');
  ok('日志说明了校正了多少像素', c.anyLog(/校正了 \d+px/));
  eq('校正计数 +1', c.H.state().coordsRepaired, 1);

  c.conn.send({ type: 'mp_entity_hit', id: 'z1', bulletType: 't192', bulletUid: 8, x: 100, y: 200 });
  ok('坐标本来就一致时不再改写', c.anyLog(/与房主坐标一致/));

  section('3. 没有房主坐标时不动它（但要提示）');
  c.conn.send({ type: 'mp_entity_hit', id: 'zX', bulletType: 't192', bulletUid: 9, x: 11, y: 22 });
  eq('坐标保持原样', c.sent[c.sent.length - 1].x, 11);
  ok('提示没有可校正的坐标', c.anyLog(/没有房主侧坐标可校正/));

  /* --------------------------------- 4. 弹种白名单 */
  section('4. 弹种白名单（不在表里 → 房主必拒）');
  eq('t192 在白名单', c.H.isAllowedAmmo('t192'), true);
  eq('t999 不在白名单', c.H.isAllowedAmmo('t999'), false);
  c.conn.send({ type: 'mp_entity_hit', id: 'z1', bulletType: 't999', bulletUid: 10, x: 100, y: 200 });
  ok('不在白名单时明确告警"房主必拒"', c.anyLog(/不在白名单/));

  /* --------------------------------- 5. 客机侧：确认/受伤/死亡日志 */
  section('5. 客机：把房主的下发翻译成人话');
  c.feed({ type: 'mp_entity_damage', id: 'z1', amount: 25, hp: 40 });
  ok('结算日志含血量', c.anyLog(/房主结算了伤害：id=z1 伤害=25 剩余血量=40/));
  c.feed({ type: 'mp_entity_death', entity: { id: 'z1', x: 100, y: 200 } });
  eq('死亡计数 +1', c.H.state().deathsSeen, 1);
  ok('解释"之后打它会以 phase=dead 被拒"', c.anyLog(/phase=dead/));
  c.feed({ type: 'damage', amount: 12, source: 'zombie', entityId: 'z1' });
  ok('受伤日志说明"没有客户端校验所以必然生效"', c.anyLog(/必然生效/));

  /* --------------------------------- 6. 房主：逐条命中判定 */
  section('6. 房主：每条命中是"已结算"还是"被拒"');
  const h = makeEnv('host');
  h.H.tick();
  h.setCounters({ hitsApplied: 0, hitsRejected: 0 });
  h.bump(1, 0);                                   // 模拟 MOD 已结算
  h.feed({ type: 'mp_entity_hit', id: 'z1', bulletType: 't192', bulletUid: 1, x: 100, y: 200 });
  ok('判定为已结算', h.anyLog(/✅ 已结算/), h.lastLog());
  h.bump(0, 1);                                   // 模拟 MOD 拒绝
  h.feed({ type: 'mp_entity_hit', id: 'z1', bulletType: 't192', bulletUid: 2, x: 100, y: 200 });
  ok('判定为被拒', h.anyLog(/❌ 被房主拒绝/), h.lastLog());
  h.bump(0, 0);
  h.feed({ type: 'mp_entity_hit', id: 'z1', bulletType: 't192', bulletUid: 3, x: 100, y: 200 });
  ok('计数没动时如实说"没看到结算/拒绝"', h.anyLog(/没看到结算\/拒绝计数变化/), h.lastLog());
  eq('收到命中数 3', h.H.state().hitsSeen, 3);

  /* --------------------- 7. ★ 房主侧"客机位置过期"补刷新 */
  section('7. ★ 房主：客机位置过期（>3s 会让所有命中被拒）→ 用缓存的最近位置刷新');
  const h2 = makeEnv('host');
  h2.H.tick();
  h2.setRemote(1000, 1000, 5000);                 // MOD 记的客机位置已过期 5 秒
  h2.feed({ type: 'player_state', x: 1234, y: 5678 });   // 我们自己观察到的最新位置
  h2.setCounters({ hitsApplied: 0, hitsRejected: 0 });
  h2.bump(1, 0);
  h2.feed({ type: 'mp_entity_hit', id: 'z9', bulletType: 't192', bulletUid: 5, x: 1, y: 2 });
  ok('调用了 MPEntities.observe 刷新位置', h2.observed.length > 0 && h2.observed[0].type === 'player_state');
  eq('刷新用的是我们缓存到的坐标', h2.observed[0].x, 1234);
  eq('刷新计数 +1', h2.H.state().hostPosRefreshed, 1);
  ok('日志说明了为什么补刷新', h2.anyLog(/位置已过期/));

  section('8. 位置新鲜时不去打扰 MOD');
  const h3 = makeEnv('host');
  h3.H.tick();
  h3.setRemote(1000, 1000, 100);                  // 很新鲜
  h3.feed({ type: 'player_state', x: 1234, y: 5678 });
  h3.setCounters({ hitsApplied: 0, hitsRejected: 0 });
  h3.bump(1, 0);
  h3.feed({ type: 'mp_entity_hit', id: 'z9', bulletType: 't192', bulletUid: 6, x: 1, y: 2 });
  eq('没有多余的 observe', h3.observed.length, 0);

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
