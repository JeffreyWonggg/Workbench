# 把工作台发到 CloudBase 静态托管（手机 / 别人电脑访问的那一份）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
#       发「该发的全部」：js\ css\ fonts\ icons\ + 18 个页面 + favicon.svg / manifest.json / about.json
#   ... -Only js,css            只发指定的几样（目录名，或根目录下的文件名；html = 所有页面）
#   ... -Bump                   顺手把 js\sync-ui.js 的 BUILD 和 index.html 上的 ?v= 改成当前时间
#   ... -DryRun                 挑好文件、打印命令，但不真发（临时目录留着给你核对）
#   ... -Env <环境ID>           指定环境；会记进 scripts\deploy.local.json，以后不用再传
#   ... -CloudPath /assets      发到子目录（默认 /，就是站点根）
#   ... -Verify                 上传后加官方的 --verify 校验（默认不加：CLI 3.8.5 会误报，见第 7 段）
#   ... -NoVerify               上传报了错也不去拉远端清单复核，直接按失败算（兼容老命令）
#   ... -Prune                  加 --prune（会删掉远端多余的文件，慎用）
#   ... -Keep                   发完不删临时目录
#
# 为什么不直接照着 README 敲 tcb hosting deploy ./js js：js\ 里的 openrouter.local.js 是
# API 密钥，根目录还散着一堆数据文件。本脚本先把要发的东西挑进一个干净目录，再整目录上传，
# 不赌 CLI 的排除规则；上传前还会把临时目录再扫一遍，见到密钥 / 数据文件就当场中止。
#
# 发布靠 CloudBase CLI（tcb，或新版的 cloudbase）：先装 Node，再 npm i -g @cloudbase/cli，
# 然后 tcb login 一次。没装的话脚本会提示，别的什么都不动。
#
# PATH 里没有 tcb 不等于没装：官方安装器装的 CLI（%LOCALAPPDATA%\cbcli）和 IDE 自带的
# node 都不写系统 PATH，双击 bat、从工作台的「设置 → 发布」里跑时看不见它们，
# 所以脚本会自己把 PATH、cbcli、node 目录都翻一遍（见 Find-Cli）。

param(
  [string[]]$Only = @(),
  [string]$Env = "",
  [string]$CloudPath = "/",
  [switch]$Bump,
  [switch]$DryRun,
  [switch]$Verify,
  [switch]$NoVerify,
  [switch]$Prune,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"

# 被本地服务以管道方式调用时（设置 → 发布），输出切成 UTF-8，日志里的中文才不会在页面上变成乱码；
# 双击 bat 自己跑时保持控制台原样。
try { if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } } catch { }

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $here
$conf  = Join-Path $here "deploy.local.json"
$stage = Join-Path ([IO.Path]::GetTempPath()) "workbench-deploy"

$DIRS  = @("js", "css", "fonts", "icons")
$LOOSE = @("favicon.svg", "manifest.json", "about.json")
# 这些东西一旦出现在待发目录里就停下：密钥、本机数据、编译产物
$BLOCKED = @("*.local.js", "*.local.json", "workbench.config.json", "clipboard-history.json",
             "commute-spool.json", "commute.local.json", "baidu.local.json", "catalog-index.json",
             "*.exe", "*.pdb", "*.bak", "*.db", "*.md", "*.ini")

function Info($text) { Write-Host ("      " + $text) }
function Warn($text) { Write-Host ("[注意] " + $text) -ForegroundColor Yellow }
function Die($text)  { Write-Host ("[失败] " + $text) -ForegroundColor Red; exit 1 }

function Read-Text($path) { return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) }

# 项目里的 html / js 都是 UTF-8 无 BOM，改完原样写回，免得每次 diff 都多一行变化
function Write-Text($path, $text) {
  [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Copy-Tree($src, $dst, $skip) {
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  foreach ($file in (Get-ChildItem -LiteralPath $src -Recurse -File)) {
    if ($skip -contains $file.Name) { continue }
    $rel = $file.FullName.Substring($src.Length).TrimStart("\")
    $target = Join-Path $dst $rel
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

# 拉一份远端文件清单（只要 Key，核对够用了）。
# 用途：CLI 的 --verify 偶尔会误报「missing=把整个站点列一遍」，这时拿真清单自证一下，
# 别把已经发成功的发布判成失败。列目录本身失败就返回 $null，调用方据此放弃复核
# （宁可报错，也不能瞎报成功）。
function Get-RemoteKeys {
  param([string]$Cli, [string]$EnvId, [string]$CloudPath)
  $out = (& $Cli @("hosting", "list", "-e", $EnvId, $CloudPath) 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { return $null }
  # CLI 的表格带 ANSI 颜色码，剥掉再按行认：│ 序号 │ Key │ 时间 │ ETag │ 大小 │
  $plain = $out -replace ([char]27 + "\[[0-9;]*m"), ""
  $keys = @()
  foreach ($line in ($plain -split "`n")) {
    $m = [regex]::Match($line, '^│\s*\d+\s*│\s*(\S.*?)\s*│')
    if ($m.Success) { $keys += $m.Groups[1].Value.Trim() }
  }
  return ,$keys
}

# IDE（CodeBuddy）自带的 node 目录：node.exe 和 npm 全局装的 tcb.cmd 就放在一起。
# 版本号大的排前面，装着好几份时挑最新的。
function Get-BundledNodeDirs {
  if (-not $env:USERPROFILE) { return @() }
  $root = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions"
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  return @(Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -notmatch "installing|__extract_temp__" } |
    Sort-Object Name -Descending |
    ForEach-Object { $_.FullName })
}

# tcb.cmd / cloudbase.cmd 都是 node 壳，PATH 上没有 node 就起不来 —— 找到一个塞进 PATH。
# 只影响本脚本这个进程树，不动系统环境。
function Add-NodeToPath {
  if (Get-Command node -ErrorAction SilentlyContinue) { return $true }
  $candidates = @()
  foreach ($dir in Get-BundledNodeDirs) { $candidates += (Join-Path $dir "node.exe") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
  foreach ($exe in $candidates) {
    if ($exe -and (Test-Path -LiteralPath $exe)) {
      $env:Path = (Split-Path -Parent $exe) + ";" + $env:Path
      return $true
    }
  }
  return $false
}

function Find-Cli {
  # 1) PATH 上直接有（在自己终端里装过、敲过 tcb login 的那种）
  foreach ($name in @("tcb", "cloudbase")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }

  # 2) PATH 上没有不等于没装：官方安装器装的 CloudBase CLI（%LOCALAPPDATA%\cbcli）
  #    和 IDE 自带的 node 都不往系统 PATH 里写，双击 bat、从工作台里跑时看不见它们。
  $nodeOk = Add-NodeToPath
  $dirs = @()
  if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA "cbcli") }
  $dirs += Get-BundledNodeDirs
  if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA "npm") }
  foreach ($dir in $dirs) {
    foreach ($name in @("tcb.cmd", "cloudbase.cmd")) {
      $exe = Join-Path $dir $name
      if (-not (Test-Path -LiteralPath $exe)) { continue }
      # 这个目录里自己带 node.exe 就一定能跑；否则得靠 PATH 上的 node
      if ($nodeOk -or (Test-Path -LiteralPath (Join-Path $dir "node.exe"))) { return $exe }
    }
  }
  return ""
}

# ---- 1) 环境 ID 与本机配置 ----

$config = $null
if (Test-Path -LiteralPath $conf) {
  try { $config = Get-Content -LiteralPath $conf -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Warn "scripts\deploy.local.json 读不出来，忽略它" }
}

$siteUrl = ""
if ($config -and $config.url) { $siteUrl = $config.url }

$envId = $Env
if (-not $envId -and $config -and $config.envId) { $envId = $config.envId }
if (-not $envId -and -not $DryRun) {
  Die "没给环境 ID。第一次跑带上：-Env <环境ID>（我记到 scripts\deploy.local.json，下次不用再带）"
}
if ($envId -and (-not $config -or $config.envId -ne $envId)) {
  $obj = [ordered]@{ envId = $envId; url = $siteUrl }
  Write-Text $conf (($obj | ConvertTo-Json) + "`r`n")
  Info ("环境 ID 已记到 " + $conf)
}

# ---- 2) 这次要发什么 ----

$pages = @(Get-ChildItem -LiteralPath $root -Filter "*.html" -File |
  Where-Object { $_.Name -notlike "_*" } | Sort-Object Name | ForEach-Object { $_.Name })

$items = @()
foreach ($chunk in $Only) { $items += ($chunk -split ",") }
$items = @($items | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$wantDirs = @()
$wantFiles = @()
if ($items.Count -eq 0) {
  $wantDirs = $DIRS
  $wantFiles = $LOOSE + $pages
} else {
  foreach ($name in $items) {
    if ($name -eq "html" -or $name -eq "pages") { $wantFiles += $pages; continue }
    if ($DIRS -contains $name) { $wantDirs += $name; continue }
    if (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf) { $wantFiles += $name; continue }
    Die ("不认识要发的东西：" + $name + "（可以是 js / css / fonts / icons / html，或根目录下的文件名）")
  }
}
$wantDirs = @($wantDirs | Select-Object -Unique)
$wantFiles = @($wantFiles | Select-Object -Unique)
if ($wantDirs.Count -eq 0 -and $wantFiles.Count -eq 0) { Die "没有要发的东西" }

# ---- 3) 版本戳：改了 sync-*.js 才需要（见 README「更新发布的页面」）----

$stampText = ""
if ($Bump) {
  $stampText = Get-Date -Format "yyyy-MM-dd HH:mm"
  $stampUrl = Get-Date -Format "yyyyMMdd-HHmm"

  $uiPath = Join-Path $root "js\sync-ui.js"
  $ui = Read-Text $uiPath
  $uiNew = [regex]::Replace($ui, 'const BUILD = "[^"]*"', 'const BUILD = "' + $stampText + '"')
  if ($uiNew -eq $ui) { Warn "js\sync-ui.js 里没找到 const BUILD，这步跳过" }
  else { Write-Text $uiPath $uiNew; Info ("js\sync-ui.js  BUILD = " + $stampText) }

  $htmlPath = Join-Path $root "index.html"
  $html = Read-Text $htmlPath
  $htmlNew = [regex]::Replace($html, '\?v=\d{8}-\d{4}', '?v=' + $stampUrl)
  if ($htmlNew -eq $html) { Warn "index.html 里没找到 ?v= 时间戳，这步跳过" }
  else { Write-Text $htmlPath $htmlNew; Info ("index.html     ?v=" + $stampUrl) }
}

# ---- 4) 发布工具在不在：不在就现在停下，别白准备一堆文件 ----

$cli = Find-Cli
if ($cli) { Write-Host ("发布工具：" + $cli) }
if (-not $cli -and -not $DryRun) {
  Die ("没找到 CloudBase CLI（tcb / cloudbase）——PATH、%LOCALAPPDATA%\cbcli 和 node 目录都翻过了。" +
       "先装 Node：winget install OpenJS.NodeJS.LTS；再 npm i -g @cloudbase/cli；然后 tcb login 一次。" +
       "只想核对要发哪些文件的话，加 -DryRun。")
}

# ---- 5) 挑进临时目录 ----

Write-Host ("准备：" + $stage)
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($dir in $wantDirs) {
  $src = Join-Path $root $dir
  if (-not (Test-Path -LiteralPath $src -PathType Container)) { Die ("找不到目录：" + $dir) }
  Copy-Tree $src (Join-Path $stage $dir) @("openrouter.local.js")
}
foreach ($file in $wantFiles) {
  $src = Join-Path $root $file
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Die ("找不到文件：" + $file) }
  Copy-Item -LiteralPath $src -Destination (Join-Path $stage $file) -Force
}

$staged = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
if ($staged.Count -eq 0) { Die "临时目录是空的，什么都没准备出来" }

# ---- 6) 防呆：待发目录里不许有密钥 / 本机数据 ----

$bad = @($staged | Where-Object {
  $name = $_.Name
  $hit = $false
  foreach ($pattern in $BLOCKED) { if ($name -like $pattern) { $hit = $true } }
  $hit
})
if ($bad.Count -gt 0) {
  foreach ($file in $bad) { Warn ("不该发的文件：" + $file.FullName.Substring($stage.Length).TrimStart("\")) }
  Die "临时目录里混进了密钥 / 数据文件，已中止（什么都没上传）"
}

Info ("目录 " + ($wantDirs -join " ") + "；文件 " + $wantFiles.Count + " 个；合计 " + $staged.Count + " 个文件")
Info ("远端位置 " + $CloudPath)

# ---- 7) 上传 ----

# --verify 默认不开：CloudBase CLI 3.8.5 在这台机器上每次都误报「missing=把整个站点列一遍」
# （2026-10-03 连撞两次，可当时远端文件一个不少），开着只会白跑一趟、再刷一段红字。
# 想看官方校验结果就加 -Verify；平时靠上传后那份远端清单核对（见下面）。
$flags = @()
if ($Verify) { $flags += "--verify" }
if ($Prune) { $flags += "--prune" }

$shown = "tcb"
if ($cli) { $shown = Split-Path -Leaf $cli }
$plan = @($shown, "hosting", "deploy", ('"' + $stage + '"'), $CloudPath, "-e", $envId) + $flags

if ($DryRun) {
  Write-Host ""
  Write-Host ("（-DryRun，没有上传）" + ($plan -join " ")) -ForegroundColor Cyan
  Write-Host ("临时目录留着：$stage")
  exit 0
}

Write-Host ("上传：" + ($plan -join " "))
$started = Get-Date
& $cli @(@("hosting", "deploy", $stage, $CloudPath, "-e", $envId) + $flags)
$code = $LASTEXITCODE

# 上传报了错别急着判死：拉一份远端清单核对，真缺才算失败。
# 两个用处：一是 CLI 的 --verify 误报时自证清白，二是上传真断了能说清缺哪些文件。
if ($code -ne 0 -and -not $NoVerify) {
  Write-Host "上传命令报了错，先拉一份远端清单核对…" -ForegroundColor Yellow
  $remote = Get-RemoteKeys -Cli $cli -EnvId $envId -CloudPath $CloudPath
  if ($remote -and $remote.Count -gt 0) {
    $prefix = $CloudPath.Trim("/")
    $missing = @()
    foreach ($file in $staged) {
      $rel = $file.FullName.Substring($stage.Length).TrimStart("\").Replace("\", "/")
      if ($remote -contains $rel) { continue }
      if ($prefix.Length -gt 0 -and $remote -contains ($prefix + "/" + $rel)) { continue }
      $missing += $rel
    }
    if ($missing.Count -eq 0) {
      Write-Host ("核对通过：远端现有的 " + $remote.Count + " 个文件里，本次该发的 " + $staged.Count + " 个全都在。") -ForegroundColor Green
      Info "--verify 报的是误报，东西实际已经发布上去了。"
      $code = 0
    } else {
      Warn ("远端清单里确实缺 " + $missing.Count + " 个文件，前几个：" + (($missing | Select-Object -First 10) -join " "))
    }
  } else {
    Warn "远端清单没拉到，没法复核，按上传失败处理。"
  }
}

if ($code -ne 0) {
  Write-Host ("[失败] 上传没成功（exit=$code）。临时目录留在 $stage，") -ForegroundColor Red
  Write-Host "       修好问题后可以直接重跑这一条：" -ForegroundColor Red
  Write-Host ("       " + ($plan -join " ")) -ForegroundColor Red
  exit 1
}
$spent = [int](((Get-Date) - $started).TotalSeconds)

# ---- 8) 收尾 ----

if (-not $Keep) { Remove-Item -LiteralPath $stage -Recurse -Force }
Write-Host ("发布完成，用时 " + $spent + " 秒。") -ForegroundColor Green
if ($siteUrl) { Info ("站点：" + $siteUrl) }
Info "手机上刷新页面（或重开标签页）就能看到新的。"
if ($Bump -and $stampText) {
  Info ("改了同步代码：手机上「设置 → 云同步」拉到底，应显示 同步面板构建 " + $stampText)
}
