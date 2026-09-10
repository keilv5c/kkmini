# iOS / IPA 构建指南

> **先说清楚一件事**：`.ipa` 只能在 **macOS + Xcode** 上编译与签名（Apple 的编译链、iOS SDK、codesign 都只有 macOS 版）。
> 在 Windows 上无法产出 IPA 二进制 —— 但除了"按下编译键"这一步，其余都已在这个仓库里准备好了。

---

## 一、已经准备好的东西

| 项 | 位置 | 说明 |
|---|---|---|
| iOS 工程 | `ios/App/App.xcodeproj` | `npx cap add ios --packagemanager CocoaPods` 生成 |
| CocoaPods 依赖清单 | `ios/App/Podfile` | 扫码插件只有 podspec，所以 iOS 必须用 CocoaPods（SPM 会跳过它） |
| 权限与显示配置 | `ios/App/App/Info.plist` | 相机 / **本地网络** / Bonjour / 横屏锁定 / 全屏 |
| web 资源 | `ios/App/App/public/` | 由 `cap sync ios` 从 `web/` 复制 |
| 云构建工作流 | `.github/workflows/ios-unsigned-ipa.yml` | 用 GitHub 的 macOS 机器产出**未签名 IPA** |

`Info.plist` 里加的关键项（缺一个都跑不起来）：

```xml
<key>NSCameraUsageDescription</key>            <!-- 扫码要相机 -->
<key>NSLocalNetworkUsageDescription</key>      <!-- iOS14+ 局域网直连必填，否则 WebRTC 连不上且不弹权限框 -->
<key>NSBonjourServices</key>                   <!-- WebRTC 的 xxx.local mDNS 候选解析 -->
  <array><string>_webrtc._tcp</string><string>_webrtc._udp</string></array>
<key>UIRequiresFullScreen</key><true/>         <!-- 横屏锁定 -->
<key>UISupportedInterfaceOrientations</key>    <!-- 只留 Landscape Left/Right -->
```

---

## 二、路线 A：有 Mac（最直接）

需要：macOS + Xcode（App Store 装）+ CocoaPods（`brew install cocoapods`）。

```bash
cd Minidayz-WebRTC
npm ci
npx cap sync ios                 # 会顺带跑 pod install，生成 App.xcworkspace
npx cap open ios                 # 打开 Xcode
```

Xcode 里：

1. 选中左侧 **App** 工程 → **Signing & Capabilities** → 勾上 *Automatically manage signing*，
   选你的 Apple ID（免费账号也行，但证书 7 天过期）
2. Bundle Identifier 改成你自己的（例如 `com.yourname.mdzmp`；免费账号不能用别人的）
3. 顶部设备选**真机**（模拟器没有摄像头，扫码测不了）
4. `Product → Run` 装到手机上调试

要出 IPA：

```bash
cd ios/App
# 1) 归档
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath /tmp/App.xcarchive archive

# 2) 导出 IPA（需要 ExportOptions.plist，method 选 development / ad-hoc / app-store）
xcodebuild -exportArchive -archivePath /tmp/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath /tmp/ipa
# /tmp/ipa/App.ipa 就是成品
```

`ExportOptions.plist` 例子（免费/个人开发者用 development）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>development</string>
  <key>teamID</key><string>你的TeamID</string>
  <key>compileBitcode</key><false/>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
```

---

## 三、路线 B：没有 Mac（用云 macOS + Windows 侧装）

思路：**GitHub 的 macOS 机器负责编译出"未签名 IPA"，你在 Windows 上用 Sideloadly + 自己的 Apple ID 签名安装。**

1. 把整个 `Minidayz-WebRTC` 推到 GitHub 仓库（public 免费；private 每月有免费额度）
2. 仓库页面 **Actions → Build iOS IPA (unsigned) → Run workflow**
3. 等 10~20 分钟，从该次运行的 **Artifacts** 下载 `minidayz-unsigned-ipa`（里面是 `Minidayz-unsigned.ipa`）
4. Windows 上装 [Sideloadly](https://sideloadly.io/)（也可用 AltStore / 3uTools）：
   - 用数据线连 iPhone
   - 把 ipa 拖进去，填 Apple ID（免费账号即可）
   - 开始 → 手机上会要求"信任开发者"（设置 → 通用 → VPN与设备管理）
5. **免费 Apple ID 的限制**：签名 7 天有效、最多 3 个 App、每周要重签；
   付费开发者账号（$99/年）可以 1 年有效，并能用 TestFlight 分发。

> 未签名 IPA **不能**直接双击安装，必须经过 Sideloadly/AltStore 这类带签名的工具。

---

## 四、路线 C：付费云构建（最省事，可上架/TestFlight）

[Codemagic](https://codemagic.io/) 或 Ionic Appflow：连上 GitHub 仓库，配置 Apple 开发者账号，
它们会自动处理证书/描述文件，直接产出可分发 IPA 甚至推到 TestFlight。免费额度有限。

---

## 五、iOS 上必须注意的坑（与安卓不同）

1. **本地网络权限**：iOS 14+ 第一次做局域网直连会弹「允许访问本地网络?」，
   必须点允许；如果误点了拒绝，要到 设置 → 隐私与安全性 → 本地网络 里重新打开。
   `Info.plist` 里没有 `NSLocalNetworkUsageDescription` 的话，连弹框都不会出现、直接连不上。
2. **摄像头权限**：扫码第一次会弹相机权限；模式A 的「取消 mDNS 混淆」那一步也会用到相机。
3. **必须在真机上测**：iOS 模拟器没有摄像头，扫码相关功能测不了；WebRTC 在模拟器上也不可靠。
4. **WKWebView 的 WebRTC**：需要 iOS 14.3+（`getUserMedia`）;我们主要走原生 MLKit 扫码 + DataChannel，
   受系统版本影响较小，但建议 iOS 15+。
5. **横屏锁定**：`UIRequiresFullScreen` + 只保留 Landscape，才能在 iPad 上也强制横屏。
6. **免费账号的 Bundle ID**：必须是全局唯一的，`com.mdz.webrtcmp` 可能被占用，改一个自己的。

---

## 六、iOS 上的验证清单

- [ ] 打开就是横屏、无状态栏、画面铺满
- [ ] 右上角出现联机面板，可拖动
- [ ] 点「客机：加入房间」→ 弹相机权限 → 出现原生扫码取景（`原生 MLKit 扫码`）
- [ ] 两台 iPhone 同一 Wi-Fi：一台出二维码、另一台扫 → 双方显示「已连接」
- [ ] 弹「本地网络」权限时点允许（否则连不上）
- [ ] 连上后能看到对方角色移动、物品拾取同步
- [ ] 扫不上时的退路：二维码浮层上「复制握手串」→ 通过微信/QQ 发给对方粘贴
