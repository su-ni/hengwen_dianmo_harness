@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 衡文点墨 · 构建前端
echo.
echo   仅在需要改前端源码时才用这个。
echo   正常使用直接双击 start.bat —— web\app-dist\ 里已经带构建好的产物。
echo.
echo   注意：本项目前端有一个 2700+ 行的页面，Node 默认内存不够会崩，
echo   这里已经把内存上限提到 4G。
echo.
set NODE_OPTIONS=--max-old-space-size=4096
cd app
call npm install
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail
echo.
echo   构建完成，产物在 ..\web\app-dist\
echo.
pause
exit /b 0

:fail
echo.
echo   [构建失败] 检查是否已安装 Node.js 18+：https://nodejs.org/
echo.
pause
exit /b 1
