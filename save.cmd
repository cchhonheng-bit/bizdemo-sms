@echo off
rem ===========================================================================
rem  SAVE = git commit of every change in Source (D-37). Secret scan runs first.
rem  save.cmd "short description of the change"
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - SAVE (git commit)
where node >nul 2>nul || (echo Node.js 22 was not found. Install it from https://nodejs.org (LTS). & pause & exit /b 1)
node scripts\save.mjs %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
