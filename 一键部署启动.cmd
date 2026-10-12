@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1"
set "bot_exit=%errorlevel%"
if not "%bot_exit%"=="0" echo Deployment failed. Read the error above.
if not "%bot_exit%"=="0" pause
exit /b %bot_exit%
