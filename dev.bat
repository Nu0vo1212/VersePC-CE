@echo off
setlocal
cd /d "%~dp0"
title VersePC-CE Dev Mode

rem =====================================================================
rem  dev.bat - VersePC-CE development mode (frontend edits need NO recompile)
rem
rem  1. starts the frontend hot-reload server (scripts/dev-server.mjs),
rem     which feeds frontend/ straight into the debug window
rem  2. runs the debug kernel (recompiles ONLY when Rust sources change)
rem  3. frontend edit -> window auto-reloads; Rust edit -> rebuild + restart
rem
rem  For a release/portable exe use "npm run build" instead (7-9 min).
rem  NOTE: this file is GBK encoded - edit it with an editor set to GBK/ANSI.
rem =====================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node，请先安装 Node.js 并把它加入 PATH
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tauri.cmd" (
  echo   首次运行：正在安装依赖（走国内镜像）...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo   [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

echo.
echo   --------------------------------------------------------------
echo   改前端：保存后窗口自动刷新，不用重新编译
echo   改 Rust：自动重新编译并重启窗口
echo   首次会编译一次 debug 内核（约 1 分钟），之后几秒就能起来
echo   退出：按 Ctrl+C，或直接关掉本窗口
echo   --------------------------------------------------------------
echo.

call "node_modules\.bin\tauri.cmd" dev --config src-tauri/tauri.dev.conf.json %*
set RC=%ERRORLEVEL%

echo.
echo   开发模式已退出（exit code = %RC%）
pause
endlocal
exit /b %RC%
