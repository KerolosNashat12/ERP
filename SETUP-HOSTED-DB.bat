@echo off
setlocal enabledelayedexpansion
title M^&M Accessories ERP - prepare the hosted database
cd /d "%~dp0"

echo.
echo   Prepare the hosted (Turso) database
echo   ==========================================
echo.
echo   This creates the tables and the first admin user in the database
echo   your Vercel deployment will use. Run it ONCE.
echo.
echo   You need two values from Vercel:
echo     Project Settings -^> Environment Variables
echo     TURSO_DATABASE_URL   (starts with libsql:// or https://)
echo     TURSO_AUTH_TOKEN     (a long string)
echo.

if exist ".env.local" (
  echo   Found .env.local - reading the values from it.
  for /f "usebackq tokens=1,* delims==" %%a in (".env.local") do (
    if /i "%%a"=="TURSO_DATABASE_URL" set "TURSO_DATABASE_URL=%%b"
    if /i "%%a"=="TURSO_AUTH_TOKEN" set "TURSO_AUTH_TOKEN=%%b"
  )
)

if "%TURSO_DATABASE_URL%"=="" (
  echo.
  set /p "TURSO_DATABASE_URL=  Paste TURSO_DATABASE_URL and press Enter: "
)
if "%TURSO_AUTH_TOKEN%"=="" (
  set /p "TURSO_AUTH_TOKEN=  Paste TURSO_AUTH_TOKEN and press Enter: "
)

if "%TURSO_DATABASE_URL%"=="" (
  echo   [X] No database URL given - nothing to do.
  pause
  exit /b 1
)

set "TURSO_DATABASE_URL=%TURSO_DATABASE_URL:"=%"
set "TURSO_AUTH_TOKEN=%TURSO_AUTH_TOKEN:"=%"

if not exist "node_modules" (
  echo.
  echo   Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo   [X] npm install failed.
    pause
    exit /b 1
  )
)

rem A secret is only needed so the config layer will load; the real one lives in Vercel.
set "MM_JWT_SECRET=setup-only-not-used-at-runtime-0000000000000000"

echo.
echo   Creating tables...
call npm run db:migrate
if errorlevel 1 (
  echo.
  echo   [X] Could not reach the database. Check the URL and token, then try again.
  pause
  exit /b 1
)

echo.
echo   Seeding the admin user and one worked example...
call npm run db:demo
if errorlevel 1 (
  echo.
  echo   [X] Seeding failed. The tables exist; you can re-run this file.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo   Done. Your Vercel URL can now sign in with:
echo       admin / admin123
echo   CHANGE THAT PASSWORD IMMEDIATELY - the site is public.
echo   ==========================================
echo.
pause
