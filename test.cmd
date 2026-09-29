@echo off
rem ===========================================================================
rem  TEST = one command (Architecture v2 rule 4): secret scan, typecheck, lint,
rem  unit tests, API tests on an embedded PostgreSQL 16 (no Docker on the PC).
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - TEST
where node >nul 2>nul || (echo Node.js 22 was not found. Install it from https://nodejs.org (LTS) and run again. & pause & exit /b 1)
if not exist node_modules (call pnpm.cmd install || (pause & exit /b 1))
node scripts\test.mjs
set RC=%ERRORLEVEL%
pause
exit /b %RC%
