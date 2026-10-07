@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22 or newer, then run npm install.
  pause
  exit /b 1
)
if not exist node_modules\typescript\bin\tsc (
  echo Run npm install before starting the application.
  pause
  exit /b 1
)
node node_modules\typescript\bin\tsc
if errorlevel 1 (
  pause
  exit /b 1
)
node dist\controller\index.js %*
if errorlevel 1 pause
