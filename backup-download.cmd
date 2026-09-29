@echo off
rem ===========================================================================
rem  Copy the newest database backup from the server to ..\Backup (weekly, IT).
rem  Uses the "vps" git remote set up by deploy.cmd (SSH key login).
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - BACKUP DOWNLOAD
for /f "tokens=*" %%r in ('git remote get-url vps') do set REMOTE=%%r
if "%REMOTE%"=="" (echo No "vps" remote yet - run deploy.cmd first. & pause & exit /b 1)
for /f "tokens=1 delims=:" %%h in ("%REMOTE%") do set HOST=%%h
for /f "tokens=*" %%f in ('ssh %HOST% "ls -t /opt/oneteam/backups/oneteam-*.sql.gz | head -1"') do set LATEST=%%f
if "%LATEST%"=="" (echo No backup found on the server. & pause & exit /b 1)
if not exist "..\Backup" mkdir "..\Backup"
scp "%HOST%:%LATEST%" "..\Backup\"
echo Downloaded %LATEST% to ..\Backup
pause
