@echo off
setlocal
title M^&M Accessories ERP - Reset database
cd /d "%~dp0"

echo.
echo   M^&M Accessories ERP - Reset database
echo   ==========================================
echo.
echo   This DELETES the current database and builds a fresh one
echo   with the example data.
echo.
echo   A timestamped copy of the old database is kept in:
echo        data\backups\
echo.
echo   Use this after updating to a new version, or to clear the
echo   example data before entering your real catalogue.
echo.

set /p CONFIRM=  Type YES and press Enter to continue:
if /i not "%CONFIRM%"=="YES" (
  echo.
  echo   Cancelled. Nothing was changed.
  echo.
  pause
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Node.js was not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
call npm run db:reset
if errorlevel 1 goto :failed

call npm run setup
if errorlevel 1 goto :failed

echo.
echo   Done. Double-click START.bat to run the system.
echo.
pause
exit /b 0

:failed
echo.
echo   [X] Something failed above. Take a screenshot of this window.
echo.
pause
