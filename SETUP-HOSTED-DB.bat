@echo off
setlocal enabledelayedexpansion
title M^&M Accessories ERP - prepare the hosted database
cd /d "%~dp0"

set "LOG=%~dp0hosted-db-setup.txt"
echo Setup started %DATE% %TIME%> "%LOG%"

echo.
echo   Prepare the hosted (Turso) database
echo   ==========================================
echo   Run this ONCE. It creates the tables and the
echo   first admin user in the database your Vercel
echo   site uses.
echo.
echo   Get the two values from:
echo     Vercel -^> Storage -^> database-citrine-pillar
echo     Quickstart -^> .env.local tab -^> Show secret
echo.
echo   You can paste with a right-click.
echo   It is fine to paste the whole line including
echo   the name and quotes - I will clean it up.
echo.

if not exist "src\server.js" (
  echo   [X] Wrong folder - src\server.js is missing.
  echo.
  pause
  exit /b 1
)

rem Pick the values up from .env.local if the user already pulled them.
if exist ".env.local" (
  echo   Found .env.local - reading it.
  for /f "usebackq tokens=1,* delims==" %%a in (".env.local") do (
    if /i "%%a"=="TURSO_DATABASE_URL" set "DBURL=%%b"
    if /i "%%a"=="TURSO_AUTH_TOKEN" set "DBTOKEN=%%b"
  )
)

if "!DBURL!"=="" (
  echo.
  set /p "DBURL=  Paste TURSO_DATABASE_URL, then Enter: "
)
if "!DBTOKEN!"=="" (
  echo.
  set /p "DBTOKEN=  Paste TURSO_AUTH_TOKEN, then Enter: "
)

rem Tolerate a pasted "NAME=value" line, and strip surrounding quotes.
for /f "tokens=1,* delims==" %%a in ("!DBURL!") do (
  if /i "%%a"=="TURSO_DATABASE_URL" set "DBURL=%%b"
)
for /f "tokens=1,* delims==" %%a in ("!DBTOKEN!") do (
  if /i "%%a"=="TURSO_AUTH_TOKEN" set "DBTOKEN=%%b"
)
set "DBURL=!DBURL:"=!"
set "DBTOKEN=!DBTOKEN:"=!"

if "!DBURL!"=="" (
  echo   [X] No database URL given - nothing to do.
  echo.
  pause
  exit /b 1
)

rem Log only the shape, never the secret itself.
echo url_starts_with=!DBURL:~0,12! >> "%LOG%"
echo token_length_check=!DBTOKEN:~0,4!... >> "%LOG%"

set "MM_DB_URL=!DBURL!"
set "MM_DB_AUTH_TOKEN=!DBTOKEN!"

rem Only needed so the config layer loads; the real secret lives in Vercel.
set "MM_JWT_SECRET=setup-only-not-used-by-the-deployed-site-000000"

if not exist "node_modules" (
  echo.
  echo   Installing dependencies - about a minute...
  call npm install >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo   [X] npm install failed - see hosted-db-setup.txt
    echo.
    pause
    exit /b 1
  )
)

rem The hosted driver is an optional dependency, so make sure it is present.
if not exist "node_modules\@libsql" (
  echo   Adding the hosted database client...
  call npm install @libsql/client --no-save >> "%LOG%" 2>&1
)

echo.
echo   Creating tables...
call npm run db:migrate >> "%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Could not reach the database.
  echo       Check the URL and token and run this again.
  echo       Details: hosted-db-setup.txt
  echo.
  pause
  exit /b 1
)

echo   Seeding the admin user and one worked example...
call npm run db:demo >> "%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Seeding failed. Tables exist, so you can re-run this.
  echo       Details: hosted-db-setup.txt
  echo.
  pause
  exit /b 1
)

echo SETUP SUCCEEDED >> "%LOG%"
echo.
echo   ==========================================
echo   Done. Your Vercel site can now sign in with
echo       admin / admin123
echo   CHANGE THAT PASSWORD IMMEDIATELY - the site
echo   is public.
echo   ==========================================
echo.
pause
