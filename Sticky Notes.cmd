@echo off
rem Fallback launcher - shows a console window. Prefer "Sticky Notes.vbs".
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
