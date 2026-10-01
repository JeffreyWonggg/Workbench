@echo off
setlocal
set "EXE=%~dp0scripts\workbench-host.exe"
set "URL=http://127.0.0.1:47321/"

rem 已经在跑就不重复启动
netstat -ano -p tcp | findstr "LISTENING" | findstr ":47321 " >nul 2>&1
if not errorlevel 1 goto wait_port
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%EXE%' -WindowStyle Hidden"

rem 等端口就绪再打开，最多等 30 秒（原来是固定 timeout /t 2，机器慢时会开到白页）
:wait_port
set /a tries=0
:wait_loop
netstat -ano -p tcp | findstr "LISTENING" | findstr ":47321 " >nul 2>&1
if not errorlevel 1 goto open_page
set /a tries+=1
if %tries% GEQ 30 goto open_page
timeout /t 1 /nobreak >nul
goto wait_loop

:open_page
rem 优先用 Edge 的 --app 模式打开（没有地址栏和标签栏，像独立应用），
rem 找不到 Edge 用 Chrome 的 --app 模式，都没有才退回系统默认浏览器。
rem 注意：这里全用 goto 而不是 if ( ) 块——路径里的 "(x86)" 会截断括号块。
set "EDGE="
for /f "delims=" %%i in ('where msedge 2^>nul') do if not defined EDGE set "EDGE=%%i"
if not defined EDGE if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE goto try_chrome
start "" "%EDGE%" --app=%URL% --window-size=1600,1000
goto done

:try_chrome
set "CHROME="
for /f "delims=" %%i in ('where chrome 2^>nul') do if not defined CHROME set "CHROME=%%i"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME goto fallback
start "" "%CHROME%" --app=%URL% --window-size=1600,1000
goto done

rem 没装 Edge / Chrome：交给系统默认浏览器，用普通地址打开
:fallback
start "" "%URL%"

:done
endlocal
