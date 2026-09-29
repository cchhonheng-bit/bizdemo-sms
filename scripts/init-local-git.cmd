@echo off
rem ===========================================================================
rem  ONE-TIME: turn Oneteam_Engineering\Source into the git working copy (D-37).
rem  Takes the full history from Doc_Sup\06_Development\bizdemo-sms.bundle,
rem  keeps every file in Source as it is, sets GitHub as backup remote,
rem  and enables the pre-commit secret scan.
rem ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where git >nul 2>nul || (echo Git was not found. See SETUP_LOCAL.md step 1. & pause & exit /b 1)
if not exist package.json (echo Run this from Oneteam_Engineering\Source\scripts. & pause & exit /b 1)

if exist .git (
  echo Source is already a git repository - only checking settings.
  goto settings
)
set "BUNDLE=..\Doc_Sup\06_Development\bizdemo-sms.bundle"
if not exist "%BUNDLE%" (echo Not found: %BUNDLE% & pause & exit /b 1)
if exist _gittmp rmdir /s /q _gittmp
git clone --no-checkout "%BUNDLE%" _gittmp || (echo git clone failed & pause & exit /b 1)
attrib -h _gittmp\.git >nul 2>nul
move _gittmp\.git .git >nul || (echo could not move .git & pause & exit /b 1)
rmdir /s /q _gittmp
git reset -q || (echo git reset failed & pause & exit /b 1)
attrib +h .git >nul 2>nul

:settings
rem D-37/D-41: files removed from the project (they stay in git history)
if exist docs\STAGING_SETUP.md del /q docs\STAGING_SETUP.md
if exist scripts\seed_staging.py del /q scripts\seed_staging.py
if exist scripts\cf_pages_domain.py del /q scripts\cf_pages_domain.py
if exist scripts\__pycache__ rmdir /s /q scripts\__pycache__
if exist start-dev.cmd del /q start-dev.cmd
git config core.autocrlf false
git config core.hooksPath scripts/git-hooks
git remote get-url origin >nul 2>nul && git remote set-url origin https://github.com/cchhonheng-bit/bizdemo-sms.git
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/cchhonheng-bit/bizdemo-sms.git
git branch -D develop >nul 2>nul
echo.
echo ==== git status (should say "nothing to commit") ====
git status --short
git log --oneline -3
echo.
echo Done. Next: SETUP_LOCAL.md step 4.
pause
