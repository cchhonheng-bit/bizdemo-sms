@echo off
rem Start the web app (dev) — double-click or run from PowerShell: .\start-dev.cmd
cd /d "%~dp0"
call pnpm.cmd dev
pause
