@echo off
REM Thin shim for Windows cmd.exe — delegates to the cross-platform
REM PowerShell implementation. Works without Git Bash, WSL, or any bash
REM dependency. Prefers `pwsh` (PowerShell 7+) when available, otherwise
REM falls back to Windows PowerShell 5.1 which ships with every Windows 10+.
setlocal

set "SCRIPT=%~dp0start-all.ps1"

where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
exit /b %ERRORLEVEL%
