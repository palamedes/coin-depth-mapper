@echo off
rem Relief Depth Studio for Windows: double-click, or run "run.bat --port 9000".
setlocal
cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 (
  echo Relief Depth Studio needs uv: https://docs.astral.sh/uv/getting-started/installation/
  echo In PowerShell: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  pause
  exit /b 1
)

if not exist "src\relief_depth_studio\web\index.html" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo The web page has not been built and Node.js is not installed: https://nodejs.org
    pause
    exit /b 1
  )
  pushd frontend
  call npm ci --no-audit --no-fund --loglevel=error
  call npm run build
  popd
)

uv run --project "%~dp0." depthmap %*
if errorlevel 1 pause
