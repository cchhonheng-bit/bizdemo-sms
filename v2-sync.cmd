@echo off
rem ===========================================================================
rem  ONE-TIME after receiving v2: make Source identical to the v2 git history
rem  (Doc_Sup\06_Development\bizdemo-sms.bundle) and remove the Supabase-era files.
rem  Safe: your own changes are kept in a backup commit / folder first.
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title One Team - v2 sync
set BUNDLE=%~dp0..\Doc_Sup\06_Development\bizdemo-sms.bundle
if not exist "%BUNDLE%" (echo Bundle not found: %BUNDLE% & pause & exit /b 1)
where git >nul 2>nul || (echo Git was not found. Install it from https://git-scm.com and run again. & pause & exit /b 1)
if exist .git goto haverepo
echo Source has no .git yet - creating it from the bundle (files are overwritten with v2)...
git init -q
git remote add bundle "%BUNDLE%" 2>nul
git fetch -q bundle main || (echo fetch failed & pause & exit /b 1)
git reset -q --hard FETCH_HEAD
git branch -M main
git remote remove bundle
goto cleanup
:haverepo
git status --porcelain >nul 2>nul
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set DIRTY=%%c
if not "%DIRTY%"=="0" (echo Saving your local changes in a commit first... & git add -A & git commit -q -m "local changes before v2 sync")
git fetch -q "%BUNDLE%" main || (echo fetch failed & pause & exit /b 1)
git merge -q --ff-only FETCH_HEAD 2>nul || (echo Histories diverged - resetting to v2 (your commit stays in 'git reflog') & git reset -q --hard FETCH_HEAD)
:cleanup
rem leftovers that git does not track (old installs)
for %%d in (supabase apps\web\mock apps\web\src\features\platform apps\web\dist-mock bizdemo-sms) do if exist "%%d" rd /s /q "%%d"
for %%f in (environments.json prod.env.example test.env.example test-local.cmd SETUP_LOCAL.md .env.test.local .env.prod.local apps\web\.env.local scripts\pipeline.mjs scripts\db-test.mjs scripts\seed-test.mjs scripts\env-file.mjs scripts\init-local-git.cmd) do if exist "%%f" del /q "%%f"
if exist node_modules rd /s /q node_modules
echo.
echo v2 files in place. Next: test.cmd (installs packages, runs all tests), then dev.cmd or deploy.cmd.
git log --oneline -3
pause
