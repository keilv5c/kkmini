/* ============================================================================
 * mdz_cfg.test.js —— 配置中枢（稳定模式 + 逐模块开关）测试
 * ----------------------------------------------------------------------------
 * 要保证：
 *   · 默认值正确（稳定模式开、修复类模块不能被默认关掉）
 *   · 稳定模式会切到省电档间隔（interval 取省电值）
 *   · 开关能存进 localStorage，重开 App 仍然有效
 *   · 变化会通知各模块（onChange）→ 模块据此 start/stop
 *   · reset 恢复默认；非法名字不生效；没有 localStorage 也不崩
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CFG_FILE = path.join(__dirname, '..', 'web', 'mdz_cfg.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

function makeEnv(saved, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:8765/index.html' });
  const w = dom.window;
  if (saved) w.localStorage.setItem('mdz.cfg.v1', JSON.stringify(saved));
  if (opts.breakStorage) {
    Object.defineProperty(w, 'localStorage', { get() { throw new Error('storage disabled'); } });
  }
  w.eval(fs.readFileSync(CFG_FILE, 'utf8'));
  return { w, C: w.MDZCFG };
}

console.log('Mini DAYZ WebRTC —— 配置中枢测试');

(() => {
  section('1. 默认值：稳定模式开、修复类模块默认全开');
  const a = makeEnv();
  eq('稳定模式默认开', a.C.isStable(), true);
  ['island', 'diag', 'hitfix', 'players', 'storm'].forEach(function (k) {
    eq('默认开启：' + k, a.C.isOn(k), true);
  });

  section('2. 稳定模式切换采样间隔（省电档 vs 排查档）');
  eq('稳定模式下取省电档', a.C.interval(6000, 20000), 20000);
  a.C.setStable(false);
  eq('关掉稳定模式后取排查档', a.C.interval(6000, 20000), 6000);
  eq('isStable 同步为 false', a.C.isStable(), false);
  a.C.setStable(true);

  section('3. 逐模块开关 + 持久化');
  eq('关闭 diag 返回 true（有变化）', a.C.set('diag', false), true);
  eq('isOn(diag) 变 false', a.C.isOn('diag'), false);
  eq('重复设置同一值返回 false', a.C.set('diag', false), false);
  const saved = JSON.parse(a.w.localStorage.getItem('mdz.cfg.v1'));
  eq('已写入 localStorage', saved.diag, false);
  const b = makeEnv(saved);
  eq('重开 App 后仍然是关的', b.C.isOn('diag'), false);
  eq('其它模块保持默认开', b.C.isOn('hitfix'), true);

  section('4. 变化会通知各模块（模块据此 start/stop）');
  const seen = [];
  b.C.onChange(function (all, reason, name) { seen.push(reason + ':' + name); });
  b.C.set('storm', false);
  eq('收到一次通知', seen.length, 1);
  eq('通知里带原因与名字', seen[0], 'set:storm');
  b.C.set('storm', false);
  eq('无变化不通知', seen.length, 1);

  section('5. reset 恢复默认');
  const b2 = makeEnv({ stable: false, diag: false, storm: false });
  eq('先确认被改过', b2.C.isStable(), false);
  const changed = b2.C.reset();
  ok('reset 返回被改回的项', changed.length >= 3, changed.join(','));
  eq('稳定模式回默认开', b2.C.isStable(), true);
  eq('diag 回默认开', b2.C.isOn('diag'), true);
  eq('localStorage 也回默认', JSON.parse(b2.w.localStorage.getItem('mdz.cfg.v1')).diag, true);

  section('6. 非法名字不生效');
  eq('未知模块返回 false', a.C.set('nonexistent', false), false);
  eq('也没被塞进配置', a.C.all().nonexistent, undefined);

  section('7. describe 可读（面板/排查用）');
  const d = makeEnv({ diag: false });
  ok('describe 含稳定模式状态', /稳定模式=开/.test(d.C.describe()), d.C.describe());
  ok('describe 含已关模块', /已关：诊断日志/.test(d.C.describe()), d.C.describe());

  section('8. 没有 localStorage 也不崩（隐私模式等）');
  const e = makeEnv(null, { breakStorage: true });
  ok('仍能拿到默认配置', e.C.isOn('hitfix') === true && e.C.isStable() === true);
  eq('set 不抛错', e.C.set('diag', false), true);

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
