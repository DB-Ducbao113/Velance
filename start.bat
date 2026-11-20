@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 24+ is required on PATH. 1>&2
    exit /b 1
)
if "%~1"=="" (
    node tools/p7/free-staging.mjs --mode review --port 8080
) else (
    node tools/p7/free-staging.mjs --mode review %*
)
exit /b %errorlevel%
