/* ============================================================================
 * mdz_storm.test.js —— 交互请求风暴刹车的行为测试
 * ----------------------------------------------------------------------------
 * 现场：Interactions.requestsRejected 394 → 932（约每秒 50 次），手机发烫。
 * 期望：客机侧检测到风暴 → reset + setRole + setSender（= 重新拉取全量 bushes）
 *      → 有冷却、有次数上限，治不好要明确报出来；房主侧不动手。
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const MOD = path.join(__dirname, '..', 'web', 'mdz_storm.js');

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

  const logs = [];
  w.MDZUI = { log: (m) => logs.push(String(m)), setStatus: () => {} };

  let rejected = 0, sentCount = 0;
  const calls = { reset: 0, setRole: [], setSender: 0 };
  const wire = [];
  if (!opts.noInteractions) {
    w.MPInteractions = {
      stats: () => ({ requestsRejected: rejected, requestsSent: sentCount, syncsSent: 0 }),
      reset: () => { calls.reset++; },
      setRole: (r) => { calls.setRole.push(r); },
      setSender: (fn) => { calls.setSender++; if (typeof fn === 'function') fn({ type: 'mp_bush_request' }); }
    };
  }

  const conn = { open: true, send: (m) => { wire.push(m); return true; } };
  w.MDZP2P = {
    currentConn: () => conn,
    currentHost: () => (role === 'host' ? {} : null),
    currentClient: () => (role === 'client' ? {} : null)
  };
  w.MPJoin = { role: () => role };

  w.eval(fs.readFileSync(MOD, 'utf8'));
  const S = w.MDZStorm;
  S.stop();

  return {
    w, S, logs, calls, wire,
    bump: (r, s) => { rejected += r; sentCount += (s || 0); },
    anyLog: (re) => logs.some((l) => re.test(l))
  };
}

console.log('Mini DAYZ WebRTC —— 交互请求风暴刹车测试');

(() => {
  /* ---------------------------------------------------- 1. 第一次采样只记基准 */
  section('1. 第一次采样只记基准，不乱刹车');
  const a = makeEnv('client');
  eq('首拍跳过', a.S.tick().skip, 'first-sample');
  eq('没有刹车', a.calls.reset, 0);

  /* ------------------------------------------- 2. ★ 风暴 → 重置并重新拉 bushes */
  section('2. ★ 一个周期被拒 25 次以上 → 重置交互状态并重新拉取 bushes');
  a.bump(30, 30);
  const r = a.S.tick();
  eq('判定为已刹车', r.braked, true);
  eq('调用了 reset', a.calls.reset, 1);
  eq('重新设置了 role=client', a.calls.setRole[0], 'client');
  eq('重新挂了 sender', a.calls.setSender, 1);
  eq('★ sender 挂上后立刻发出全量 bushes 请求', a.wire.length, 1);
  eq('请求类型正确', a.wire[0].type, 'mp_bush_request');
  ok('日志说明了原因与动作', a.anyLog(/交互请求风暴/) && a.anyLog(/重新拉取 bushes/));
  eq('刹车计数 +1', a.S.state().brakes, 1);

  /* ---------------------------------------------------- 3. 冷却期内不重复刹车 */
  section('3. 冷却期内不重复刹车（避免自己制造风暴）');
  a.bump(30, 30);
  const r2 = a.S.tick();
  eq('冷却中', r2.cooling, true);
  eq('没有第二次 reset', a.calls.reset, 1);

  /* ---------------------------------------------------- 4. 正常流量不误伤 */
  section('4. 正常流量（被拒很少）不误伤');
  const b = makeEnv('client');
  b.S.tick();
  b.bump(3, 5);
  const r3 = b.S.tick();
  eq('没有刹车', b.calls.reset, 0);
  eq('只回报差值', r3.rejectedDelta, 3);

  /* ---------------------------------------------------- 5. 有次数上限并明确报出 */
  section('5. 自愈失败有上限，且要明确报出来');
  const c = makeEnv('client');
  c.S.CFG.maxBrakes = 2;
  c.S.CFG.cooldownMs = 0;
  c.S.tick();
  for (let i = 0; i < 4; i++) { c.bump(40, 40); c.S.tick(); }
  eq('刹车次数不超过上限', c.S.state().brakes, 2);
  ok('报出"自愈失败"并要日志', c.anyLog(/风暴自愈失败/), c.logs[c.logs.length - 1]);
  eq('reset 也只做了上限次', c.calls.reset, 2);

  /* ---------------------------------------------------- 6. 房主侧不动手 */
  section('6. 房主侧不刹车（它是权威，重置反而会清掉正确的表）');
  const h = makeEnv('host');
  h.S.tick();
  h.bump(100, 100);
  eq('房主侧跳过', h.S.tick().skip, 'not-client');
  eq('没有 reset', h.calls.reset, 0);

  /* ---------------------------------------------------- 7. 缺模块优雅降级 */
  section('7. 没有 MPInteractions 时不崩');
  const n = makeEnv('client', { noInteractions: true });
  n.S.tick();
  eq('跳过', n.S.tick().skip, 'no-stats');
  eq('没有刹车', n.calls.reset, 0);

  /* ---------------------------------------------------- 8. 手动刹车入口 */
  section('8. 手动刹车入口（排查时用）');
  const m = makeEnv('client');
  m.S.tick();
  eq('手动刹车返回 true', m.S.brakeNow(), true);
  eq('reset 被调用', m.calls.reset, 1);

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
