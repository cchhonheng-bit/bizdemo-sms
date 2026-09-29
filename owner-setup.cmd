@echo off
rem ===========================================================================
rem  HangKH - ONE CLICK server setup + deploy for the owner (no IT needed).
rem  Safe to run again: finished steps are skipped. Stops only when you must type:
rem    the server password (once), the sudo password (if asked), the bot token (Notepad), an e-mail.
rem  Options: --verify (checks only), --new-token, --redeploy, --reinit
rem  Report: ..\Doc_Sup\SETUP_REPORT.html (no passwords / tokens inside)
rem ===========================================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title HangKH - owner setup

rem --- 0. tools (Git, Node.js 22) - installed with winget if missing -------------------
set NEED=
where git >nul 2>nul || set NEED=!NEED! Git.Git
where node >nul 2>nul || set NEED=!NEED! OpenJS.NodeJS.LTS
if not "!NEED!"=="" (
  echo.
  echo  [0] Missing on this PC:!NEED!
  where winget >nul 2>nul || (echo  winget not found. Install Git from https://git-scm.com and Node.js LTS from https://nodejs.org then run owner-setup.cmd again. & pause & exit /b 1)
  set /p OKI=  Install now with winget? [Y/n]:
  if /i "!OKI!"=="n" (echo  Stopped. & pause & exit /b 1)
  for %%p in (!NEED!) do winget install -e --id %%p --accept-package-agreements --accept-source-agreements || (echo  ERROR installing %%p & pause & exit /b 1)
  echo.
  echo  Installed. CLOSE this window and double-click owner-setup.cmd again ^(so Windows finds the new programs^).
  pause & exit /b 0
)
where docker >nul 2>nul || (
  echo.
  echo  [0] Docker Desktop is not installed ^(needed to build the app on this PC^).
  where winget >nul 2>nul && (
    set /p OKD=  Install Docker Desktop now with winget? [Y/n]:
    if /i not "!OKD!"=="n" (
      winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
      echo.
      echo  Docker Desktop installed. RESTART the PC, open Docker Desktop once ^(Accept, Skip sign-in^), then run owner-setup.cmd again.
      echo  ^(The server steps can run now - continuing; the deploy step will wait for Docker.^)
      echo.
    )
  )
)

rem --- 1. make Source match the delivered bundle (no pause) ------------------------------
if exist sync-from-bundle.cmd call sync-from-bundle.cmd /nopause || (echo  ERROR: sync-from-bundle failed & pause & exit /b 1)
if not exist scripts\owner-setup.mjs (echo  ERROR: scripts\owner-setup.mjs missing - the bundle in Doc_Sup\06_Development is older than this file. & pause & exit /b 1)

rem --- 2. packages ---------------------------------------------------------------------------
where pnpm >nul 2>nul || (call npm install -g pnpm@9 || (echo  ERROR installing pnpm & pause & exit /b 1))
if not exist node_modules\.modules.yaml (call pnpm.cmd install --frozen-lockfile || (echo  ERROR: pnpm install & pause & exit /b 1))

rem --- 3. the real work -----------------------------------------------------------------------
node scripts\owner-setup.mjs %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
