@echo off
setlocal

REM Resolve mediatransfer root (parent of scripts/)
for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"

REM Find Git Bash
if exist "C:\Program Files\Git\bin\bash.exe" (
    set "GIT_BASH=C:\Program Files\Git\bin\bash.exe"
    goto :found
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    set "GIT_BASH=C:\Program Files (x86)\Git\bin\bash.exe"
    goto :found
)
echo ERROR: Git Bash not found
exit /b 1

:found
"%GIT_BASH%" -c "cd \"$(cygpath '%ROOT_DIR%')\" && ./scripts/start-all.sh %*"
