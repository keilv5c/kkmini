/* ============================================================================
 * mdz_island.test.js —— 跨岛检测与"断开重连"行为测试（路线1）
 * ----------------------------------------------------------------------------
 * 关键回归点：**绝不能用整张世界快照做跨岛热同步**。
 *   实测事故：推快照会把房主的角色实例与背包一起搬给客机，反复推送还会污染
 *   "本地角色检查点"，结果客机的装备变成房主的、且因为归属授权卸不下来。
 *   所以本文件除了测"检测→断开→提示重连"，还必须断言 sendSnapshot **一次都没被调用**。
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

function makeEnv(role, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:8765/index.html' });
  const w = dom.window;

  const logs = [], statuses = [];
  w.MDZUI = { log: (m) => logs.push(String(m)), setStatus: (m) => statuses.push(String(m)) };

  let worldReady = opts.worldReady !== false;
  w.MPEntities = { stats: () => ({ role: role, worldReady: worldReady }) };

  const calls = { snapshot: 0, cancel: 0 };
  w.MPJoin = {
    role: () => (opts.noRole ? null : role),
    sendSnapshot: () => { calls.snapshot++; return true; },
    busy: () => false
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
    currentClient: () => (role === 'client' ? {} : null),
    cancel: () => { calls.cancel++; }
  };

  w.eval(fs.readFileSync(ISLAND, 'utf8'));
  const I = w.MDZIsland;
  I.stop();
  let t = 100000;
  I.CFG.now = () => t;

  return {
    w, I, logs, statuses, sent, conn, calls,
    adv: (ms) => { t += ms; },
    setFp: (h) => { fp = { mapHash: h, mapSize: 5000, seed: 'seed-1' }; },
    k: (i) => (sent[i] && sent[i].__mdzIsland ? sent[i].__mdzIsland.k : null),
    fire: (name, detail) => { w.dispatchEvent(new w.CustomEvent(name, { detail: detail || {} })); }
  };
}

console.log('Mini DAYZ WebRTC —— 跨岛检测/断开重连测试');

(() => {
  /* ------------------------------------------------- 1. 房主：采样与去抖 */
  section('1. 房主：指纹采样去抖 + 首次广播');
  const h = makeEnv('host');
  eq('第一次采样不算稳定', h.I.tick().skip, 'unstable');
  eq('此时不广播', h.sent.length, 0);
  h.I.tick();
  eq('稳定后广播一次心跳', h.sent.length, 1);
  eq('心跳类型是 hb', h.k(0), 'hb');
  eq('心跳带 mapHash', h.sent[0].__mdzIsland.h, 'HASH_A');
  ok('心跳不带 type 字段（不会被游戏当游戏包）', !('type' in h.sent[0]));

  /* ------------------------- 2. ★ 房主换岛：断开 + 绝不推快照（回归点） */
  section('2. 房主换岛 → 广播再见 + 断开联机；**绝不重推世界快照**');
  h.adv(10000);
  h.setFp('HASH_B');
  h.I.tick();
  eq('指纹跳变那一拍不动作', h.calls.cancel, 0);
  h.I.tick();
  eq('稳定后发出 bye', h.k(h.sent.length - 1), 'bye');
  eq('断开联机（cancel 被调用一次）', h.calls.cancel, 1);
  eq('★ 没有调用过 MPJoin.sendSnapshot（推快照会把房主装备带给客机）', h.calls.snapshot, 0);
  ok('状态栏明确告诉用户要重新连接',
    h.statuses.some((s) => s.indexOf('重新连接') >= 0 || s.indexOf('重新') >= 0));
  ok('日志解释了原因（跨岛无法热同步）',
    h.logs.some((l) => l.indexOf('跨岛') >= 0 && l.indexOf('角色/背包') >= 0));
  eq('进入已断开状态', h.I.state().aborted, true);
  h.I.tick();
  eq('断开后不再重复动作', h.calls.cancel, 1);

  /* ------------------------------------------- 3. 客机：发现不一致 */
  section('3. 客机：发现和房主不在同一张地图 → 断开并提示重连');
  const c = makeEnv('client');
  c.I.tick(); c.I.tick();
  eq('没收到房主基准前不动作', c.calls.cancel, 0);
  c.conn._cb({ __mdzIsland: { k: 'hb', h: 'HASH_HOST' } });
  eq('第一次不一致只是记数（防误判）', c.calls.cancel, 0);
  c.conn._cb({ __mdzIsland: { k: 'hb', h: 'HASH_HOST' } });
  eq('确认不一致后断开', c.calls.cancel, 1);
  eq('并发 bye 通知房主一起断', c.k(c.sent.length - 1), 'bye');
  eq('客机侧也没推快照', c.calls.snapshot, 0);
  ok('状态提示去同一个岛后重连', c.statuses.some((s) => s.indexOf('重新连接') >= 0));

  /* ------------------------------- 4. 客机自己乱跑换岛也会被判定 */
  section('4. 客机：自己换岛（本地指纹变了）同样判定');
  const c2 = makeEnv('client');
  c2.I.tick(); c2.I.tick();
  c2.conn._cb({ __mdzIsland: { k: 'hb', h: 'HASH_A' } });     // 先对齐
  eq('对齐后不动作', c2.calls.cancel, 0);
  c2.adv(10000);
  c2.setFp('HASH_C');
  // 第 1 拍指纹刚变、还算"不稳定"，不计入；之后两拍都稳定且不一致才判定（防误判）
  c2.I.tick();
  eq('刚变那一拍不计入不一致', c2.I.state().mismatchN, 0);
  c2.I.tick();
  c2.I.tick();
  eq('本地换岛也会断开', c2.calls.cancel, 1);
  ok('日志点明是"你自己这边"', c2.logs.some((l) => l.indexOf('你自己这边') >= 0));

  /* ------------------------------------------- 5. 收到对面的 bye */
  section('5. 收到对面的 bye → 本机也断开');
  const c3 = makeEnv('client');
  c3.I.tick();
  c3.conn._cb({ __mdzIsland: { k: 'bye', why: '房主换岛' } });
  eq('断开一次', c3.calls.cancel, 1);
  ok('提示房主去了别的岛', c3.statuses.some((s) => s.indexOf('别的岛') >= 0));

  /* ------------------------------------------- 6. mode=off 只诊断 */
  section('6. CFG.mode=off：只诊断、不动连接');
  const off = makeEnv('host');
  off.I.CFG.mode = 'off';
  off.I.tick(); off.I.tick();
  off.adv(10000);
  off.setFp('HASH_Z');
  off.I.tick(); off.I.tick();
  eq('不调用 cancel', off.calls.cancel, 0);
  eq('不推快照', off.calls.snapshot, 0);
  ok('只在日志里说明检测到了', off.logs.some((l) => l.indexOf('只做诊断') >= 0));

  /* ------------------------------------------- 7. 手动重连按钮 */
  section('7. 手动「跨岛后重连」');
  const m = makeEnv('host');
  m.I.tick(); m.I.tick();
  ok('reconnectNow 返回 true', m.I.reconnectNow('手动') === true);
  eq('确实断开了', m.calls.cancel, 1);
  eq('依旧不推快照', m.calls.snapshot, 0);

  /* ------------------------------------------- 8. 优雅降级 */
  section('8. 缺模块/没联机时不崩');
  const n = makeEnv('host', { noMDZ: true });
  eq('没有 MDZ 时不崩、跳过', n.I.tick().skip, 'no-fingerprint');
  eq('也不动连接', n.calls.cancel, 0);
  const none = makeEnv(null);
  eq('没角色时跳过', none.I.tick().skip, 'no-role');
  const notReady = makeEnv('host', { worldReady: false });
  notReady.I.tick();
  eq('世界没就绪时跳过', notReady.I.tick().skip, 'world-not-ready');

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
