/* ============================================================================
 * mdz_players.test.js —— 客机角色/背包自保层的行为测试
 * ----------------------------------------------------------------------------
 * 核心行为：在"载入房主世界的前一刻"**同步**把自己的角色/背包交给房主存档
 *          （MPPlayers.checkpoint(true, capture())），这样房主回给你的检查点
 *          就是你自己那份，而不是它的角色/初始状态。
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const MOD = path.join(__dirname, '..', 'web', 'mdz_players.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:8765/index.html' });
  const w = dom.window;

  const logs = [];
  w.MDZUI = { log: (m) => logs.push(String(m)), setStatus: () => {} };

  const mk = (n) => ({ inventory: { items: Array.from({ length: n }, (_, i) => ({ id: i })) } });
  let current = mk(3);                       // 载入前：我自己的 3 件
  const calls = { capture: 0, checkpoint: [] };
  let validationOk = true;

  if (!opts.noPlayers) {
    w.MPPlayers = {
      capture: () => { calls.capture++; return JSON.parse(JSON.stringify(current)); },
      checkpoint: (silent, state) => {
        calls.checkpoint.push({ silent: silent, items: state && state.inventory ? state.inventory.items.length : null });
        return validationOk;
      },
      stats: () => ({ restored: true })
    };
  }

  w.eval(fs.readFileSync(MOD, 'utf8'));
  const P = w.MDZPlayers;
  P.CFG.compareAfterMs = 0;

  return {
    w, P, logs, calls,
    fire: () => w.dispatchEvent(new w.CustomEvent('mdz-mp-before-client-snapshot', { detail: { role: 'client' } })),
    setCurrent: (n) => { current = mk(n); },
    setValidation: (v) => { validationOk = !!v; },
    anyLog: (re) => logs.some((l) => re.test(l))
  };
}

console.log('Mini DAYZ WebRTC —— 客机角色自保层测试');

(async () => {
  /* ------------------------------------ 1. ★ 载入前同步把自己的角色交出去 */
  section('1. ★ 载入房主世界前，同步把自己的角色/背包交给房主存档');
  const e = makeEnv();
  e.setCurrent(3);
  e.fire();
  eq('调用了 checkpoint 一次', e.calls.checkpoint.length, 1);
  eq('silent = true（静默提交，不打断流程）', e.calls.checkpoint[0].silent, true);
  eq('★ 提交的是我自己的 3 件物品', e.calls.checkpoint[0].items, 3);
  eq('记录下基准数量', e.P.state().mineItems, 3);
  ok('日志写明交给房主存档', e.anyLog(/交给房主存档/));
  ok('日志带物品数量', e.anyLog(/物品 3 件/));

  /* -------------------------------------------------- 2. 载入后比对 */
  section('2. 载入后比对：装备保住了要明确报喜');
  await sleep(20);
  ok('报告装备保住', e.anyLog(/装备保住了/), e.logs[e.logs.length - 1]);
  eq('比对次数 +1', e.P.state().checks, 1);
  eq('记录了 restored 状态', e.P.state().lastRestored, true);

  section('3. 载入后数量变了要明确报警（这就是"变初始"）');
  const e2 = makeEnv();
  e2.setCurrent(3);
  e2.fire();
  e2.setCurrent(1);                     // 模拟被房主账本覆盖成 1 件
  await sleep(20);
  ok('报警装备数量变了', e2.anyLog(/装备数量变了/), e2.logs[e2.logs.length - 1]);
  ok('报警里带前后数量', e2.anyLog(/载入前 3 件.*载入后 1 件/));
  eq('载入后数量记录为 1', e2.P.state().afterItems, 1);

  section('4. MOD 校验不通过时要提示"可能仍会丢"');
  const e3 = makeEnv();
  e3.setCurrent(2);
  e3.setValidation(false);
  e3.fire();
  ok('提示 MOD 校验没通过', e3.anyLog(/校验没通过/), e3.logs[e3.logs.length - 1]);

  section('5. 没有 MPPlayers 时优雅跳过');
  const e4 = makeEnv({ noPlayers: true });
  e4.fire();
  ok('提示 MPPlayers 不可用', e4.anyLog(/MPPlayers 不可用|跳过/), e4.logs[e4.logs.length - 1]);
  eq('没有崩溃且没有提交', e4.calls.checkpoint.length, 0);
  eq('状态显示能力不可用', e4.P.state().haveCapture, false);

  section('6. 手动入口 pushNow 可用（排查时用）');
  const e5 = makeEnv();
  e5.setCurrent(5);
  e5.P.pushNow();
  eq('手动提交生效', e5.calls.checkpoint[0].items, 5);

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
