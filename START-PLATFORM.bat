@echo off
setlocal enabledelayedexpansion
title M&M Accessories ERP - platform mode
cd /d "%~dp0"

echo.
echo   M&M Accessories ERP - Platform (multi-tenant)
echo   ==========================================
echo.

REM --- Node.js check -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js was not found on this computer.
  echo.
  echo       Download the LTS version from https://nodejs.org
  echo       install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node.js !NODEVER! found.

REM --- Node 22.5+ is required: the database engine is built into Node itself,
REM     which is what keeps this install free of anything needing a compiler.
for /f "tokens=1 delims=." %%m in ("!NODEVER:v=!") do set NODEMAJOR=%%m
if !NODEMAJOR! LSS 22 (
  echo.
  echo   [X] This needs Node.js 22 or newer. You have !NODEVER!.
  echo.
  echo       Download the current version from https://nodejs.org
  echo       install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM --- Dependencies --------------------------------------------------------
if not exist "node_modules\" (
  echo.
  echo   First run: installing dependencies.
  echo   This needs the internet ONCE and takes about a minute...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

REM --- Platform switch -------------------------------------------------------
REM Turns on the multi-tenant platform for this run only. START.bat (no
REM switch set) keeps running the single-shop build exactly as before -
REM the two never conflict, they just point at different databases.
set MM_PLATFORM=1

REM --- Run -----------------------------------------------------------------
echo.
echo   ==========================================
echo   Starting in PLATFORM mode. Your browser will open at:
echo.
echo        http://localhost:4000
echo.
echo   That is the owner sign-in. On the very first run, a one-time
echo   password for the "owner" account is printed to THIS window -
echo   write it down, it is never shown again.
echo.
echo   Each shop then lives at  http://localhost:4000/t/^<slug^>
echo.
echo   KEEP THIS WINDOW OPEN while you use the system.
echo   Press Ctrl+C here to stop it.
echo   ==========================================
echo.

call npm start
goto :end

:failed
echo.
echo   [X] Something failed above.
echo       Take a screenshot of this window so it can be diagnosed.
echo.

:end
pause
