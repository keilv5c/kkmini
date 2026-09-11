/* ============================================================================
 * mdz_island.test.js —— 跨岛/换图重同步协调器的行为测试
 * ----------------------------------------------------------------------------
 * 用 jsdom + 假的 MDZ / MPJoin / MPEntities / MDZP2P 驱动，不需要真机。
 * 覆盖：指纹去抖、房主广播、客机发现不一致→请求、房主重推快照、
 *       客机自己换岛被拉回、载入后校验、失败上限、缺模块时优雅降级。
 *
 * 运行：node test/mdz_island.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ISLAND = path.join(__dirname, '..', 'web', 'mdz_island.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个"设备"：jsdom + 假的世界层/面板层 */
function makeEnv(role, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:8765/index.html' });
  const w = dom.window;

  const logs = [], statuses = [];
  w.MDZUI = { log: (m) => logs.push(String(m)), setStatus: (m) => statuses.push(String(m)) };

  let worldReady = opts.worldReady !== false;
  w.MPEntities = { stats: () => ({ role: role, worldReady: worldReady }) };

  const snap = { count: 0, busy: false };
  w.MPJoin = {
    role: () => (opts.noRole ? null : role),
    sendSnapshot: () => { snap.count++; return true; },
    busy: () => snap.busy
  };

  let fp = { mapHash: 'HASH_A', mapSize: 5000, seed: 'seed-1' };
  if (!opts.noMDZ) {
    w.MDZ = { fingerprint: () => ({ mapHash: fp.mapHash, mapSize: fp.mapSize, seed: fp.seed }) };
  }

  const sent = [];
  const conn = {
    open: true,
    send: (o) => { sent.push(o); return true; },
    on: (evt, cb) => { if (evt === 'data') conn._cb = cb; }
  };
  w.MDZP2P = {
    currentConn: () => conn,
    currentHost: () => (role === 'host' ? {} : null),
    currentClient: () => (role === 'client' ? {} : null)
  };

  w.eval(fs.readFileSync(ISLAND, 'utf8'));
  const I = w.MDZIsland;
  I.stop();                                  // 关掉自动轮询，测试里手动 tick
  I.CFG.worldReadyDelayMs = 0;
  let t = 100000;
  I.CFG.now = () => t;

  return {
    w, I, logs, statuses, sent, conn, snap,
    adv: (ms) => { t += ms; },
    setFp: (h, sz, seed) => {
      fp = { mapHash: h, mapSize: (sz === undefined ? 5000 : sz), seed: (seed === undefined ? 'seed-1' : seed) };
    },
    setWorldReady: (v) => { worldReady = v; },
    fire: (name, detail) => { w.dispatchEvent(new w.CustomEvent(name, { detail: detail || {} })); },
    k: (i) => (sent[i] && sent[i].__mdzIsland ? sent[i].__mdzIsland.k : null)
  };
}

console.log('Mini DAYZ WebRTC —— 跨岛同步协调器测试');

(async () => {
  /* ------------------------------------------------- 1. 房主：广播与去抖 */
  section('1. 房主：地图指纹采样、去抖、广播');
  const h = makeEnv('host');
  {
    const r1 = h.I.tick();
    eq('第一次采样不算稳定（换图过程中指纹会跳）', r1.skip, 'unstable');
    eq('此时不广播', h.sent.length, 0);
    h.I.tick();
    eq('稳定后广播一次心跳', h.sent.length, 1);
    eq('心跳里带 mapHash', h.sent[0].__mdzIsland.h, 'HASH_A');
    eq('心跳里带 mapSize', h.sent[0].__mdzIsland.sz, 5000);
    ok('心跳不带 type 字段（不会被游戏当成游戏包）', !('type' in h.sent[0]));
    ok('消息走独立的 __mdzIsland 命名空间', !!h.sent[0].__mdzIsland);

    h.adv(10000);
    h.setFp('HASH_B');
    h.I.tick();
    eq('指纹跳变那一拍不广播（等它稳定）', h.sent.length, 1);
    h.I.tick();
    eq('稳定后广播新指纹', h.sent.length, 2);
    eq('新指纹内容正确', h.sent[1].__mdzIsland.h, 'HASH_B');
    ok('日志写明了"地图指纹变化"', h.logs.some((l) => l.indexOf('地图指纹变化') >= 0));

    h.adv(20000);
    h.I.tick();
    eq('超过 keepalive 会补发一次（照顾后加入的客机）', h.sent.length, 3);
  }

  /* ------------------------------------------- 2. 客机：没有基准前不动手 */
  section('2. 客机：没收到房主指纹前不该乱发请求');
  const c = makeEnv('client');
  {
    c.I.tick(); c.I.tick();
    eq('没有房主基准时不发包', c.sent.length, 0);
    eq('也不进入同步状态', c.I.state().resyncing, false);
    eq('但本地指纹已经采到了', c.I.state().myHash, 'HASH_A');
  }

  /* ----------------------------------- 3. 客机：发现不一致 → 请求房主重推 */
  section('3. 客机：发现和房主不在同一张图 → 请求重同步');
  {
    c.conn._cb({ __mdzIsland: { k: 'hb', h: 'HASH_HOST', sz: 6000, seed: 's' } });
    eq('发出一次 need 请求', c.sent.length, 1);
    eq('请求类型是 need', c.k(0), 'need');
    ok('请求里带上自己的指纹（便于房主排查）', c.sent[0].__mdzIsland.h === 'HASH_A');
    ok('状态行提示正在同步房主的世界', c.statuses.some((s) => s.indexOf('正在同步房主的世界') >= 0));
    eq('进入 resyncing', c.I.state().resyncing, true);

    c.conn._cb({ __mdzIsland: { k: 'hb', h: 'HASH_HOST' } });
    eq('resyncing 期间不重复刷请求', c.sent.length, 1);
  }

  /* --------------------------------------- 4. 客机：载入房主世界后的校验 */
  section('4. 客机：载入完成后校验指纹，真的对上了才算成功');
  {
    c.setFp('HASH_HOST');            // 载入房主世界后，本地指纹应该变成房主的
    c.I.tick(); c.I.tick();
    c.fire('mdz-mp-world-ready', { role: 'client' });
    await sleep(30);
    eq('退出同步状态', c.I.state().resyncing, false);
    ok('日志报告已同步到房主的世界', c.logs.some((l) => l.indexOf('已同步到房主的世界') >= 0));
    eq('失败计数清零', c.I.state().attempts, 0);
    eq('本地指纹 = 房主指纹', c.I.state().myHash, c.I.state().hostHash);
  }

  /* --------------------------- 5. 客机：自己乱跑换岛 → 也会被拉回来 */
  section('5. 客机：自己换岛（本地指纹变了）→ 被拉回房主那张图');
  {
    const before = c.sent.filter((s) => s.__mdzIsland.k === 'need').length;
    c.adv(10000);
    c.setFp('HASH_C');
    c.I.tick();
    c.I.tick();
    const after = c.sent.filter((s) => s.__mdzIsland.k === 'need').length;
    ok('客机自己换岛也会触发重同步请求', after > before, before + ' -> ' + after);
    ok('日志点明两边指纹不同', c.logs.some((l) => l.indexOf('地图不一致') >= 0));
  }

  /* ------------------------------------- 6. 房主：收到 need → 重推快照 */
  section('6. 房主：收到 need 就重推整张世界快照');
  {
    const h2 = makeEnv('host');
    h2.I.tick(); h2.I.tick();              // 先跑两拍，让协调器挂上通道监听
    h2.conn._cb({ __mdzIsland: { k: 'need', h: 'X' } });
    eq('调用 MPJoin.sendSnapshot() 一次', h2.snap.count, 1);
    ok('日志写明重推世界快照', h2.logs.some((l) => l.indexOf('重推当前世界') >= 0));

    h2.conn._cb({ type: 'player_state', id: 1, x: 2, y: 3 });
    eq('普通游戏包被忽略（不会误触发重推）', h2.snap.count, 1);
    h2.conn._cb({ __mdzIsland: { k: 'hb', h: 'H' } });
    eq('客机发来的心跳在房主侧也不会触发重推', h2.snap.count, 1);

    h2.snap.busy = true;
    h2.conn._cb({ __mdzIsland: { k: 'need' } });
    eq('上一次快照还没发完时不叠加', h2.snap.count, 1);
  }

  /* ------------------------------------------ 7. 失败上限（防死循环） */
  section('7. 连续失败有上限，不会对房主刷屏');
  {
    const f = makeEnv('client');
    f.I.CFG.resyncTimeoutMs = 40;
    f.I.CFG.maxAttempts = 2;
    f.I.tick(); f.I.tick();
    const needCount = () => f.sent.filter((s) => s.__mdzIsland.k === 'need').length;

    f.conn._cb({ __mdzIsland: { k: 'hb', h: 'H1' } });
    eq('第 1 次请求', needCount(), 1);
    await sleep(80);                        // 等超时定时器把 resyncing 放掉
    eq('超时后退出 resyncing（允许重试）', f.I.state().resyncing, false);
    f.adv(10000);
    f.conn._cb({ __mdzIsland: { k: 'hb', h: 'H1' } });
    eq('第 2 次请求', needCount(), 2);
    await sleep(80);
    f.adv(10000);
    f.conn._cb({ __mdzIsland: { k: 'hb', h: 'H1' } });
    eq('达到上限后不再请求', needCount(), 2);
    ok('并给出可操作提示', f.statuses.some((s) => s.indexOf('地图同步失败多次') >= 0) ||
      f.logs.some((l) => l.indexOf('先停手避免死循环') >= 0));
  }

  /* ------------------------------------------------ 8. 优雅降级 */
  section('8. 缺模块/没联机时不崩');
  {
    const n = makeEnv('host', { noMDZ: true });
    const r = n.I.tick();
    ok('游戏还没加载出 MDZ 时不崩', !!r);
    eq('也不发包', n.sent.length, 0);
    eq('原因是没有指纹', r.skip, 'no-fingerprint');

    const none = makeEnv(null);
    eq('没联机角色时直接跳过', none.I.tick().skip, 'no-role');

    const notReady = makeEnv('host', { worldReady: false });
    notReady.I.tick();
    eq('世界还没就绪时不采样', notReady.I.tick().skip, 'world-not-ready');
  }

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('\n测试自身抛错：' + ((e && e.stack) || e));
  process.exit(1);
});
