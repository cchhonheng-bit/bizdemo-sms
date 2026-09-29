@echo off
rem ===========================================================================
rem  LOCAL = TEST (D-37) - never touches PRODUCTION
rem  test-local.cmd          tests -> DB + functions to TEST project -> seed -> web on http://localhost:5173
rem  test-local.cmd dev      only start the web app on http://localhost:5173 (TEST project)
rem  test-local.cmd tests    only run the checks (nothing is deployed)
rem  More options: --no-seed --no-dev --dry-run
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - LOCAL / TEST
where node >nul 2>nul || (echo Node.js 22 was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
where pnpm >nul 2>nul || (echo pnpm was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
set "ARGS=%*"
if /i "%~1"=="dev" set "ARGS=--dev-only"
if /i "%~1"=="tests" set "ARGS=--tests-only"
if not exist node_modules if /i "%~1"=="dev" call pnpm install --frozen-lockfile
node scripts\pipeline.mjs test %ARGS%
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [ OK ] Finished.) else (echo [STOP] Not completed - read the red lines above. Exit code %RC%.)
pause
exit /b %RC%
