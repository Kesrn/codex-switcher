@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
set "CODEX_PROVIDER_HUB_DATA_DIR=%~dp0..\data"

:: Install dependencies if needed
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

:: Register startup and start the hub through the shared Node launcher.
node "%~dp0install-autostart.js" install-startup
if errorlevel 1 (
  echo Failed to install startup entry.
  pause
  exit /b 1
)

echo Starting Codex Provider Hub...
node "%~dp0install-autostart.js" start
if errorlevel 1 (
  echo Failed to start Codex Provider Hub.
  pause
  exit /b 1
)

:: Wait for hub to start
timeout /t 2 /nobreak > nul

:: Open the control panel
start http://127.0.0.1:8790

echo Codex Provider Hub started.
