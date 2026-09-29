@echo off
rem ===========================================================================
rem  DEV = run the real app on this PC (embedded PostgreSQL + API + web).
rem  Open http://localhost:5173 · accounts ceo/gm01/admin/kim/dara (password printed).
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - DEV (local)
where node >nul 2>nul || (echo Node.js 22 was not found. Install it from https://nodejs.org (LTS) and run again. & pause & exit /b 1)
if not exist node_modules (call pnpm.cmd install || (pause & exit /b 1))
node scripts\dev.mjs
pause
