# 编译 workbench-host.exe（本地服务端）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-host.ps1
#       备份当前 exe → 编译 → 停旧进程 → 替换 → 重新启动
#   ... -NoRestart    只编译替换，不自动启动（自己再开）
#   ... -NoSwap       只编译到 scripts\workbench-host.build.exe，不动正式 exe
#   ... -Rollback     回滚到上次的 workbench-host.prev.exe
#
# 编译失败时永远不会动正式 exe，所以可以放心执行。

param(
  [switch]$NoRestart,
  [switch]$NoSwap,
  [switch]$Rollback
)

$ErrorActionPreference = "Stop"

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here "workbench-host.cs"
$target = Join-Path $here "workbench-host.exe"
$prev   = Join-Path $here "workbench-host.prev.exe"
$build  = Join-Path $here "workbench-host.build.exe"

$csc = @(
  "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

function Stop-Host {
  $running = Get-Process workbench-host -ErrorAction SilentlyContinue
  if (-not $running) { return }
  foreach ($p in $running) {
    try { $p.Kill(); $p.WaitForExit(5000) | Out-Null } catch { }
  }
  # 端口要等系统真正释放，否则新进程会监听失败退回只本机
  for ($i = 0; $i -lt 20; $i++) {
    $busy = netstat -ano -p tcp | Select-String ":47321 " | Select-String "LISTENING"
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 300
  }
}

function Start-Host {
  Start-Process -FilePath $target -WindowStyle Hidden
}

function Wait-Host {
  for ($i = 0; $i -lt 40; $i++) {
    $busy = netstat -ano -p tcp | Select-String ":47321 " | Select-String "LISTENING"
    if ($busy) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

if ($Rollback) {
  if (-not (Test-Path $prev)) { Write-Host "没有可回滚的备份：$prev" -ForegroundColor Red; exit 1 }
  Stop-Host
  Copy-Item -LiteralPath $target -Destination $build -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $prev -Destination $target -Force
  if (-not $NoRestart) { Start-Host; [void](Wait-Host) }
  Write-Host "已回滚到 $prev" -ForegroundColor Yellow
  exit 0
}

if (-not (Test-Path $source)) { Write-Host "找不到源码：$source" -ForegroundColor Red; exit 1 }
if (-not $csc) { Write-Host "找不到 csc.exe（需要 .NET Framework 4.x）" -ForegroundColor Red; exit 1 }

Write-Host "编译中：$source"
Remove-Item -LiteralPath $build -Force -ErrorAction SilentlyContinue

# 显式列出引用，不依赖 csc.rsp 的默认集
& $csc /nologo /target:exe /platform:anycpu /out:"$build" `
  /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  "$source"
$code = $LASTEXITCODE

if ($code -ne 0 -or -not (Test-Path $build)) {
  Write-Host "编译失败（exit=$code），正式 exe 未改动。" -ForegroundColor Red
  exit 1
}

$size = (Get-Item $build).Length
Write-Host ("编译成功：{0} 字节" -f $size) -ForegroundColor Green

if ($NoSwap) {
  Write-Host "已跳过替换（-NoSwap），产物在 $build"
  exit 0
}

Stop-Host
if (Test-Path $target) { Copy-Item -LiteralPath $target -Destination $prev -Force }
Move-Item -LiteralPath $build -Destination $target -Force
Write-Host "已替换正式 exe，备份在 $prev"

if (-not $NoRestart) {
  Start-Host
  if (Wait-Host) {
    Write-Host "服务已重新启动：http://127.0.0.1:47321/" -ForegroundColor Green
  } else {
    Write-Host "服务启动后 12 秒内没有监听 47321，请检查。" -ForegroundColor Red
    exit 1
  }
}
