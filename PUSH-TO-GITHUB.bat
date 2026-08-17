@echo off
setlocal
title M^&M Accessories ERP - push to GitHub
cd /d "%~dp0"

set "REPO=https://github.com/KerolosNashat12/ERP.git"
set "LOG=%~dp0push-log.txt"

echo Push started %DATE% %TIME%> "%LOG%"

echo.
echo   Pushing this folder to GitHub
echo   ==========================================
echo   %CD%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo   [X] Git is not installed, or not on PATH.
  echo.
  pause
  exit /b 1
)

if not exist "src\server.js" (
  echo   [X] Wrong folder - src\server.js is missing.
  echo.
  pause
  exit /b 1
)

rem The schema moved into schema.js so serverless bundlers always ship it.
rem Remove the old .sql copy from disk and stage the deletion in one step.
if exist "src\infrastructure\database\schema.sql" (
  echo   Removing the superseded schema.sql...
  git rm -f --ignore-unmatch "src/infrastructure/database/schema.sql" >> "%LOG%" 2>&1
  if exist "src\infrastructure\database\schema.sql" del /f /q "src\infrastructure\database\schema.sql" >> "%LOG%" 2>&1
)

rem Working notes and logs should not go to GitHub.
if exist "git-diagnosis.txt" del /f /q "git-diagnosis.txt" >> "%LOG%" 2>&1
if exist "hosted-db-setup.txt" del /f /q "hosted-db-setup.txt" >> "%LOG%" 2>&1

if not exist ".git" (
  git init -b main >> "%LOG%" 2>&1
  git remote add origin "%REPO%" >> "%LOG%" 2>&1
) else (
  git remote set-url origin "%REPO%" >> "%LOG%" 2>&1
)

echo   Fetching...
git fetch origin main >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   [X] Could not reach GitHub - see push-log.txt
  echo.
  pause
  exit /b 1
)

git reset --soft FETCH_HEAD >> "%LOG%" 2>&1
git rm -r --cached --quiet . >> "%LOG%" 2>&1
git add -A >> "%LOG%" 2>&1
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Self-bootstrapping hosted database: schema as a module, importable seed, first-request init" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   Nothing changed compared to GitHub.
  echo.
  pause
  exit /b 0
)

echo   Pushing...
git push origin HEAD:main >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   [X] Push failed - see push-log.txt
  echo.
  pause
  exit /b 1
)

echo PUSH SUCCEEDED >> "%LOG%"
echo.
echo   ==========================================
echo   Pushed.
echo   ==========================================
echo.
pause
