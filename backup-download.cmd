@echo off
rem ===========================================================================
rem  Copy the newest database backups (hub + shop_oneteam) from the server to ..\Backup (IT, weekly).
rem  Server address: deploy\target.json · SSH key login.
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title HangKH - BACKUP DOWNLOAD
node scripts\backup-download.mjs
pause
