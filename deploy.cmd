@echo off
rem ===========================================================================
rem  DEPLOY TO PRODUCTION (one click) - D-37
rem  tests (secret scan, typecheck, lint, unit, RLS) -> if any fail: STOP
rem  -> supabase db push + functions deploy (PROD) -> build web -> Cloudflare Pages (PROD)
rem  Options: deploy.cmd --tests-only | --dry-run | --yes
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - DEPLOY PRODUCTION
where node >nul 2>nul || (echo Node.js 22 was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
where pnpm >nul 2>nul || (echo pnpm was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
node scripts\pipeline.mjs prod %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [ OK ] Finished.) else (echo [STOP] Not completed - read the red lines above. Exit code %RC%.)
pause
exit /b %RC%
