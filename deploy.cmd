@echo off
rem ===========================================================================
rem  DEPLOY = one click (Architecture v2 rule 4): tests -> git push to the VPS
rem  -> on the server: backup (pg_dump) -> build -> restart -> health check.
rem  First run: asks for the server address and installs the server.
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - DEPLOY
where node >nul 2>nul || (echo Node.js 22 was not found. Install it from https://nodejs.org (LTS) and run again. & pause & exit /b 1)
where git >nul 2>nul || (echo Git was not found. Install it from https://git-scm.com and run again. & pause & exit /b 1)
if not exist node_modules (call pnpm.cmd install || (pause & exit /b 1))
node scripts\deploy.mjs %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
