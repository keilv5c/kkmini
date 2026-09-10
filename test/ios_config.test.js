/* ============================================================================
 * ios_config.test.js —— iOS 工程配置的静态校验
 * ----------------------------------------------------------------------------
 * 起因（真机上/CI 上踩到的坑）：扫码插件依赖 GoogleMLKit/BarcodeScanning ~> 8.0.0，
 * 而整条 MLKit 链（GoogleMLKit / MLKitBarcodeScanning / MLKitCommon）的 podspec 都要求
 * **iOS 15.5**；Capacitor 模板给的却是 15.0。CocoaPods 在解析阶段就找不到可用版本，
 * pod install **秒失败**（CI 上表现为 cap sync 那一步 2 秒就红、且没有任何 pod 下载日志），
 * 排查起来非常费劲。这个测试就是为了以后改依赖/升级插件时不再踩。
 *
 * 运行：node test/ios_config.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const podfilePath = path.join(ROOT, 'ios', 'App', 'Podfile');
const pbxPath = path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const barcodePodspec = path.join(ROOT, 'node_modules', '@capacitor-mlkit', 'barcode-scanning',
                                  'CapacitorMlkitBarcodeScanning.podspec');

console.log('Mini DAYZ WebRTC —— iOS 工程配置校验');

/* ------------------------------------------------ 1. Podfile 的平台版本 */
section('1. Podfile 部署目标');
ok('Podfile 存在', fs.existsSync(podfilePath));
const podfileRaw = fs.readFileSync(podfilePath, 'utf8');
// 去掉注释行再匹配：文件顶部的中文说明里也写着 "platform :ios, '15.5'"，不能误匹配到注释
const podfile = podfileRaw.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
const pm = /platform\s*:ios\s*,\s*'([\d.]+)'/.exec(podfile);
ok('能读到 platform :ios', !!pm, pm ? pm[1] : '(没读到)');
const podPlatform = pm ? parseFloat(pm[1]) : 0;

// MLKit 8.x（扫码插件当前依赖）要求 iOS 15.5；表里记录已知的主版本要求
const MLKIT_MIN_IOS = { 6: 15.5, 7: 15.5, 8: 15.5, 9: 15.5 };
let requiredMin = null;
if (fs.existsSync(barcodePodspec)) {
  const spec = fs.readFileSync(barcodePodspec, 'utf8');
  const dep = /dependency\s+'GoogleMLKit\/BarcodeScanning'\s*,\s*'~>\s*(\d+)\./.exec(spec);
  if (dep) {
    const major = parseInt(dep[1], 10);
    requiredMin = MLKIT_MIN_IOS[major] || null;
    console.log(`  扫码插件依赖 GoogleMLKit/BarcodeScanning ~> ${major}.x → 最低 iOS ${requiredMin}`);
  } else {
    console.log('  （没在 podspec 里找到 GoogleMLKit 依赖，跳过交叉校验）');
  }
} else {
  console.log('  （node_modules 未安装，跳过 podspec 交叉校验）');
}
ok('Podfile 平台 ≥ 15.5', podPlatform >= 15.5, 'platform = ' + podPlatform);
if (requiredMin !== null) {
  ok('Podfile 平台满足 MLKit 的最低要求', podPlatform >= requiredMin,
    `${podPlatform} >= ${requiredMin}`);
}

/* ------------------------------------------- 2. Xcode 工程的部署目标一致 */
section('2. Xcode 工程部署目标');
ok('project.pbxproj 存在', fs.existsSync(pbxPath));
const pbx = fs.readFileSync(pbxPath, 'utf8');
const targets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => m[1]);
ok('工程里有部署目标设置', targets.length > 0, targets.length + ' 处');
ok('所有部署目标都一致', new Set(targets).size === 1, [...new Set(targets)].join(', '));
ok('工程部署目标与 Podfile 一致', targets.length > 0 && parseFloat(targets[0]) === podPlatform,
  `pbxproj=${targets[0]} podfile=${podPlatform}`);
ok('关闭了脚本沙箱（Xcode 15+ 必需，否则 CocoaPods 的 [CP] 脚本阶段会失败）',
  /ENABLE_USER_SCRIPT_SANDBOXING = NO;/.test(pbx),
  (pbx.match(/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g) || []).length + ' 处');

/* ------------------------------------------------ 3. 扫码插件的关键配置 */
section('3. 其余 iOS 关键配置');
const infoPlist = path.join(ROOT, 'ios', 'App', 'App', 'Info.plist');
const plist = fs.readFileSync(infoPlist, 'utf8');
for (const key of ['NSCameraUsageDescription', 'NSLocalNetworkUsageDescription', 'NSBonjourServices',
                   'UIRequiresFullScreen', 'UIStatusBarHidden']) {
  ok('Info.plist 含 ' + key, plist.indexOf('<key>' + key + '</key>') >= 0);
}
ok('横屏锁定（不含 Portrait）', plist.indexOf('UIInterfaceOrientationPortrait<') < 0);
ok('共享 scheme 已提交（CI 必需）',
  fs.existsSync(path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme')));
ok('workspace 描述文件已提交',
  fs.existsSync(path.join(ROOT, 'ios', 'App', 'App.xcworkspace', 'contents.xcworkspacedata')));

/* ------------- 4. Podfile 不会被 cap sync/update 的正则改坏（真实事故回归） */
section('4. Podfile 与 Capacitor CLI 正则的兼容性（CI 连红三次的那次事故）');
{
  const podTool = require('../tools/check-podfile.js');
  ok('检查工具 tools/check-podfile.js 可复用', !!podTool && typeof podTool.inspect === 'function');

  const now = podTool.inspect(podfileRaw);
  ok('当前 Podfile 体检通过（platform 首行 / 指令齐全 / 块闭合）', now.length === 0,
    now.join(' | ') || '无问题');

  const rep = podTool.replay(podfileRaw);
  ok('重放 cap sync/update 后 Podfile 逐字节不变', rep.ok && rep.text === podfileRaw);
  const after = podTool.inspect(rep.text);
  ok('重放后体检仍通过', after.length === 0, after.join(' | ') || '无问题');

  // 反向自检：把历史上那句注释再埋回去，必须能复现"定义行被吃掉"
  const poisoned = podfileRaw.replace(/^platform/m,
    '# CLI 只定点替换 ' + podTool.TRIGGER + ' 块和 require_relative\nplatform');
  const mangled = podTool.replay(poisoned).text;
  const mp = podTool.inspect(mangled);
  ok('注释里出现触发字符时会被检出', mp.length > 0, mp.length + ' 个问题');
  ok('埋雷后定义行消失（正是 undefined method 的成因）',
    !/^\s*def\s+capacitor_pods\s*$/m.test(mangled));
  ok('埋雷后 platform 行被吃掉', mangled.indexOf("platform :ios, '15.5'") < 0);

  // 上游没换正则，上面的"重放"才有意义
  const cliUpdate = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'dist', 'ios', 'update.js');
  if (fs.existsSync(cliUpdate)) {
    const cli = fs.readFileSync(cliUpdate, 'utf8');
    ok('@capacitor/cli 仍用那两个正则重写 Podfile（上游未变）',
      cli.indexOf(podTool.CLI_SRC_PODS) >= 0 && cli.indexOf(podTool.CLI_SRC_REQ) >= 0);
  } else {
    console.log('  （node_modules 未安装，跳过 CLI 上游正则确认）');
  }
}

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
