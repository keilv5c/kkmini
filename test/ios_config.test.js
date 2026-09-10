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

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
