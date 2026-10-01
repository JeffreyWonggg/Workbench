@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "EXE=%~dp0scripts\workbench-host.exe"
set "URL=http://+:47321/"
set "RULE=Workbench LAN 47321"

rem 被自己提权重跑的那一次：只写配置，写完立刻退出，
rem 把「重启服务」留给外面那个普通权限的窗口（服务不该跑在管理员权限下）。
if /i "%~1"=="apply-config" goto apply_config

rem 看看当前窗口是不是管理员（net session 需要管理员才能成功）
set "ELEVATED=0"
net session >nul 2>&1
if not errorlevel 1 set "ELEVATED=1"

echo 检查局域网访问需要的两项配置（缺哪项就补哪项）：
echo.

set "NEED=0"

rem ---- 1) URL 保留：决定服务能否监听所有网卡 ----
netsh http show urlacl | findstr /c:"%URL%" >nul
if errorlevel 1 (
  echo [缺] 没有 %URL% 的 URL 保留
  echo      后果：服务只能在本机 127.0.0.1 打开，局域网设备连不上。
  set "NEED=1"
) else (
  echo [有] URL 保留已存在，服务可以监听所有网卡。
)

rem ---- 2) 防火墙放行 ----
netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
if errorlevel 1 (
  echo [缺] 没有放行 TCP 47321 的入站规则「%RULE%」
  echo      后果：防火墙开着的网络配置文件下，局域网设备的连接会被拦掉。
  set "NEED=1"
) else (
  echo [有] 防火墙规则已存在。
)

if "!NEED!"=="1" (
  if "!ELEVATED!"=="1" (
    call :apply_config
  ) else (
    echo.
    echo 上面缺的这两项只有管理员能写。现在弹一次 UAC，点「是」就行：
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'apply-config' -Verb RunAs -Wait"
    if errorlevel 1 (
      echo.
      echo [提示] 提权被取消，配置没有写入。局域网仍然用不了，本机使用不受影响。
    )
  )
) else (
  echo.
  echo 配置齐全，不需要改动。
)

echo.
rem ---- 重启服务（普通权限即可，无需管理员）----
echo [1/2] 重启工作台服务...
taskkill /f /im workbench-host.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul
if exist "%EXE%" (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%EXE%' -WindowStyle Hidden"
  ping -n 3 127.0.0.1 >nul
  echo       完成。
) else (
  echo       没找到 %EXE%，请双击「打开工作台.bat」启动。
)

rem ---- 自检：实际绑到哪，一目了然 ----
echo [2/2] 自检当前状态...
powershell -NoProfile -Command "try { $i = Invoke-RestMethod 'http://127.0.0.1:47321/lan/info' -TimeoutSec 5; if ($i.scope -eq 'all') { Write-Host '      局域网已开启。其它设备可用下面的地址：'; $i.urls | ForEach-Object { Write-Host ('        ' + $_) } } else { Write-Host ('      当前仍仅本机可访问' + $(if ($i.bindError) { '：' + $i.bindError } else { '（缺 URL 保留）' }) + '。'); Write-Host '      本机使用不受影响。' } } catch { Write-Host '      服务没起来，请双击「打开工作台.bat」。' }"

echo.
echo 完成。按任意键关闭。
pause >nul
endlocal
exit /b

rem ============================================================
rem  以下只会在提权后的那次运行里执行
rem ============================================================
:apply_config
echo.
echo ── 写入配置（管理员权限已获得）──

netsh http show urlacl | findstr /c:"%URL%" >nul
if errorlevel 1 (
  netsh http add urlacl url=%URL% user="%USERDOMAIN%\%USERNAME%"
  netsh http show urlacl | findstr /c:"%URL%" >nul
  if errorlevel 1 (
    echo [失败] URL 保留没写进去。可手动执行：
    echo        netsh http add urlacl url=%URL% user="%USERDOMAIN%\%USERNAME%"
  ) else (
    echo [完成] URL 保留已添加，服务可以监听所有网卡。
  )
) else (
  echo [跳过] URL 保留已存在。
)

netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
if errorlevel 1 (
  netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=47321 profile=any >nul
  netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
  if errorlevel 1 (
    echo [失败] 防火墙规则没写进去。可手动执行：
    echo        netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=47321 profile=any
  ) else (
    echo [完成] 防火墙规则已添加。
  )
) else (
  echo [跳过] 防火墙规则已存在。
)
exit /b
