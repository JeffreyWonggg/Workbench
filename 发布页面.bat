@echo off
chcp 65001 >nul
rem 把工作台发到 CloudBase 静态托管。双击 = 发该发的全部。
rem 也可以带参数，比如：
rem     发布页面.bat -Only js,css
rem     发布页面.bat -Only js -Bump
rem 详细说明见 scripts\deploy.ps1 开头的注释。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1" %*
echo.
pause >nul
