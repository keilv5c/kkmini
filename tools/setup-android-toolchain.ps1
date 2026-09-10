# ============================================================================
#  setup-android-toolchain.ps1 —— 一键装好 Android 打包工具链（不污染系统环境）
# ----------------------------------------------------------------------------
#  装什么、装到哪：
#    <workspace>\tools\jdk21                  JDK 21（Capacitor 8 要求 Java 21）
#    <workspace>\tools\android-sdk            Android SDK（cmdline-tools + platform-tools
#                                             + platforms;android-36 + build-tools;36.0.0）
#    <workspace>\tools\env.ps1                生成的环境变量脚本，build-apk.ps1 会 dot-source
#  全部解压式安装，不写注册表、不改系统 PATH，删掉 tools 目录即可完全卸载。
#
#  用法：
#    pwsh -File tools\setup-android-toolchain.ps1              # 用默认位置
#    pwsh -File tools\setup-android-toolchain.ps1 -ToolchainRoot D:\somewhere
#  已存在的组件会自动跳过（可重复执行）。
# ============================================================================
[CmdletBinding()]
param(
  [string]$ToolchainRoot,
  [string]$CompileSdk = '36',
  [string]$BuildTools = '36.0.0'
)

$ErrorActionPreference = 'Stop'
if (-not $ToolchainRoot) {
  # <workspace> = 本脚本所在目录(项目/tools) 的上两级
  $ToolchainRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'tools'
}
$JdkHome  = Join-Path $ToolchainRoot 'jdk21'
$SdkRoot  = Join-Path $ToolchainRoot 'android-sdk'
New-Item -ItemType Directory -Path $ToolchainRoot -Force | Out-Null

function Say($m) { Write-Host "[toolchain] $m" }
function Have($p) { Test-Path $p }

# --------------------------------------------------------------------- JDK 21
$javaExe = $null
if (Have $JdkHome) {
  $javaExe = (Get-ChildItem $JdkHome -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
              Where-Object { $_.FullName -match '\\bin\\java\.exe$' } | Select-Object -First 1).FullName
}
if ($javaExe) {
  Say "JDK 已存在：$javaExe"
} else {
  $zip = Join-Path $ToolchainRoot 'jdk21.zip'
  if (-not (Have $zip)) {
    Say '下载 JDK 21（Adoptium，约 200MB）...'
    curl.exe -L --retry 3 --retry-delay 2 -o $zip `
      'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse'
    if ($LASTEXITCODE -ne 0) { throw 'JDK 下载失败' }
  }
  Say '解压 JDK...'
  New-Item -ItemType Directory -Path $JdkHome -Force | Out-Null
  tar.exe -xf $zip -C $JdkHome
  $javaExe = (Get-ChildItem $JdkHome -Recurse -Filter java.exe |
              Where-Object { $_.FullName -match '\\bin\\java\.exe$' } | Select-Object -First 1).FullName
  if (-not $javaExe) { throw '解压后找不到 java.exe' }
  $env:JAVA_HOME = Split-Path (Split-Path $javaExe -Parent) -Parent
  Say "JDK 就绪：$env:JAVA_HOME"
}
$env:JAVA_HOME = Split-Path (Split-Path $javaExe -Parent) -Parent

# ------------------------------------------------------------ Android cmdline-tools
$sdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Have $sdkManager)) {
  $zip = Join-Path $ToolchainRoot 'cmdline-tools.zip'
  if (-not (Have $zip)) {
    Say '下载 Android command line tools（约 140MB）...'
    curl.exe -L --retry 3 --retry-delay 2 -o $zip `
      'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip'
    if ($LASTEXITCODE -ne 0) { throw 'cmdline-tools 下载失败' }
  }
  Say '解压 command line tools...'
  $tmp = Join-Path $ToolchainRoot '_ct'
  if (Have $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  tar.exe -xf $zip -C $tmp
  New-Item -ItemType Directory -Path (Join-Path $SdkRoot 'cmdline-tools') -Force | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $SdkRoot 'cmdline-tools\latest') -Force
  Remove-Item $tmp -Recurse -Force
}
Say "sdkmanager：$sdkManager"

# ------------------------------------------------------------------ SDK 组件
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Say '预先接受 SDK 许可...'
# sdkmanager 会连续问多个许可，喂入足够多的 y（每条一行，最稳）
$yes = @(); 1..60 | ForEach-Object { $yes += 'y' }
$yes | & $sdkManager --sdk_root=$SdkRoot --licenses 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "    $_" }

Say '安装 platform-tools / platforms / build-tools（首次约 150MB）...'
$yes | & $sdkManager --sdk_root=$SdkRoot "platform-tools" "platforms;android-$CompileSdk" "build-tools;$BuildTools" 2>&1 |
  Where-Object { $_ -notmatch '^\s*$' } | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" }

if (-not (Have (Join-Path $SdkRoot "platforms\android-$CompileSdk"))) { throw "platforms;android-$CompileSdk 安装失败" }
if (-not (Have (Join-Path $SdkRoot "build-tools\$BuildTools")))      { throw "build-tools;$BuildTools 安装失败" }

# ------------------------------------------------------------------ 固化环境
$envFile = Join-Path $ToolchainRoot 'env.ps1'
@"
# 由 setup-android-toolchain.ps1 生成，build-apk.ps1 会 dot-source 它
`$env:JAVA_HOME        = '$env:JAVA_HOME'
`$env:ANDROID_HOME     = '$SdkRoot'
`$env:ANDROID_SDK_ROOT = '$SdkRoot'
`$env:Path = "`$env:JAVA_HOME\bin;`$env:ANDROID_HOME\platform-tools;`$env:ANDROID_HOME\cmdline-tools\latest\bin;`$env:Path"
"@ | Set-Content -Path $envFile -Encoding UTF8

Say "完成。"
Say "  JAVA_HOME    = $env:JAVA_HOME"
Say "  ANDROID_HOME = $SdkRoot"
Say "  env 脚本     = $envFile"
Say '下一步：pwsh -File tools\build-apk.ps1'
