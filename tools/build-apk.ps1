# ============================================================================
#  build-apk.ps1 —— 用本地工具链构建 Android APK，并自动校验产物
# ----------------------------------------------------------------------------
#  前置：先跑一次 tools\setup-android-toolchain.ps1
#        （或用系统已装好的 JDK21+SDK：把 -ToolchainRoot 指向含 env.ps1 的目录）
#
#  用法：
#    powershell -File tools\build-apk.ps1                      # 出 debug APK
#    powershell -File tools\build-apk.ps1 -Variant Release      # 出 release（未签名）
#    powershell -File tools\build-apk.ps1 -SkipWebSync          # 跳过 cap sync
#    powershell -File tools\build-apk.ps1 -ToolchainRoot D:\somewhere
#
#  注意：本脚本要能在 Windows PowerShell 5.1 下跑，所以所有原生命令都用
#        cmd /c 包一层 —— 5.1 会把原生命令写到 stderr 的内容当成 ErrorRecord，
#        配合 $ErrorActionPreference='Stop' 会直接中断（java -version 就会踩到）。
#        另外本文件必须保存为 **UTF-8 with BOM**，否则 5.1 会按 ANSI 读，中文乱码。
# ============================================================================
[CmdletBinding()]
param(
  [ValidateSet('Debug','Release')] [string]$Variant = 'Debug',
  [string]$ToolchainRoot,
  [switch]$SkipWebSync
)

$ErrorActionPreference = 'Continue'          # 原生命令的 stderr 不当致命错误
$ProjectRoot = Split-Path $PSScriptRoot -Parent          # ...\Minidayz-WebRTC
$AndroidDir  = Join-Path $ProjectRoot 'android'
if (-not $ToolchainRoot) {
  $ToolchainRoot = Join-Path (Split-Path $ProjectRoot -Parent) 'tools'
}

function Say($m)  { Write-Host "[build-apk] $m" }
function Fail($m) { throw "[build-apk] $m" }

# ------------------------------------------------------------------ 环境变量
$envFile = Join-Path $ToolchainRoot 'env.ps1'
if (Test-Path $envFile) {
  . $envFile
  Say "已加载工具链环境：$envFile"
} else {
  Say "未找到 $envFile，改用当前系统的 JAVA_HOME / ANDROID_HOME"
}
if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) { Fail 'JAVA_HOME 无效，请先跑 tools\setup-android-toolchain.ps1' }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if (-not $sdk -or -not (Test-Path $sdk)) { Fail 'ANDROID_HOME 无效，请先跑 tools\setup-android-toolchain.ps1' }
$env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk

$javaVer = (cmd /c "`"$env:JAVA_HOME\bin\java.exe`" -version 2>&1" | Select-Object -First 1)
Say "JDK   : $javaVer"
Say "SDK   : $sdk"

# --------------------------------------------------------------- 同步 web 资源
if (-not $SkipWebSync) {
  Say 'cap sync android（把 web/ 里的改动同步进 android 工程）...'
  Push-Location $ProjectRoot
  cmd /c "npx cap sync android 2>&1" | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" }
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) { Fail "cap sync 失败（exit=$rc）" }
}

# ------------------------------------------------------------------ local.properties
$localProps = Join-Path $AndroidDir 'local.properties'
"sdk.dir=$($sdk -replace '\\','/')" | Set-Content -Path $localProps -Encoding ASCII
Say "写入 $localProps"

# ------------------------------------------------------------------------ 构建
$task = if ($Variant -eq 'Release') { 'assembleRelease' } else { 'assembleDebug' }
$log  = Join-Path $ToolchainRoot 'last-build.log'
Push-Location $AndroidDir
Say "gradlew $task（首次会下载 Gradle 8.14.3 与 AndroidX/MLKit 依赖，可能十几分钟）..."
cmd /c "gradlew.bat $task --no-daemon --console=plain --stacktrace 2>&1" |
  Tee-Object -FilePath $log | Select-Object -Last 30 | ForEach-Object { Write-Host "    $_" }
$rc = $LASTEXITCODE
Pop-Location
if ($rc -ne 0) { Fail "gradle 构建失败（exit=$rc），完整日志：$log" }

# -------------------------------------------------------------------- 找产物
$apkDir = Join-Path $AndroidDir "app\build\outputs\apk\$($Variant.ToLower())"
$apk = Get-ChildItem $apkDir -Filter *.apk -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) { Fail "没找到 APK，检查 $apkDir" }

Say ''
Say '================= 构建完成 ================='
Say ("APK   : " + $apk.FullName)
Say ("大小  : " + [math]::Round($apk.Length / 1MB, 1) + " MB")
Say ("时间  : " + $apk.LastWriteTime)

# -------------------------------------------------------------------- 产物校验
$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
              Sort-Object Name -Descending | Select-Object -First 1
$aapt = if ($buildTools) { Join-Path $buildTools.FullName 'aapt2.exe' } else { $null }
if ($aapt -and (Test-Path $aapt)) {
  Say ''
  Say '--- aapt2 校验 ---'
  $badging = cmd /c "`"$aapt`" dump badging `"$($apk.FullName)`" 2>&1"
  $badging | Select-String -Pattern 'package: name|application-label:|launchable-activity|uses-permission' |
    ForEach-Object { Write-Host ("    " + $_.Line) }
  $hasCamera = ($badging | Select-String -Pattern 'android.permission.CAMERA') -ne $null
  Say ("    相机权限: " + $(if ($hasCamera) { '有' } else { '缺失!' }))
}

Say ''
Say '--- APK 里的 web 资源（确认是当前代码，不是被缓存的旧页面）---'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
try {
  $want = @('assets/public/index.html','assets/public/mdz_p2p.js','assets/public/mdz_core.js',
            'assets/public/mdz_ui.js','assets/public/lan_bridge.js',
            'assets/public/vendor/pako.min.js','assets/public/vendor/qrcode.min.js')
  foreach ($w in $want) {
    $e = $zip.Entries | Where-Object { $_.FullName -eq $w }
    if ($e) { Write-Host ("    OK   {0,-42} {1,8:N0} B" -f $w, $e.Length) }
    else    { Write-Host ("    缺失 {0}" -f $w) }
  }
  $idx = $zip.Entries | Where-Object { $_.FullName -eq 'assets/public/index.html' }
  $hasBuildTag = $false
  if ($idx) {
    $sr = New-Object System.IO.StreamReader($idx.Open())
    $html = $sr.ReadToEnd(); $sr.Close()
    $buildTag = [regex]::Match($html, "MDZ_BUILD = '([^']+)'").Groups[1].Value
$hasBuildTag = ($buildTag -ne '')
  }
  Say ("    index.html 构建标记: " + $(if ($hasBuildTag) { $buildTag } else { '找不到!（web 资源可能是旧的）' }))
} finally { $zip.Dispose() }

Say ''
Say '安装到手机：'
Say ('    adb install -r "' + $apk.FullName + '"')
Say '    （或把 APK 拷到手机点击安装；首次运行会请求相机权限）'
