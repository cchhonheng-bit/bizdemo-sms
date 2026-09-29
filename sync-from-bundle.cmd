@echo off
rem ===========================================================================
rem  Make Source identical to the delivered git history (Doc_Sup\06_Development\bizdemo-sms.bundle).
rem  Use it each time the AI team delivers a new bundle. Safe: your own uncommitted changes are
rem  committed first ("local changes before sync"); if histories diverged they stay in git reflog.
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title HangKH - sync from bundle
set BUNDLE=%~dp0..\Doc_Sup\06_Development\bizdemo-sms.bundle
if not exist "%BUNDLE%" (echo Bundle not found: %BUNDLE% & pause & exit /b 1)
where git >nul 2>nul || (echo Git was not found. Install it from https://git-scm.com and run again. & pause & exit /b 1)
if exist .git goto haverepo
echo Source has no .git yet - creating it from the bundle...
git init -q
git fetch -q "%BUNDLE%" main || (echo fetch failed & pause & exit /b 1)
git reset -q --hard FETCH_HEAD
git branch -M main
goto done
:haverepo
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set DIRTY=%%c
if not "%DIRTY%"=="0" (echo Saving your local changes in a commit first... & git add -A & git commit -q -m "local changes before sync")
git fetch -q "%BUNDLE%" main || (echo fetch failed & pause & exit /b 1)
git merge -q --ff-only FETCH_HEAD 2>nul || (echo Histories diverged - resetting to the delivered version ^(your commit stays in 'git reflog'^) & git reset -q --hard FETCH_HEAD)
:done
for %%f in (v2-sync.cmd compose.yml) do if exist "%%f" del /q "%%f"
where pnpm >nul 2>nul && call pnpm.cmd install
echo.
echo Source is up to date. Next: test.cmd, then dev.cmd (local) or deploy.cmd all (server).
git log --oneline -3
pause
