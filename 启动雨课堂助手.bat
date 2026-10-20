@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0ykt-helper-win\scripts\start-desktop.ps1" %*
set "YKT_LAUNCH_EXIT=%ERRORLEVEL%"
if "%YKT_LAUNCH_EXIT%"=="0" goto done
if /I "%~1"=="-CheckOnly" goto done
pause
:done
exit /b %YKT_LAUNCH_EXIT%
