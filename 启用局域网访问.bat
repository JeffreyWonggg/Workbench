@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "EXE=%~dp0scripts\workbench-host.exe"

echo 检查局域网访问需要的两项配置（这两项都能以普通用户身份查看）：
echo.

set "MISSING=0"

rem ---- 1) URL 保留：决定服务能否监听所有网卡 ----
netsh http show urlacl 2>nul | findstr /c:"http://+:47321/" >nul
if errorlevel 1 (
  echo [缺] 没有 http://+:47321/ 的 URL 保留
  echo      后果：服务只能在本机 127.0.0.1 打开，局域网设备连不上。
  set "MISSING=1"
) else (
  echo [有] URL 保留已存在，服务可以监听所有网卡。
)

rem ---- 2) 防火墙放行：只在防火墙开启时才需要 ----
set "FW_ON=0"
powershell -NoProfile -Command "$s = (netsh advfirewall show allprofiles state | Out-String); if ($s -match 'State\s+ON') { exit 0 } else { exit 1 }"
if not errorlevel 1 set "FW_ON=1"
netsh advfirewall firewall show rule name="Workbench LAN 47321" >nul 2>&1
if not errorlevel 1 (
  set "RULE=0"
  echo [有] 防火墙规则「Workbench LAN 47321」已存在。
) else (
  if "!FW_ON!"=="1" (
    echo [缺] 没有放行 TCP 47321 的入站规则，且防火墙处于开启状态。
    echo      后果：局域网设备的连接会被防火墙拦掉。
    set "MISSING=1"
  ) else (
    echo [-] 防火墙三个配置文件都是关闭状态，无需放行规则。
  )
)
echo.

rem ---- 需要管理员时的说明（不中断本机使用）----
if "!MISSING!"=="1" (
  echo ────────────────────────────────────────────────
  echo  还缺上面的配置，需要【管理员】执行一次（以后就不用再跑）：
  echo.
  echo    netsh http add urlacl url=http://+:47321/ user="%USERDOMAIN%\%USERNAME%"
  echo    netsh advfirewall firewall add rule name="Workbench LAN 47321" dir=in action=allow protocol=TCP localport=47321 profile=any
  echo.
  echo  做法：把上面两行发给 IT / 有管理员账号的同事执行；
  echo  或右键本文件选「以管理员身份运行」一次。
  echo  只缺防火墙那一条时，第二行即可。
  echo  没有管理员权限也不影响本机使用（127.0.0.1 照常）。
  echo ────────────────────────────────────────────────
  echo.
)

rem ---- 重启服务（普通用户即可，无需管理员）----
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
powershell -NoProfile -Command "try { $i = Invoke-RestMethod 'http://127.0.0.1:47321/lan/info' -TimeoutSec 5; if ($i.scope -eq 'all') { Write-Host '      局域网已开启。其它设备可用下面的地址：'; $i.urls | ForEach-Object { Write-Host ('        ' + $_) } } else { Write-Host '      当前仅本机可访问（缺 URL 保留）。本机使用不受影响。' } } catch { Write-Host '      服务没起来，请双击「打开工作台.bat」。' }"

echo.
echo 完成。按任意键关闭。
pause >nul
endlocal
