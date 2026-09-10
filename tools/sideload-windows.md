# 路线 B 实操：无 Mac，用「GitHub 云构建 + Windows 签名安装」拿到 iPhone 上能跑的 App

整体分两段：**① 云端编译出未签名 IPA（GitHub 的 macOS 机器）** → **② Windows 上用自己的 Apple ID 签名并装进 iPhone（Sideloadly）**。

---

## 准备清单

| 需要 | 说明 |
|---|---|
| iPhone | **iOS 15.5+**（MLKit 扫码 pod 的最低要求）；iOS 16+ 还要开"开发者模式"（见第 3 步） |
| Windows 电脑 | 装 **iTunes（必须从 apple.com 下，不要用微软商店版）** —— 它带 Apple 移动设备 USB 驱动；再装 [Sideloadly](https://sideloadly.io/) |
| Apple ID | 免费账号即可（限制见文末）；付费开发者账号 $99/年可 1 年有效 |
| GitHub 账号 | 免费账号的 Actions 每月有额度，公开仓库不限 |

---

## 第 1 步：把仓库推到 GitHub

这个目录已经是 git 仓库、并且已经提交好了（`git log` 能看到 3 个提交）。
只需要加一个远端再推：

```bat
cd /d D:\game_hack\minidayz\Minidayz-WebRTC

:: 先在 GitHub 网页上建一个空仓库（不要勾 README/.gitignore），假设叫 mdz-webrtc
git remote add origin https://github.com/你的用户名/mdz-webrtc.git
git branch -M main
git push -u origin main
```

> 推上去大约 30 MB（`.gitignore` 已经把 `node_modules`、`android/app/build`、`dist/`、`ios/App/Pods` 全部排除）。
> 如果推送要密码，用 GitHub 的 **Personal Access Token**（Settings → Developer settings → Tokens）当密码。

---

## 第 2 步：在 GitHub 上跑工作流

1. 打开仓库页面 → 上方 **Actions** 标签
2. 左侧选 **Build iOS IPA (unsigned)** → 右侧 **Run workflow**
3. 可选填 **bundle_id**：
   - 留空 = 用工程里的 `com.mdz.webrtcmp`
   - **免费 Apple ID 建议填一个你独有的**，例如 `com.你的名字.mdzmp`（界面上的输入框就是干这个的，会自动替换工程里的 Bundle ID）
4. 点绿色 **Run workflow**，等 **10~20 分钟**（第一次要下 MLKit 的 pod，比较久）
5. 跑完后点进这次运行 → 页面底部 **Artifacts** → 下载 **minidayz-unsigned-ipa**（是个 zip，解开就是 `Minidayz-unsigned.ipa`）

日志里会顺便打印校验信息，重点看这几行：

```
OK   NSCameraUsageDescription
OK   NSLocalNetworkUsageDescription
OK   NSBonjourServices
OK   UIRequiresFullScreen
--- 确认 web 代码进包了 ---
   .../mdz_ui.js  .../mdz_p2p.js  .../lan_bridge.js
```

如果哪一行是 `::warning::缺少 ...`，说明 plist 没配好，回来找我。

---

## 第 3 步：Windows 上签名安装（Sideloadly）

1. 手机用数据线连电脑，手机上点「信任此电脑」
2. 打开 **Sideloadly**：
   - **IPA**：把下载好的 `Minidayz-unsigned.ipa` 拖进去
   - **Apple ID**：填你的 Apple ID
   - 点 **Start**，会要你的 Apple ID 密码 + 手机上的双重认证验证码
   - 等它显示 `Done`
3. **手机上信任开发者证书**：
   设置 → 通用 → **VPN 与设备管理** → 点你的 Apple ID → **信任**
4. **iOS 16+ 必须开开发者模式**（否则点开 App 秒退）：
   设置 → 隐私与安全性 → 拉到最底 **开发者模式** → 打开 → 手机会要求重启 → 重启后确认打开
5. 回到桌面，点开「Mini DAYZ 联机版」→ 首次启动会弹**相机权限**和**本地网络权限**，两个都要允许
   （**本地网络必须允许**，否则 WebRTC 局域网直连会失败）

---

## 第 4 步：验证联机

- 打开后应该是**横屏、无状态栏、画面铺满**
- 右上角有联机面板（可拖动）
- 两台 iPhone 同一 Wi-Fi：A 点「房主：创建房间」出二维码 → B 点「客机：加入房间」扫 →
  B 出回码 → A 点「② 房主：扫对方回码」扫 → 双方显示「已连接」
- 扫不上时的退路：二维码浮层上「复制握手串」→ 微信发对方 → 对方粘到对应文本框

---

## 常见报错与解决

| 现象 | 原因 / 解决 |
|---|---|
| `Unable to install ... bundle identifier is already in use` | Bundle ID 被别人占了。**重新跑一次工作流，在 bundle_id 里填一个你独有的**（如 `com.你的名字.mdzmp999`） |
| `Could not find Apple Mobile Device Support` | iTunes 没装或装的是微软商店版。去 apple.com 下桌面版 iTunes 安装 |
| 手机上点开 App 立刻闪退，提示"未受信任的开发者" | 第 3 步第 3 点没做：去 设置 → 通用 → VPN 与设备管理 里信任证书 |
| 点开闪退但没有信任提示（iOS 16+） | 开发者模式没开：设置 → 隐私与安全性 → 开发者模式 → 打开并重启 |
| 用了 7 天后 App 打不开 | 免费 Apple ID 的签名只有 **7 天**有效期。重新用 Sideloadly 装一次（数据不会丢，除非卸载） |
| 提示"已达到 App 数量上限" | 免费账号最多同时 **3 个**自签 App，删掉别的或等一个过期 |
| 联机时一直连不上 | 检查 设置 → 隐私与安全性 → **本地网络** 里本 App 是否允许；两台设备是否同一 Wi-Fi |
| 想省掉每 7 天重签 | 用 **AltStore**（Windows 上装 AltServer，可自动每周后台刷新），或用付费开发者账号（1 年） |

---

## 可选：付费开发者账号（$99/年）能带来什么

- 签名 **1 年**有效，不用每 7 天重签、没有 3 个 App 上限
- 可以走 **TestFlight** 分发给别人测试（无需数据线）
- 可以直接上传 App Store（注意：游戏素材版权归原作者，仅供自用/研究，别上架）
