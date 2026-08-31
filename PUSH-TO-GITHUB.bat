@echo off
setlocal
title M^&M Accessories ERP - push to GitHub
cd /d "%~dp0"

set "REPO=https://github.com/KerolosNashat12/ERP.git"

echo.
echo   Pushing this folder to GitHub
echo   ==========================================
echo   Folder: %CD%
echo   Repo:   %REPO%
echo.

where git >/dev/null 2>nul
if errorlevel 1 (
  echo   [X] Git is not installed, or not on PATH.
  echo       Install it from https://git-scm.com/download/win and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "src\server.js" (
  echo   [X] This does not look like the project folder.
  echo       src\server.js is missing. Put this file next to package.json.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo   Setting up git in this folder...
  git init -b main
  git remote add origin "%REPO%"
) else (
  git remote set-url origin "%REPO%" 2>/dev/null || git remote add origin "%REPO%"
)

echo.
echo   Fetching what is already on GitHub...
git fetch origin main
if errorlevel 1 (
  echo.
  echo   [!] Could not reach GitHub. If it asked you to sign in and you
  echo       cancelled, run this file again and complete the sign-in.
  echo.
  pause
  exit /b 1
)

rem Build this version as a normal commit on top of what is already there,
rem so nothing is force-pushed and no history is lost.
git reset --soft FETCH_HEAD
git add -A
git commit -m "Repeating costs: daily, weekly, monthly and yearly - and three bugs found building it"
if errorlevel 1 (
  echo.
  echo   Nothing changed compared to GitHub - already up to date.
  echo.
  pause
  exit /b 0
)

echo.
echo   Pushing...
git push origin HEAD:main
if errorlevel 1 (
  echo.
  echo   [X] Push failed. Usually a cancelled GitHub sign-in - run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo   Pushed. Vercel will pick up the new commit and redeploy.
echo   ==========================================
echo.
pause
