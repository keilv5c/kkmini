# 我自己有证书，只要 IPA —— 具体操作

你有签名证书（`.p12` + `.mobileprovision`），那就有两条路。**先说结论：走路径 A（CI 直接出已签名 IPA）最省事，下载即可安装。**

两条路都绕不开同一个前提：**证书里的 App ID 必须和 IPA 的 Bundle ID 一致**。
这是自签名失败的第一大原因（占我见过的失败里的大多数），所以先做体检。

---

## 第 0 步（必做）：证书体检

把这两个文件放到一起，然后跑：

```bat
cd /d D:\game_hack\minidayz\Minidayz-WebRTC
node tools\inspect-mobileprovision.js 你的.mobileprovision --udid 你手机的UDID
```

UDID 怎么拿：手机连电脑 → 爱思助手/iTunes 里能看到；或手机上装个"UDID 查询"快捷指令。
**企业证书不用管 UDID**，脚本会直接告诉你"任意设备都能装"。

输出会明确告诉你：

```
  类型        : 开发 / Ad-Hoc（只能装到列表内的 2 台设备）     ← 或 企业证书 / App Store
  Bundle ID   : com.mdz.webrtcmp                             ← 关键：IPA 必须用这个 ID
  剩余有效期  : 199 天
  ✅ 该设备在描述文件列表里
```

拿到 **Bundle ID** 后记住它，下面要用。

---

## 路径 A：CI 直接出「已签名 IPA」（推荐）

### A1. 把 4 个 Secret 填进 GitHub

在你的仓库 → **Settings → Secrets and variables → Actions → New repository secret**，加 4 个：

| Secret 名 | 内容 |
|---|---|
| `BUILD_CERTIFICATE_BASE64` | 你的 `.p12` 转成 base64 的文本 |
| `P12_PASSWORD` | `.p12` 的密码 |
| `BUILD_PROVISION_PROFILE_BASE64` | 你的 `.mobileprovision` 转成 base64 的文本 |
| `KEYCHAIN_PASSWORD` | 随便一串临时密码（CI 建临时钥匙串用，如 `mdz-temp-1234`） |

Windows 上生成 base64 的命令（**PowerShell**，一行一条，会直接复制到剪贴板）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\证书\cert.p12")) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\证书\profile.mobileprovision")) | Set-Clipboard
```

> 安全提醒：证书是敏感信息。**用私有仓库**，用完可以把这 4 个 secret 删掉。
> 公开仓库里 fork/PR 拿不到 secret，但仍建议私有。

### A2. 跑工作流

仓库 **Actions → Build iOS IPA (signed) → Run workflow**，三个输入：

| 输入 | 填什么 |
|---|---|
| `bundle_id` | **第 0 步体检出来的 Bundle ID**（如 `com.mdz.webrtcmp`）。填错工作流会**当场报错并告诉你正确的值**，不会白等 20 分钟 |
| `method` | 有注册设备 → `ad-hoc`；企业证书 → `enterprise`；开发者证书+自己设备 → `development` |
| `identity` | 留空自动探测；若探测不对，填 `Apple Distribution` 或 `iPhone Distribution` 或 `Apple Development` |

跑完在 **Artifacts** 下载 `minidayz-signed-ipa`，里面是 `Minidayz-signed.ipa` —— **这就是你要的 IPA，直接装即可**。

日志里还会打印：签名身份、嵌入的描述文件、`CFBundleIdentifier`、四个权限键是否齐全。

### A3. 安装

- 爱思助手 / 3uTools：连手机 → 应用 → 安装 → 选这个 ipa
- 或 iTunes/Apple Configurator
- 企业证书（enterprise）：手机上直接点开安装即可，但要在 设置 → 通用 → VPN与设备管理 里信任企业证书

---

## 路径 B：先出未签名 IPA，再本地签名（不想把证书放云端时用）

1. 跑**另一个**工作流 **Build iOS IPA (unsigned)** → 下载 `Minidayz-unsigned-ipa`
2. 在 Windows 上用你的证书签名，二选一：

**B1. 爱思助手（图形界面，最省事）**

爱思助手 → **工具箱 → IPA 签名** → 添加 `Minidayz-unsigned.ipa` →
选择你的证书（`.p12`）+ 描述文件（`.mobileprovision`）→ 输入 p12 密码 → 开始签名 → 签名完成后可直接装到设备。

**B2. zsign（命令行，可脚本化）**

```bat
:: 需要 zsign 可执行文件（GitHub 搜 zsign，有 Windows 构建）
zsign -k D:\证书\cert.p12 -p 你的p12密码 -m D:\证书\profile.mobileprovision -o Minidayz-signed.ipa Minidayz-unsigned.ipa
```

> 若证书的 Bundle ID 与 IPA 不一致，zsign 支持 `-b 新的BundleID` 在签名时改（不同版本参数名可能略有差异，`zsign -h` 确认）。
> 但更推荐路径 A：直接用 `bundle_id` 输入框让 IPA 一开始就用证书的 ID，最干净。

3. 安装：爱思助手/3uTools 装，或 `ideviceinstaller -i Minidayz-signed.ipa`

---

## 先自查：IPA 与证书是否匹配

拿到未签名 IPA 后，可以在本地先验一遍（不用等签名失败）：

```bat
node tools\inspect-mobileprovision.js 你的.mobileprovision --ipa Minidayz-unsigned.ipa --udid 你手机的UDID
```

会输出：

```
  IPA 里的 Bundle ID  : com.mdz.webrtcmp
  证书里的 Bundle ID  : com.mdz.webrtcmp
  ✅ 一致，可以直接签名
```

不一致时会明确告诉你两种解法（改证书的 App ID，或重跑云构建并填对 `bundle_id`）。

---

## 常见报错对照

| 报错 / 现象 | 原因与解法 |
|---|---|
| `Provisioning profile ... doesn't match the entitlements` / `No matching provisioning profiles found` | Bundle ID 不一致（第 0 步体检）。或描述文件没放进 `~/Library/MobileDevice/Provisioning Profiles`（路径 B 本地签名时由工具自动处理） |
| `The certificate ... has expired` | 证书或描述文件过期。到 Apple Developer 重新生成；体检脚本会提前告诉你剩余天数 |
| `Untrusted Developer`（装上但打不开） | 设置 → 通用 → **VPN 与设备管理** → 信任该证书 |
| 装上了但点开秒退 | iOS 16+ 需开**开发者模式**：设置 → 隐私与安全性 → 开发者模式 → 打开并重启 |
| 企业证书装上后提示"无法验证 App" | 企业证书被吊销，或设备没联网验证；换个证书/联网重试 |
| 装到设备失败但没报错 | 设备 UDID 不在描述文件列表里（Ad-Hoc/开发证书）。体检脚本加 `--udid` 会直接告诉你 |
| 联机连不上 | 设置 → 隐私与安全性 → **本地网络** → 允许本 App（这个不允许，局域网 P2P 直接失败） |

---

## 需要我帮你看的话

跑完工作流后，把 **`导入证书与描述文件`、`Archive`、`导出 IPA` 这三步的日志**发我。
证书类问题的报错都很具体，日志里一般直接写着哪个环节不匹配，我能直接判断是 Bundle ID、身份名、还是描述文件的问题。
