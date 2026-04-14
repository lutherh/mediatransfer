@echo off
setlocal

REM Register or unregister MediaTransfer to start on Windows logon.
REM Usage:
REM   register-startup.cmd           - register the scheduled task
REM   register-startup.cmd remove    - remove the scheduled task

REM Require Administrator privileges
net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: This script requires Administrator privileges.
    echo Please right-click and "Run as Administrator".
    exit /b 1
)

for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"
set "TASK_NAME=MediaTransfer-StartAll"
set "START_CMD=%ROOT_DIR%\scripts\start-all.cmd"

if /i "%~1"=="remove" goto :remove

echo Registering "%TASK_NAME%" to run at logon...
schtasks /create /tn "%TASK_NAME%" /tr "\"%START_CMD%\"" /sc onlogon /rl highest /f
if %errorlevel% equ 0 (
    echo Done. MediaTransfer will start automatically on logon.
) else (
    echo ERROR: Failed to create scheduled task. Try running as Administrator.
    exit /b 1
)
goto :eof

:remove
echo Removing "%TASK_NAME%" scheduled task...
schtasks /delete /tn "%TASK_NAME%" /f
if %errorlevel% equ 0 (
    echo Done. MediaTransfer will no longer start on logon.
) else (
    echo ERROR: Failed to remove scheduled task.
    exit /b 1
)
