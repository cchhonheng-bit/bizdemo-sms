@echo off
rem ===========================================================================
rem  BACKUP (D-37): git bundle (full history) + zip of Source -> ..\Backup
rem  then push to GitHub (backup only, no Actions).
rem  Options: backup.cmd --no-push | --dir "E:\OneDrive\Backup"
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - BACKUP
where node >nul 2>nul || (echo Node.js 22 was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
node scripts\backup.mjs %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
