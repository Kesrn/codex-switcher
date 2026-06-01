@echo off
setlocal
cd /d "%~dp0"
set "CODEX_PROVIDER_HUB_DATA_DIR=%~dp0..\data"

if not exist node_modules (
  npm install
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue; if (-not $p) { Start-Process -WindowStyle Hidden node -ArgumentList 'install-autostart.js start' -WorkingDirectory '%cd%' }"

timeout /t 1 /nobreak > nul
start http://127.0.0.1:8790
