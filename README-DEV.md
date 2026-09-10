# Mini DAYZ 双模式零服务器 WebRTC 联机 —— 开发说明（DEV）

> 本目录是**副本**，原版目录 `D:\game_hack\minidayz\Minidayz-Multiplayer-main\Minidayz-Multiplayer-main` 一个字节都没有改。
> 校验方法见文末"原版未被改动的证明"。

---

## 一、这套东西是什么

把原来"PeerJS + 中心信令服务器"的联机方式，换成**零服务器的 WebRTC 直连**，并且提供两种握手方式：

| 模式 | 场景 | 握手方式 | ICE |
|---|---|---|---|
| **模式A** `qr` | 面对面、同一 Wi-Fi | 二维码（压缩+base64） | **不配 STUN**，只用 host 候选 |
| **模式B** `text` | 异地、跨网络 | 手动复制粘贴 SDP 文本 | 国内 STUN（miwifi / bilibili / hitv） |

底层统一走 `RTCDataChannel`，全程没有音视频轨道。

### 关键设计决策（都是反查原代码后定的，不是拍脑袋）

1. **不重写 `lan_bridge.js`，而是提供 `window.Peer` 垫片。**
   `lan_bridge.js` 本质是"传输适配层"：它 `new Peer(...)`，然后把手里的 conn 通过
   `setSender()/setConn()` 注入给 `MPNet / MPJoin / MPWorldState / MPEntities / MPPlayers / MPInteractions`。
   它需要的接口只有：

   ```
   Peer : on('open'|'connection') / connect(id) / destroy()
   conn : send(obj) / open / on('open'|'data'|'close'|'error') / close() / bufferSize
   ```

   我们提供 `window.Peer` 顶替 PeerJS，于是 `lan_bridge.js` 和 8 个 `mp_*.js` **一行都不用改**。

2. **`conn.bufferSize` 是隐藏契约。** `mp_join.js` 里用
   `if (typeof conn.bufferSize === "number") return conn.bufferSize;` 做世界快照分块的**背压**。
   垫片把它映射到 `dataChannel.bufferedAmount`，否则游戏会一次性猛灌所有 12000 字节分片。

3. **主通道必须可靠有序。** 游戏自己按 12000 字节分块传世界快照（`mpj_begin/chunk/end` + `fingerprint` 校验），
   全文搜索 `retry` / `nak` **命中 0** —— 丢一片就整份世界数据损坏且无法恢复。
   所以：
   - `mdz_game_sync`：`ordered:true` 可靠有序 —— 默认通道，几乎所有消息走这里
   - `mdz_fast`：`ordered:false, maxRetransmits:0` —— **只**走 `player_state` / `player_visual`（丢一包下一包就覆盖）
   - 回退开关：控制台 `MDZP2P.setFastLane(false)` 可关掉副通道，全部走主通道

4. **模式A 不按内网 IP 过滤候选。** 现代 Chrome/WebView 在页面没有摄像头权限时会做
   **mDNS 混淆**（候选地址是 `<uuid>.local` 而不是 `192.168.x.x`）。按 IP 过滤会把候选全过滤光，
   直接导致模式A 失效。所以：mDNS 候选**也算可用**；只有在"没有任何候选"时才报错并引导切模式B。
   可选增强：`requestCameraForUnobfuscation()`（面板里点「扫对方回码」前会申请一次摄像头权限）能拿到真实内网 IP。

5. **STUN 用的是实测可用的**。2026-09 本机 UDP 实测：`stun.qq.com` **已超时失效**（需求文档里写的是它），
   可用的是 `stun.miwifi.com` / `stun.chat.bilibili.com` / `stun.hitv.com`。

6. **握手串体积实测**（决定二维码密度，见 `npm run test:core` 输出）：
   模式A 约 **512–526 字符**，模式B 约 **600–707 字符**，都远低于单张二维码上限 2953 字节 → 二维码很好扫。

---

## 二、目录结构

```
Minidayz-WebRTC/
├─ web/                         ← 游戏本体副本 + 新增代码（Capacitor 的 webDir）
│  ├─ index.html                ← 只改了两处：去掉 peerjs.min.js、加入新脚本
│  ├─ lan_bridge.js             ← 与原版逐字节一致（未改动）
│  ├─ mp_*.js / c2runtime.js …  ← 与原版逐字节一致（未改动）
│  ├─ mdz_core.js               ← 新增：纯逻辑（SDP 打包/裁剪、候选分析、分块、分流）可 Node 单测
│  ├─ mdz_p2p.js                ← 新增：WebRTC 传输层 + window.Peer 垫片 + 双通道
│  ├─ mdz_ui.js                 ← 新增：双模式面板（二维码 / 摄像头 / SDP 文本框）
│  ├─ mdz_selftest.html         ← 新增：单机自测页（不需要第二台设备）
│  └─ vendor/{pako,qrcode,html5-qrcode}.min.js   ← 本地化依赖，不依赖 CDN
├─ test/                        ← 三层测试（见第五节）
├─ tools/make-vendor.js         ← 重新生成 vendor/（npm run vendor）
├─ android/                     ← Capacitor 生成的 Android 工程（已配好相机权限）
├─ capacitor.config.ts
└─ _original_manifest.csv       ← 原版目录的 SHA256 清单（留证）
```

---

## 三、跑网页版（开发/调试）

```bat
cd /d D:\game_hack\minidayz\Minidayz-WebRTC
npm run web
```
然后浏览器打开：

- 游戏：<http://localhost:8765/index.html>
- **自测页（推荐先跑这个）**：<http://localhost:8765/mdz_selftest.html>

### ⚠️ 看不到联机面板 / 找不到扫码入口？（踩过两次的坑）

游戏的 `sw.js` 是**离线缓存 Service Worker**，它会把 `index.html` 一起缓存。
如果你之前用旧页面打开过这个地址，之后刷新拿到的还是**旧 index.html**——
表现就是：游戏能玩、原版面板（Room ID / HOST / JOIN）在，但**右上角没有我们的联机面板**。

判断方法：按 F12 看控制台，**没有 `[MDZ] build mdz-webrtc-web-1 已加载` 就是缓存住了**。

三种解法（任选）：

1. 加个查询参数强制走网络：`http://localhost:8765/index.html?v=2`
2. DevTools → **Application → Service Workers → Unregister** → 再 Ctrl+Shift+R（最彻底）
3. 用无痕窗口打开

现在 `index.html` 里已经加了**自动注销旧 Service Worker + 禁用注册**的代码，
清一次之后就不会再被缓存坑到了（想恢复离线单机，把 `index.html` 末尾那段删掉即可）。

### 扫码入口在哪？

**不在游戏里，也没有游戏内图标**——入口就是我们注入的联机面板（固定在**右上角**）：

- 房主：面板上点「① 房主：创建房间」→ 面板里出现**房间二维码**
- 客机：面板上点「① 客机：加入房间」→ 面板里出现**摄像头预览框**去扫房主的码
- 点完之后才会出现二维码 / 摄像头区域，没点之前是隐藏的

游戏自带的那个原版面板（Room ID / HOST / JOIN / DISCONNECT）也**能用**：
点它的 HOST/JOIN，我们的面板会自动展开并接手（已适配并测过，见测试第 8 节）。

> 网页端注意：`http://localhost` 属于安全上下文，所以**网页也能用模式A 扫码**（会按需加载 html5-qrcode）。
> 但如果用 `http://192.168.x.x` 打开，浏览器会禁用摄像头 → 面板会自动切到模式B。

自测页在**同一个页面**里开两个 RTCPeerConnection，跑完整握手 + 双通道 + 收发 + 大消息分块，
不需要第二台设备就能确认传输层是否正常（会打印 PASS/FAIL 列表）。

### 两台设备实测联机

**先用两个浏览器在本机做一次冒烟测试**（不需要第二台设备，能验证 90% 的链路）：
Chrome 开一个窗口当房主，Edge 开一个窗口当客机（**必须是两个不同浏览器**，同一浏览器的两个标签页会共用存档，容易互相干扰），
走「异地文本 SDP」流程粘贴一次即可。

真正的双设备：

1. 两台设备都打开游戏页面（局域网可用 `http://本机IP:8765/index.html`；异地需要把 8765 暴露出去，或用 App）
2. 双方在同一 Wi-Fi：选 **面对面扫码联机**
   - 房主点「① 房主：创建房间」→ 屏幕出现房间二维码
   - 客机点「① 客机：加入房间」→ 扫码 → 出现回码
   - 房主点「② 房主：扫对方回码」→ 扫客机的回码 → 自动连上
   - **如果二维码里只有 mDNS 候选**（面板会提示），或扫完连不上：房主点「②b 只拿到 mDNS：授权摄像头后重出码」，
     授权一次摄像头权限后重新出码，这时 Offer 里会带真实内网 IP（`192.168.x.x`），局域网直连更稳，再让客机扫一次
3. 异地：选 **异地文本 SDP 联机** → 房主「创建房间」把 Offer 复制发微信 → 客机粘贴后点「生成 Answer」→ 把 Answer 发回 → 房主粘贴后点「③ 确认 Answer 建立连接」

连接成功后，游戏原本的玩家/物品同步会自动开始（`lan_bridge.js` 收到 `connection` 事件后接管）。

---

## 四、Capacitor / 打包 APK

依赖与 Android 工程**已经生成好了**（`android/` 目录），相机权限也已写入 `AndroidManifest.xml`。
本机目前**没有 Android SDK / Android Studio，只有 JDK 1.8**（Capacitor 8 需要 JDK 17+），所以没有执行构建。

要出 APK，需要先装 Android Studio（自带 JDK 17 + SDK），然后：

```bat
npm run sync                 :: cap sync android（把 web/ 同步进 Android 工程）
npx cap open android         :: 用 Android Studio 打开，Build APK
```

iOS（需要 macOS）：`npx cap add ios` 之后，在 `ios/App/App/Info.plist` 里加：

```xml
<key>NSCameraUsageDescription</key>
<string>用于扫描房间二维码以建立局域网联机</string>
```

Android 已加好的权限（`android/app/src/main/AndroidManifest.xml`）：
`INTERNET`、`ACCESS_NETWORK_STATE`、`CAMERA`，以及 `uses-feature camera required=false`（无摄像头设备也能装，自动退化到模式B）。

**App 内扫码走原生插件** `@capacitor-mlkit/barcode-scanning`（已在依赖里，`npx cap add android` 时已被识别），
不用 WebView 的 `getUserMedia` —— 后者在 Android/iOS WebView 里不可靠
（参考 [html5-qrcode#544](https://github.com/mebjas/html5-qrcode/issues/544)、[capacitor#6759](https://github.com/ionic-team/capacitor/issues/6759)）。
网页端才用 html5-qrcode 兜底。

---

## 五、测试（`npm test`，共 167 项，当前全绿）

| 套件 | 跑什么 | 结果 |
|---|---|---|
| `test/mdz_core.test.js` | SDP 打包/解包（含换行/截断/校验和损坏）、裁剪失败降级、候选分类（mDNS/内网/CGNAT/link-local）、代理对安全切片、分块乱序重组、消息分流、握手串体积实测 | **46/46** |
| `test/mdz_rtc.test.js` | 用 `node-datachannel` 跑**同一份** `mdz_p2p.js`：模式A/模式B 真实握手、双向收发、副通道、60000 字符分块、`bufferSize`、**完全照抄 lan_bridge.js 调用顺序驱动垫片**、漏调 `clientBegin` 的容错、模式切换状态隔离 | **34/34** |
| `test/mdz_ui.test.js` | 两个 jsdom"设备"按 index.html 顺序加载脚本，模拟 lan_bridge 的 `startHost/joinGame`，用 UI 按钮走完文本 SDP 全流程，验证游戏包双向互通；外加**走游戏原面板 HOST/JOIN 入口**也能拉起我们的面板 | **32/32** |
| `test/mdz_selftest.test.js` | **测自测页本身**：把 `mdz_selftest.html` 装进 jsdom、点"运行自测"、读页面上的 PASS/FAIL，确保页面自己跑得通 | **13/13** |
| `test/mdz_page.test.js` | **按 index.html 的真实脚本顺序**做页面集成检查：所有 script 都能加载、`window.Peer` 被垫片接管、构建标记存在、联机面板真的出现在页面上、SW 已被禁用、**可点击性审计（pointer-events 继承）**、收起→再打开、**mDNS 兜底按钮真的会申请摄像头** | **26/26** |
| `test/mdz_scan.test.js` | **App 内扫码三级链路**：WebView 内嵌扫码 → 原生 `startScan`（捆绑模型）→ 才切文本模式；并验证"原生报 GMS 模块缺失时不会再掉进模式B" | **16/16** |

单独跑：`npm run test:core` / `test:rtc` / `test:ui`；自测页：`node test/mdz_selftest.test.js`；页面集成：`node test/mdz_page.test.js`；看握手细节：`set MDZ_VERBOSE=1 && node test/mdz_rtc.test.js`。

> 历史坑（都已修，且都有回归测试守着）：
> 1. `mdz_selftest.html` 曾漏掉 `MDZP2P.clientBegin()` 就直接 `clientAcceptHost()`，浏览器里点"运行自测"会报 `当前没有等待握手的客机会话`。现在 API 层会自动补建客机会话，页面也改成标准顺序。
> 2. 游戏 `sw.js` 会把 `index.html` 缓存住，导致改完代码刷新还是旧页面（没有联机面板）。现在 `index.html` 末尾会自动注销旧 SW 并禁止注册，控制台也会打印构建标记便于分辨。
> 3. **`pointer-events` 是继承属性**：面板容器为了不挡住游戏画布设了 `pointer-events:none`，挂在它下面的"☰ 联机面板"小按钮如果自己不写 `pointer-events:auto`，就会**点不动**（收起后再也打不开）。因为 jsdom 的 `.click()` 不检查 CSS 命中测试，所以专门加了"沿祖先链审计 pointer-events"的检查来守住这类问题。

**尚未验证的部分（必须真机/真浏览器做）**：
1. 两台真实设备之间的 P2P 打洞（本机测试是同机 loopback）
2. 二维码用真实摄像头扫（自测页可以生成真二维码，用手机相机扫一下即可）
3. Capacitor App 内原生扫码插件
4. 异地（跨 NAT）模式B 的成功率 —— 没有 TURN，对称 NAT 下会失败

---

## 六、已知限制 / 后续可做

1. **没有 TURN**：异地联机在对称 NAT 下会打洞失败。要稳定就自建 coturn，然后在 `mdz_p2p.js` 的 `CFG.STUN_TEXT` 旁边加 `turn:` 配置。
2. **单侧扫码依赖摄像头权限**：模式A 房主侧若只有 mDNS 候选且连不上，可让房主也允许一次摄像头权限（面板会申请）拿真实内网 IP。
3. **服务端零依赖**：原来的 `mdz-server/node` 信令服务器**在这套方案里完全不需要**了，可以不启动。
4. `web/peerjs.min.js` 文件仍在目录里，但 `index.html` 已不再加载它（保留是为了对照/回退）。
5. `capacitor.config.ts` 会触发一条 `MODULE_TYPELESS_PACKAGE_JSON` 警告，属正常现象（加 `"type":"module"` 会破坏 CommonJS 测试脚本，故不加）。

---

## 七、已完成：Android APK 构建（2026-09-10）

### 产物

| 项 | 值 |
|---|---|
| APK | `Minidayz-WebRTC\dist\Minidayz-WebRTC-debug.apk`（同时保留在 `android\app\build\outputs\apk\debug\app-debug.apk`） |
| 大小 | **51.3 MB** |
| SHA256 | `C942A84A9E80CD02563B78F209B89226A74AEFBC046585F83BA0797FBDA0230E` |
| 包名 / 标签 | `com.mdz.webrtcmp` / 「Mini DAYZ 联机版」 |
| minSdk / targetSdk | 24 / 36（compileSdk 36） |
| 屏幕方向 | `android:screenOrientation="sensorLandscape"`（横屏锁定）+ 主题 `windowFullscreen` + `viewport-fit=cover` |
| 插件 | barcode-scanning 8.2.1 / camera 8.2.4 / status-bar 8.0.3 |
| 签名 | Android Debug 证书（可正常安装，不能上架） |
| 构建耗时 | 首次 12m17s；增量 1m06s |

### App 内扫码的三级链路（真机 bug 修复）

真机上点「客机：加入房间」时曾直接掉进模式B，日志显示：

```
原生扫码失败/被拒绝：The Google Barcode Scanner Module is not available.
You must install it first using the installGoogleBarcodeScannerModule method.
```

原因：`@capacitor-mlkit/barcode-scanning` 提供**两套**接口 ——

| 接口 | 底层 | 是否需要 Google Play 服务 |
|---|---|---|
| `scan()` | Google Code Scanner (`play-services-code-scanner`) | **需要**，首次要下载模块；国内无 GMS 的手机必然失败 |
| `startScan()` + `barcodesScanned` | 捆绑 MLKit 模型 (`com.google.mlkit:barcode-scanning`) + CameraX | **不需要**，完全离线 |

我当时用的是 `scan()`，所以踩坑。现在的链路是：

1. **WebView 内嵌扫码**（html5-qrcode，优先使用平台的 BarcodeDetector）—— 离线、无 GMS 依赖、预览就在面板里（Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 会为 `VIDEO_CAPTURE` 申请并授予 CAMERA 权限，所以 WebView 摄像头可用）
2. **原生 `startScan()`**（捆绑模型）—— WebView 方案失败时启用；原生预览画在 WebView 后面，所以会临时把游戏画面/面板隐藏、背景设为透明
3. **文本模式** —— 前两条都失败才切，并且**把失败原因留在状态行上**（之前 `switchMode` 会把原因覆盖掉，用户看不到为什么掉进模式B）

> 历史坑 #4：`scan()` 需要 GMS 模块、`startScan()` 不需要；不要再改回 `scan()`。
> 历史坑 #5：切换模式会重写状态行，自动降级时必须**在 switchMode 之后**再写一次原因。

### 真机"二维码放框里完全没反应"的排查与修复

症状是**既不快也不慢、一帧都不回调**，这排除了"二维码太密识别慢"，指向回调压根没被调用。两个已知成因都已修：

1. **`useBarCodeDetectorIfSupported` 静默失败**：安卓 WebView 里 `window.BarcodeDetector` 存在，但底层 MLKit 模块缺失时 `detect()` 永远不返回结果，html5-qrcode 会**一帧都不回调**。
   → 现在该开关**默认关闭**（`state.useBarcodeDetector = false`），走 ZXing；要试可手动打开。
2. **选到了前置摄像头**：约束只写软性 `facingMode:'environment'` 时，部分安卓 WebView 会选前摄——用户对着屏幕永远扫不到。
   → 现在先 `enumerateDevices()` 按标签挑 `back/rear/后置`，再依次降级
   `deviceId(exact)` → `facingMode(exact environment)` → `facingMode(environment)` → 任意摄像头，并把**选中的摄像头标签和取景分辨率打进日志**。

配套改进：

- **App 内改为优先原生 `startScan`**（MLKit 捆绑模型对密集二维码识别率远高于 ZXing），WebView 作为备选；顺序可用「换个扫码方式」按钮手动对调。
- **8 秒看门狗**：未识别时给出可操作提示，并区分两种情形 ——
  `摄像头没有输出画面（可能选到了前置摄像头或被占用）` vs `已分析 N 帧仍未识别（让二维码更大更清晰）`。
  这直接区分了"没画面"和"解码不出来"，是上次无法判断的关键信息。
- **二维码画大**：显示房间二维码时面板临时加宽，画布按窗口宽度取 `280–600px`（原来固定 300px），
  取景框从 78% 提到 85%。密集 QR 的模块像素越大越好扫。
- 每 60 帧打一条 `已分析 N 帧仍未识别` 日志，方便远程定位。

### 二维码显示方式（小屏适配）+ 面板可拖动

- **二维码改成全屏居中浮层**（不再塞进侧边面板）。原因：横屏手机的面板只有 `~92vh ≈ 400px` 高，
  塞进面板里的二维码会被裁掉，对端摄像头看到的是半个码（用户报过"二维码太大超出屏幕"）。
  现在浮层尺寸按 `min(视口宽, 视口高)` 算；**屏幕高度 < 620px 时进入极简模式**：
  标题/提示/说明全部隐藏，只留右上角一个「收起」按钮，把整屏高度让给二维码。
  实测 800×400 的横屏手机上二维码可显示到约 374px（89 个模块 → 每格约 4.2px）。
- **纠错等级 M → L**：同样内容模块数 101×101 → **89×89**（用真实 qrcode 库实测），每格像素更大，小屏更友好。
- **候选瘦身** `Core.trimCandidates(sdp, 2)`：同一台机器的多个 host 候选是等价备选，每行却要占约 110 字符，
  模式A 每类只留优先级最高的 2 个（模式B 留 3 个），实测手串 629 → 603 字符。瘦身后若候选为空则自动回退。
- **联机面板可拖动/悬浮**：拖标题栏或收起后的「☰ 联机面板」小按钮即可移动，位置存 `localStorage`，
  下次打开还在原处；底部「重置面板位置」一键回到右上角。这样面板挡住游戏角落按钮（例如取消键）时能拖开。
  拖动超过 6px 才算拖动，未拖动仍然是普通点击；拖动结束后会屏蔽一次 click，避免误触发展开/收起。

### 电脑（网页端）扫不上手机屏幕上的二维码

日志能看出关键区别：`已分析 720 帧，仍未识别到二维码` = **摄像头有画面、解码器在跑，但解不出来**。
电脑上失败的原因有三个，都已处理：

1. **分辨率太低**：html5-qrcode 默认拿到的 stream 可能只有 640×480，89×89 的二维码摊到上面每格不到 2px，
   ZXing-JS 必然失败。现在约束里明确要求 `width/height: {ideal: 1920×1080}`，并会打印实际
   `取景分辨率：1920x1080`（低于 640 宽会直接提示改用文本）。
2. **`qrbox` 把画面裁掉了**：之前设了 `qrbox`，只扫中间一块；二维码稍偏一点就永远扫不到。现在**不设 qrbox**，全画面扫描。
3. **Windows 版 Chrome 没有 `BarcodeDetector`**（只有 Android/ChromeOS/macOS 有），只能退回 ZXing-JS，对密集码偏弱。
   现在桌面浏览器**能用 BarcodeDetector 就自动启用**（App 的 WebView 里仍强制关闭，因为那里它会静默失败）。
   html5-qrcode 加载不上时另有按需加载与降级。

**兜底（最可靠，已内置）**：握手串本来就是一段文本，二维码只是载体，**两种模式都显示文本握手区**，
二维码浮层里也加了「复制握手串（对方扫不上时用文本）」按钮。所以电脑和手机联机的推荐流程是：

- 电脑当房主出大二维码 → **手机扫码**（这条稳）→ 手机生成 Answer 后点「复制握手串」→ 用微信/QQ 发回电脑 →
  电脑粘到 Answer 框点「③ 确认 Answer 建立连接」。**只需传一次文本**。
- 或者两边都用文本模式：电脑复制 Offer → 发手机 → 手机生成 Answer → 发回电脑 → 完成。

### 本机装的工具链（解压式，不污染系统）

```
<workspace>\tools\jdk21\            Temurin JDK 21.0.12.1（Capacitor 8 要求 Java 21）
<workspace>\tools\android-sdk\      cmdline-tools + platform-tools + platforms;android-36 + build-tools;36.0.0
<workspace>\tools\env.ps1           环境变量脚本（build-apk.ps1 会 dot-source）
```

两个脚本（都在 `Minidayz-WebRTC\tools\`，**必须保持 UTF-8 with BOM**，否则 PowerShell 5.1 会按 ANSI 读、中文乱码）：

```powershell
powershell -File tools\setup-android-toolchain.ps1   # 一次性：下载并安装 JDK21 + Android SDK
powershell -File tools\build-apk.ps1                 # 每次改完代码：cap sync + 构建 + 校验产物
powershell -File tools\build-apk.ps1 -Variant Release # 出 release（未签名，需自己配 keystore）
```

### 产物校验结果（脚本自动做）

- `uses-permission`: INTERNET / ACCESS_NETWORK_STATE / **CAMERA**
- `uses-feature-not-required: android.hardware.camera` → 没有摄像头的设备也能装（会自动退化到模式B）
- APK 内 `assets/public/`：**1940 个文件 / 29.0 MB**，`media/` 489 个、`images/` 1368 个
- `assets/public/index.html` 内含构建标记 `mdz-webrtc-web-1` → 确认打进去的是新代码，不是被缓存的旧页面
- `mdz_core.js` / `mdz_p2p.js` / `mdz_ui.js` / `lan_bridge.js` / `vendor/*` 全部在包内

> **一个容易误判的坑**：用 .NET `ZipFile` 或 `tar` 对比文件名时，会发现 51 个西里尔名字（`перс1.png`、`город.png`…）
> 显示成乱码（`胁械褉褏1.png`）并据此报"缺失"。实际是 zip 条目没设 UTF-8 标志、.NET 按系统 ANSI(GBK) 解码名字所致，
> **存储的字节就是 UTF-8**——已用字节级搜索确认：APK 内存在 `D0 BF D0 B5 D1 80 D1 81 31 2E 70 6E 67`（"перс1"）且紧跟 `89 50 4E 47`（PNG 头）。
> 真正没进包的只有 `cordova.js` / `cordova_plugins.js` / `plugins/**`（Cordova 遗留文件，Capacitor 有意排除，
> `index.html` 也没有引用），不影响游戏与联机。

### 装到手机上

```bat
:: 方式1：adb（手机开 USB 调试）
adb install -r "D:\game_hack\minidayz\Minidayz-WebRTC\dist\Minidayz-WebRTC-debug.apk"

:: 方式2：把 APK 拷到手机（微信/QQ/数据线），点击安装
::   首次运行会请求相机权限 —— 扫码联机需要它
```

### 在手机上联机测试

1. 两台手机都装这个 APK（或用「一台手机 + 一台电脑浏览器」）
2. 同一 Wi-Fi（或一台开热点）
3. A 机：右上角面板 → 「① 房主：创建房间」→ 出现房间二维码
4. B 机：右上角面板 → 「① 客机：加入房间」→ 用原生扫码扫 A 的二维码 → 出现回码
5. A 机：「② 房主：扫对方回码」→ 扫 B 的回码 → 双方状态变「已连接」，游戏同步开始
6. 若连不上：先看面板提示，若是 mDNS 提示就点「②b 授权摄像头后重出码」，让 B 重扫一次

异地联机用「异地文本 SDP」模式（复制粘贴文本，微信/QQ 发送）。

---

## 八、原版未被改动的证明

```powershell
# 重新计算原版哈希并与清单比对
$src='D:\game_hack\minidayz\Minidayz-Multiplayer-main\Minidayz-Multiplayer-main'
$man=Import-Csv 'D:\game_hack\minidayz\Minidayz-WebRTC\_original_manifest.csv'
$now=Get-ChildItem $src -Recurse -File | Get-FileHash -Algorithm SHA256 |
     Select-Object @{n='rel';e={$_.Path.Substring($src.Length+1)}},Hash
Compare-Object $man $now -Property rel,Hash
# 无输出 = 原版 1964 个文件全部与建副本时一致
```
