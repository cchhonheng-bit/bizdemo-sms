@echo off
rem ===========================================================================
rem  DEPLOY (MASTER PLAN v2.1):  deploy.cmd oneteam  |  deploy.cmd hub  |  deploy.cmd all
rem  tests -> pg_dump on the server -> docker build on THIS PC -> send image
rem  -> restart -> health check (unhealthy = previous version back). Any failure stops.
rem  Needs Docker Desktop running + SSH key login (SERVER_SETUP.md).
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title HangKH - DEPLOY %*
where node >nul 2>nul || (echo Node.js 22 was not found. Install it from https://nodejs.org (LTS) and run again. & pause & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop was not found. Install it from https://www.docker.com/products/docker-desktop and run again. & pause & exit /b 1)
if "%~1"=="" (echo Usage: deploy.cmd oneteam ^| hub ^| all & pause & exit /b 1)
if not exist node_modules (call pnpm.cmd install || (pause & exit /b 1))
node scripts\deploy.mjs %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
