/* ============================================================================
 * test/run-all.js —— 一次跑完三层测试
 *   npm test
 * ==========================================================================*/
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  ['mdz_core（纯逻辑：SDP 打包/裁剪/分块/分流）', 'mdz_core.test.js'],
  ['mdz_p2p（真实 DataChannel 端到端）', 'mdz_rtc.test.js'],
  ['mdz_ui（两个 jsdom 实例走完整 UI 流程）', 'mdz_ui.test.js'],
  ['mdz_selftest（自测页本身：点按钮读页面 PASS/FAIL）', 'mdz_selftest.test.js'],
  ['mdz_page（按 index.html 真实脚本顺序做页面集成检查）', 'mdz_page.test.js'],
  ['mdz_scan（App 内扫码三级链路：WebView -> 原生捆绑模型 -> 文本）', 'mdz_scan.test.js'],
  ['tool_mobileprovision（证书体检：Bundle ID / 类型 / 有效期 / UDID）', 'tool_mobileprovision.test.js']
];

let failed = 0;
for (const [title, file] of suites) {
  console.log('\n########## ' + title + ' ##########');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

// 附加检查：把工作流里的每个 run: 块交给 bash -n 做语法检查（没装 bash 就自动跳过）
console.log('\n########## 工作流 shell 语法检查（bash -n） ##########');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'check-workflow-shell.js')], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('\n==================================================');
console.log(failed === 0 ? '全部测试通过 ✅' : (failed + ' 个测试套件失败 ❌'));
process.exit(failed === 0 ? 0 : 1);
