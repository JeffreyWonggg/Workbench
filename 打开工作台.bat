@echo off
setlocal
set "EXE=%~dp0scripts\workbench-host.exe"

rem 已经在跑就不重复启动
netstat -ano -p tcp | findstr "LISTENING" | findstr ":47321 " >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%EXE%' -WindowStyle Hidden"
  rem 等监听器就绪
  timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:47321/"
endlocal
