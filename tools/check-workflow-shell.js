/* ============================================================================
 * tools/check-workflow-shell.js —— 抽出发工作流里的每个 run: 块做 bash 语法检查
 * ----------------------------------------------------------------------------
 * 为什么需要：GitHub Actions 的 run: 是 shell 脚本，写错了要等 20 分钟才在 CI 上炸。
 * Git for Windows 自带 bash，本地就能用 `bash -n` 静态检查每个块。
 *
 * 用法：node tools/check-workflow-shell.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const wfDir = path.join(root, '.github', 'workflows');

function findBash() {
  const cands = [
    'bash', 'bash.exe',
    'D:/Git/bin/bash.exe', 'D:/Git/usr/bin/bash.exe',
    '/bin/bash', '/usr/bin/bash'
  ];
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

const bash = findBash();
if (!bash) {
  console.log('没有找到 bash，跳过 shell 语法检查（在 macOS/Linux 上会正常执行）');
  process.exit(0);
}
console.log('使用 bash: ' + bash);

const files = fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f));
let checked = 0, bad = 0;

for (const f of files) {
  const doc = yaml.load(fs.readFileSync(path.join(wfDir, f), 'utf8'));
  const jobs = doc.jobs || {};
  for (const jobName of Object.keys(jobs)) {
    const steps = jobs[jobName].steps || [];
    steps.forEach((s, i) => {
      if (!s.run) return;
      const label = `${f} :: ${jobName} :: step ${i + 1} (${s.name || '(未命名)'})`;
      // 用 bash -n 只做语法检查（不执行）
      // 注意：`${{ }}` 是 Actions 的模板，先替换成占位符免得 bash 报错
      const body = String(s.run).replace(/\$\{\{[^}]*\}\}/g, 'PLACEHOLDER');
      const r = spawnSync(bash, ['-n'], { input: body, encoding: 'utf8' });
      checked++;
      if (r.status === 0) {
        console.log('  OK   ' + label);
      } else {
        bad++;
        console.log('  FAIL ' + label);
        console.log((r.stderr || '').split('\n').slice(0, 6).map(l => '        ' + l).join('\n'));
      }
    });
  }
}

console.log('');
console.log(`检查了 ${checked} 个 run 块，失败 ${bad} 个`);
process.exit(bad === 0 ? 0 : 1);
