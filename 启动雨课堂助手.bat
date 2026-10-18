@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 雨课堂助手一键启动器

echo ========================================================
echo               雨课堂助手 (一键启动)
echo ========================================================
echo.

set "ROOT_DIR=%~dp0"
set "STANDALONE_DIR=%ROOT_DIR%ykt-helper-win\desktop\out\YuketangHelper-win32-x64"
set "STANDALONE_EXE=%STANDALONE_DIR%\YuketangHelper.exe"
set "STANDALONE_CN_EXE=%STANDALONE_DIR%\雨课堂助手.exe"
set "DEV_ELECTRON=%ROOT_DIR%ykt-helper-win\node_modules\electron\dist\electron.exe"
set "DEV_APP=%ROOT_DIR%ykt-helper-win\apps\desktop"

REM 1. 优先启动打包好的独立免安装版（无需Node/npm环境，0.1秒秒开）
if exist "%STANDALONE_CN_EXE%" (
  echo [1/1] 正在启动已编译的独立版程序 (雨课堂助手.exe)...
  start "" /D "%STANDALONE_DIR%" "%STANDALONE_CN_EXE%"
  goto :done
)

if exist "%STANDALONE_EXE%" (
  echo [1/1] 正在启动已编译的独立版程序 (YuketangHelper.exe)...
  start "" /D "%STANDALONE_DIR%" "%STANDALONE_EXE%"
  goto :done
)

REM 2. 如果未打包，回退到本地 Electron 运行时启动
if exist "%DEV_ELECTRON%" (
  echo [1/1] 正在通过本地 Electron 运行库启动...
  start "" /D "%DEV_APP%" "%DEV_ELECTRON%" .
  goto :done
)

REM 3. 如果环境不存在，给出清晰提示
echo [提示] 未检测到已打包程序或本地运行库。
echo 正在尝试自动安装并构建，请稍候...
cd /d "%ROOT_DIR%ykt-helper-win"
call npm start

:done
echo.
echo 启动完成！正在打开软件窗口...
timeout /t 3 >nul
exit /b 0
