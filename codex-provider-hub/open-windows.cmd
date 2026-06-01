@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
set "CODEX_PROVIDER_HUB_DATA_DIR=%~dp0..\data"
set "PID_FILE=%CODEX_PROVIDER_HUB_DATA_DIR%\hub.pid"

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

:: Check if hub is already running
if exist "%PID_FILE%" (
  set /p PID=<"%PID_FILE%"
  tasklist /FI "PID eq !PID!" 2>nul | findstr /I "node.exe" >nul
  if !errorlevel! equ 0 (
    echo Hub is already running (PID: !PID!).
    start http://127.0.0.1:8790
    exit /b 0
  )
)

:: Start the hub
echo Starting Codex Provider Hub...
start "" /min node "%~dp0hub.js"

:: Wait for hub to start
timeout /t 2 /nobreak > nul

:: Open the control panel
start http://127.0.0.1:8790

echo Codex Provider Hub started.
