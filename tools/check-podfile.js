/* ============================================================================
 * tools/check-podfile.js —— 守住 ios/App/Podfile 不被 Capacitor CLI 改坏
 * ----------------------------------------------------------------------------
 * 真实事故（CI 上连红三次，每次都是"2 秒红 + 零下载日志"）：
 *
 *   @capacitor/cli/dist/ios/update.js 里用这两个正则重写 Podfile：
 *     podfileContent.replace(/(def capacitor_pods)[\s\S]+?(\nend)/, ...)
 *     podfileContent.replace(/(require_relative)[\s\S]+?(@capacitor\/ios\/scripts\/pods_helpers')/, ...)
 *
 *   第一个正则的起点是"那串触发字符"。当时 Podfile 的注释里恰好写了一句
 *   "...CLI 只定点替换 def capacitor_pods 块和 require_relative..."，
 *   于是匹配起点提前到注释行，把注释后半句 + platform :ios,'15.5' +
 *   use_frameworks! + install! + 真正的定义行全部吃掉，结果：
 *     [!] Invalid `Podfile` file: undefined method `capacitor_pods'
 *   —— pod install 在 1 秒内失败，日志里连一个 pod 都没开始下载，极难定位。
 *
 * 本脚本做两件事：
 *   1. 静态体检：platform 必须在第一行、use_frameworks! / install! / 定义块 / target 齐全、
 *      那串触发字符全文件只能出现一次（就是真正的定义处）、def 与 end 数量平衡。
 *   2. 正则重放：用 CLI 的真实正则把 Podfile 重写一遍，再对结果做同样的体检
 *      —— 只要注释里埋了触发字符，重放结果必然被检出。
 *
 * 用法：node tools/check-podfile.js        （失败退出码 1）
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PODFILE = path.join(ROOT, 'ios', 'App', 'Podfile');
const CLI_UPDATE = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'dist', 'ios', 'update.js');

/* CLI 源码里的两个正则（字面量原文，用来确认上游没改过） */
const CLI_SRC_PODS = String.raw`/(def capacitor_pods)[\s\S]+?(\nend)/`;
const CLI_SRC_REQ = String.raw`/(require_relative)[\s\S]+?(@capacitor\/ios\/scripts\/pods_helpers')/`;
/* 真正拿来重放的（与上面的字面量等价） */
const RE_PODS = /(def capacitor_pods)[\s\S]+?(\nend)/;
const RE_REQ = /(require_relative)[\s\S]+?(@capacitor\/ios\/scripts\/pods_helpers')/;
/* 那串"一旦出现在注释里就会把文件搞坏"的触发字符 */
const TRIGGER = 'def ' + 'capacitor_pods';

let problems = [];
function bad(msg) { problems.push(msg); }

/* ------------------------------------------------------------------ 体检 */
function inspect(text) {
  problems = [];
  const lines = text.split(/\r?\n/);

  // 1. platform 必须是第一行有效内容，且 ≥ 15.5
  const first = lines.find(l => l.trim() !== '' && !/^\s*#/.test(l)) || '';
  if (!/^platform\s+:ios\s*,\s*'([\d.]+)'\s*$/.test(first)) {
    bad(`第一行有效内容必须是 platform :ios, '15.5'，实际是: ${JSON.stringify(first)}`);
  } else {
    const v = parseFloat(/^platform\s+:ios\s*,\s*'([\d.]+)'/.exec(first)[1]);
    if (!(v >= 15.5)) bad(`platform 版本 ${v} < 15.5（GoogleMLKit 8.x 要求 15.5，否则解析期即失败）`);
  }

  // 2. 关键指令齐全
  for (const [needle, why] of [
    ['use_frameworks!', 'Capacitor 插件都是 Swift framework，缺了会编译失败'],
    ["install! 'cocoapods'", '缺少 install! 会丢掉 disable_input_output_paths 的 workaround'],
    ['assertDeploymentTarget', 'post_install 里的部署目标兜底没了']
  ]) {
    if (text.indexOf(needle) < 0) bad(`缺少 ${JSON.stringify(needle)}：${why}`);
  }

  // 3. 触发字符全文件只能出现一次，而且必须是真正的定义行
  const hits = [];
  let from = 0, at;
  while ((at = text.indexOf(TRIGGER, from)) >= 0) { hits.push(at); from = at + TRIGGER.length; }
  if (hits.length === 0) {
    bad(`找不到 ${JSON.stringify(TRIGGER)} 的定义 —— 代码块被删掉了，target 里调用它会报 undefined method`);
  } else if (hits.length > 1) {
    bad(`${JSON.stringify(TRIGGER)} 出现了 ${hits.length} 次：注释里多写一次，cap sync/update 就会从注释处开始吞掉整段（含 platform / use_frameworks!）`);
    for (const pos of hits) {
      const lineNo = text.slice(0, pos).split(/\r?\n/).length;
      const line = lines[lineNo - 1] || '';
      if (!/^def\s+capacitor_pods\s*$/.test(line)) bad(`  第 ${lineNo} 行出现了触发字符但不是定义行: ${JSON.stringify(line.trim())}`);
    }
  } else {
    const lineNo = text.slice(0, hits[0]).split(/\r?\n/).length;
    if (!/^def\s+capacitor_pods\s*$/.test(lines[lineNo - 1] || '')) {
      bad(`触发字符出现在第 ${lineNo} 行、但不是独占一行的定义行: ${JSON.stringify((lines[lineNo - 1] || '').trim())}`);
    }
  }

  // 4. target 'App' 里必须调用这个块
  const ti = lines.findIndex(l => /^target\s+'App'\s+do\s*$/.test(l));
  if (ti < 0) bad("找不到 target 'App' do");
  else if (!lines.slice(ti + 1).some(l => /^\s*capacitor_pods\s*$/.test(l))) {
    bad("target 'App' 里没有调用 capacitor_pods");
  }

  // 5. Ruby 块开闭平衡：def 与 do 都用 end 收尾
  const nDef = lines.filter(l => /^\s*def\s+\S/.test(l)).length;
  const nDo = lines.filter(l => /(^|\s)do\s*(\|[^|]*\|)?\s*$/.test(l)).length;
  const nEnd = lines.filter(l => /^\s*end\s*$/.test(l)).length;
  if (nDef + nDo !== nEnd) {
    bad(`Ruby 块不闭合：def(${nDef}) + do(${nDo}) = ${nDef + nDo} 个开启符，却有 ${nEnd} 个 end`);
  }

  // 6. pods 至少要有 Capacitor / CapacitorCordova
  const podLines = lines.filter(l => /^\s*pod\s+'/.test(l));
  for (const must of ["pod 'Capacitor'", "pod 'CapacitorCordova'"]) {
    if (!podLines.some(l => l.indexOf(must) >= 0)) bad(`缺少 ${must}`);
  }
  if (podLines.length < 2) bad(`pod 行只有 ${podLines.length} 条，Podfile 明显被破坏了`);

  return problems.slice();
}

/* -------------------------------------------------------- 用 CLI 正则重放 */
function replay(text) {
  // CLI 生成 dependenciesContent 的真实行为：以 \n 开头、每行 "  pod '...'\n"、末尾 trimRight
  const block = text.match(/^def capacitor_pods$[\s\S]*?^end$/m);
  if (!block) return { text, ok: false };
  const pods = block[0].split(/\r?\n/).filter(l => /^\s*pod\s+'/.test(l))
    .map(l => (l.startsWith('  ') ? l : '  ' + l.trim()));
  const dependenciesContent = '\n' + pods.join('\n').trimRight();
  let out = text;
  if (RE_PODS.test(out)) out = out.replace(RE_PODS, '$1' + dependenciesContent + '$2');
  if (RE_REQ.test(out)) out = out.replace(RE_REQ, "require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'");
  return { text: out, ok: true };
}

/* ------------------------------------------------------------------ main */
function main() {
  console.log('检查 ios/App/Podfile（Capacitor CLI 正则兼容性）');
  console.log('  ' + PODFILE);

  if (!fs.existsSync(PODFILE)) {
    console.log('  FAIL  Podfile 不存在');
    process.exit(1);
  }
  const raw = fs.readFileSync(PODFILE, 'utf8');

  // 上游正则是否还是那一对（变了就提醒，但不判失败）
  if (fs.existsSync(CLI_UPDATE)) {
    const cli = fs.readFileSync(CLI_UPDATE, 'utf8');
    const a = cli.indexOf(CLI_SRC_PODS) >= 0, b = cli.indexOf(CLI_SRC_REQ) >= 0;
    if (!a || !b) {
      console.log(`  WARN  没能确认 CLI 里仍是那两个正则（pods=${a} require=${b}）`);
      console.log('        升级 @capacitor/cli 后请重读 dist/ios/update.js 的 updatePodfile()');
    } else {
      console.log('  OK    CLI 里仍是那两个正则（重放结果可信）');
    }
  } else {
    console.log('  WARN  node_modules 未安装，跳过上游正则确认（重放仍按已知正则执行）');
  }

  // 1) 当前文件体检
  const problems = inspect(raw);
  if (problems.length === 0) {
    console.log('  OK    当前 Podfile 体检通过');
  } else {
    for (const p of problems) console.log('  FAIL  ' + p);
  }

  // 2) 正则重放后再体检（模拟 cap sync / cap update 之后的状态）
  const r = replay(raw);
  let replayProblems = [];
  if (!r.ok) {
    replayProblems = ['找不到定义块，无法重放'];
  } else if (r.text === raw) {
    console.log('  OK    重放 cap sync/update 后 Podfile 逐字节不变');
  } else {
    replayProblems = inspect(r.text);
    if (replayProblems.length === 0) {
      console.log('  OK    重放后内容有变化但结构完好（属正常的 pods 块重写）');
    } else {
      for (const p of replayProblems) console.log('  FAIL  重放 cap sync/update 后: ' + p);
    }
  }

  // 3) 反向自检：故意在注释里埋触发字符，检查必须报错（证明确实有牙齿）
  const poisoned = raw.replace(/^platform/m,
    '# 故意埋雷：CLI 只定点替换 ' + TRIGGER + ' 块和 require_relative\nplatform');
  const poisonProblems = inspect(replay(poisoned).text);
  if (poisonProblems.length === 0) {
    console.log('  FAIL  自检失效：注释里埋了触发字符却检不出来（本脚本不可信）');
    process.exit(1);
  } else {
    console.log('  OK    反向自检通过（埋雷的 Podfile 会被检出 ' + poisonProblems.length + ' 个问题）');
  }

  const all = problems.concat(replayProblems);
  console.log('');
  if (all.length === 0) {
    console.log('Podfile 检查通过 ✅');
    process.exit(0);
  }
  console.log('Podfile 检查失败 ❌ 共 ' + all.length + ' 个问题');
  console.log('提示：platform :ios, \'15.5\' 必须留在第一行；注释里不要出现那串触发字符。');
  process.exit(1);
}

if (require.main === module) main();

/* 供测试复用（test/ios_config.test.js 会拿 inspect/replay 做回归） */
module.exports = { inspect, replay, TRIGGER, RE_PODS, RE_REQ, CLI_SRC_PODS, CLI_SRC_REQ, PODFILE };
