@echo off
rem ===========================================================================
rem  Make Source identical to the delivered git history (Doc_Sup\06_Development\bizdemo-sms.bundle).
rem  Use it each time the AI team delivers a new bundle. Safe: your own uncommitted changes are
rem  committed first ("local changes before sync"); if histories diverged they stay in git reflog.
rem ===========================================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul
rem git rewrites this very file below - run from a copy in %TEMP% (P1)
if not defined HANGKH_SYNC_SRC (
  set "HANGKH_SYNC_SRC=%~dp0"
  copy /y "%~f0" "%TEMP%\hangkh-sync.cmd" >nul
  call "%TEMP%\hangkh-sync.cmd" %*
  exit /b !ERRORLEVEL!
)
cd /d "%HANGKH_SYNC_SRC%"
title HangKH - sync from bundle
set "BUNDLE=%HANGKH_SYNC_SRC%..\Doc_Sup\06_Development\bizdemo-sms.bundle"
if not exist "%BUNDLE%" (echo Bundle not found: %BUNDLE% & if /i not "%~1"=="/nopause" pause & exit /b 1)
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
if not "%DIRTY%"=="0" (echo Saving your local changes in a commit first... & git add -A & git -c user.name="HangKH Owner" -c user.email=owner@hangkh.local commit -q -m "local changes before sync" || (echo Could not save local changes - resetting the index & git reset -q))
git fetch -q "%BUNDLE%" main || (echo fetch failed & pause & exit /b 1)
git merge -q --ff-only FETCH_HEAD 2>nul || (echo Histories diverged - resetting to the delivered version ^(your commit stays in 'git reflog'^) & git reset -q --hard FETCH_HEAD)
:done
rem leftovers of older deliveries that git does not track (Supabase era, v2 single box)
for %%d in (supabase apps\web\mock apps\web\src\features\platform apps\web\dist-mock bizdemo-sms) do if exist "%%d" rd /s /q "%%d"
for %%f in (v2-sync.cmd compose.yml environments.json prod.env.example test.env.example test-local.cmd SETUP_LOCAL.md .env.test.local .env.prod.local apps\web\.env.local scripts\pipeline.mjs scripts\db-test.mjs scripts\seed-test.mjs scripts\env-file.mjs scripts\init-local-git.cmd deploy\post-receive deploy\install.sh deploy\backup.sh deploy\restore.sh deploy\Caddyfile) do if exist "%%f" del /q "%%f"
if /i "%~1"=="/nopause" (git log --oneline -1 & exit /b 0)
where pnpm >nul 2>nul && call pnpm.cmd install
echo.
echo Source is up to date. Next: owner-setup.cmd (server + deploy) or test.cmd / dev.cmd.
git log --oneline -3
pause
