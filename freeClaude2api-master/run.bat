@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
title FreeModel Swapper

echo.
echo   FreeModel Swapper - startup checks
echo   ----------------------------------

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY where py >nul 2>&1 && set "PY=py"
if not defined PY (
    echo   [X] Python not found in PATH.
    echo       Install it from https://www.python.org/downloads/
    echo       and enable "Add python.exe to PATH" during setup.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo   [OK] %PYVER%

%PY% -m pip --version >nul 2>&1
if errorlevel 1 (
    echo   [X] pip not available. Trying to bootstrap with ensurepip...
    %PY% -m ensurepip --upgrade >nul 2>&1
    %PY% -m pip --version >nul 2>&1
    if errorlevel 1 (
        echo   [X] pip still missing. Reinstall Python with pip enabled.
        pause
        exit /b 1
    )
)
echo   [OK] pip available

set "MISSING="
for %%M in (fastapi httpx uvicorn brotli zstandard) do (
    %PY% -c "import %%M" >nul 2>&1
    if errorlevel 1 set "MISSING=!MISSING! %%M"
)
if defined MISSING (
    echo   [..] Installing missing dependencies:!MISSING! ...
    %PY% -m pip install --quiet!MISSING!
    if errorlevel 1 (
        echo   [X] Failed to install dependencies. Check your internet connection.
        pause
        exit /b 1
    )
    echo   [OK] Dependencies installed
) else (
    echo   [OK] Dependencies present
)

where claude >nul 2>&1
if errorlevel 1 (
    echo   [!!] Claude CLI not found on PATH.
    echo        Install it from https://docs.claude.com/claude-code
    echo        The proxy will still start, but "Launch Claude" needs the CLI.
) else (
    echo   [OK] Claude CLI found
)

set "KILLED="
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":8742 "') do (
    taskkill /PID %%p /F >nul 2>&1
    set "KILLED=1"
)
if defined KILLED (echo   [OK] Stopped previous proxy) else (echo   [OK] No previous proxy running)

echo   ----------------------------------
echo   All checks passed. Starting proxy...

start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:8742/"

timeout /t 1 >nul
cls

%PY% "%SCRIPT_DIR%proxy.py"
set "EXITCODE=%ERRORLEVEL%"

for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":8742 "') do taskkill /PID %%p /F >nul 2>&1

echo.
echo   ----------------------------------
echo   Proxy stopped (exit code %EXITCODE%). This window stays open so you can read any message above.
echo.
pause
