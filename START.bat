@echo off
setlocal enabledelayedexpansion
title M^&M Accessories ERP
cd /d "%~dp0"

echo.
echo   M^&M Accessories ERP
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

REM --- Database ------------------------------------------------------------
if not exist "data\mm-accessories.db" (
  echo.
  echo   Creating the database and the example data...
  echo.
  call npm run setup
  if errorlevel 1 goto :failed
)

REM --- Run -----------------------------------------------------------------
echo.
echo   ==========================================
echo   Starting. Your browser will open at:
echo.
echo        http://localhost:4000
echo.
echo   Sign in:  admin  /  admin123
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
