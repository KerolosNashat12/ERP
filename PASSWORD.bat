@echo off
setlocal enabledelayedexpansion
title M^&M Accessories - who can sign in, and set a new password
cd /d "%~dp0"

echo.
echo   M^&M Accessories - sign-in recovery
echo   ==========================================
echo   1. show the usernames that exist
echo   2. set a new password for one of them
echo.
echo   Your new password is typed here, on this machine.
echo   It is never shown on screen and never leaves this PC.
echo.

if not exist "src\server.js" (
  echo   [X] Wrong folder - src\server.js is missing.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed on this PC.
  echo.
  pause
  exit /b 1
)

rem Load .env if there is one, so the hosted database can be reached.
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    set "line=%%A"
    if not "!line:~0,1!"=="#" if not "%%B"=="" set "%%A=%%B"
  )
)

echo.
echo   Which database?
echo     [1] This PC  (the shop's own copy)
echo     [2] The live one on the internet  (erp-rust-one.vercel.app)
echo.
set "WHICH="
set /p WHICH=  Type 1 or 2 then press Enter:

if "%WHICH%"=="2" (
  if "%MM_DB_URL%"=="" if "%TURSO_DATABASE_URL%"=="" (
    echo.
    echo   [X] This PC does not have the live database's address saved.
    echo       It lives in Vercel: Project - Settings - Environment Variables,
    echo       as MM_DB_URL and MM_DB_AUTH_TOKEN. Copy those two into a file
    echo       called .env next to this one, then run this again.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo   Using the LIVE database.
) else (
  set "MM_DB_URL="
  set "TURSO_DATABASE_URL="
  echo.
  echo   Using this PC's own database.
)

echo.
echo   ------------------------------------------
node scripts\reset-password.js --list
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo   ------------------------------------------
echo.

set "WHO="
set /p WHO=  Type the username to give a new password (or just Enter to stop):
if "%WHO%"=="" (
  echo.
  echo   Nothing changed.
  echo.
  pause
  exit /b 0
)

echo.
node scripts\reset-password.js %WHO%

echo.
pause
