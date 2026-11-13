@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 衡文点墨 HARNESS
set SD_OPEN_BROWSER=1

rem ---- Python 检测：优先用 py 启动器，其次 python，最后报错说清楚怎么装 ----
set PY=
where py >nul 2>&1 && set PY=py
if "%PY%"=="" (where python >nul 2>&1 && set PY=python)
if "%PY%"=="" (
  echo.
  echo   [缺少 Python] 没检测到 Python，无法启动。
  echo.
  echo   请先安装 Python 3.11 或更高版本：
  echo     https://www.python.org/downloads/
  echo   安装时务必勾选 "Add Python to PATH"，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

rem ---- 依赖检测：没装过就自动装一次（首次启动约 1-3 分钟）----
%PY% -c "import fastapi, uvicorn, requests" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   首次启动：正在安装依赖，请稍等 1-3 分钟（只需一次）...
  echo.
  %PY% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 (
    echo.
    echo   [安装失败] 请检查网络后重试，或手动执行：
    echo     %PY% -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   衡文点墨 · 正在启动本机服务
echo   地址：http://127.0.0.1:8770/app/
echo   关掉这个黑窗口 = 关掉服务
echo.
%PY% -m server.main
pause
