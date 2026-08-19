@echo off
setlocal enabledelayedexpansion
title M^&M Accessories - publish website settings update
cd /d "%~dp0"

set "ZIP=%~dp0mm-update.zip"
set "REPO=https://github.com/KerolosNashat12/ERP.git"
set "LOG=%~dp0publish-log.txt"
set "ATTEMPTS=12"

echo Publish started %DATE% %TIME%> "%LOG%"

echo.
echo   M^&M Accessories - publish
echo   ==========================================
echo   1. unpack the new files over this folder
echo   2. commit them
echo   3. push to GitHub (Vercel redeploys by itself)
echo.

if not exist "src\server.js" (
  echo   [X] Wrong folder - src\server.js is missing.
  echo.
  pause
  exit /b 1
)

if not exist "%ZIP%" (
  echo   [X] mm-update.zip is not next to this file.
  echo.
  pause
  exit /b 1
)

echo   Unpacking...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%CD%' -Force" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   [X] Could not unpack - see publish-log.txt
  echo.
  pause
  exit /b 1
)
echo   Files updated.

where git >nul 2>nul
if errorlevel 1 (
  echo   [X] Git is not installed. The files are updated locally,
  echo       but nothing was published.
  echo.
  pause
  exit /b 1
)

rem Windows TLS stack: git's own one cannot reach github from this machine.
git config --global http.sslBackend schannel >> "%LOG%" 2>&1
git config --global http.version HTTP/1.1 >> "%LOG%" 2>&1

if not exist ".git" (
  git init -b main >> "%LOG%" 2>&1
  git remote add origin "%REPO%" >> "%LOG%" 2>&1
) else (
  git remote set-url origin "%REPO%" >> "%LOG%" 2>&1
)

rem Working notes should not reach GitHub.
if exist "git-diagnosis.txt"   del /f /q "git-diagnosis.txt"   >> "%LOG%" 2>&1
if exist "push-log.txt"        del /f /q "push-log.txt"        >> "%LOG%" 2>&1
if exist "update-log.txt"      del /f /q "update-log.txt"      >> "%LOG%" 2>&1
if exist "hosted-db-setup.txt" del /f /q "hosted-db-setup.txt" >> "%LOG%" 2>&1

echo.
echo   Committing...
git add -A >> "%LOG%" 2>&1
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Hosted platform: control plane and tenants on Turso, adopt an existing shop database without reseeding it, owner password from the environment" >> "%LOG%" 2>&1
if errorlevel 1 echo   Nothing new to commit - pushing whatever is outstanding.

echo   Pushing (your connection to GitHub drops sometimes, so this retries)...
for /L %%i in (1,1,%ATTEMPTS%) do (
  echo. >> "%LOG%"
  echo --- push attempt %%i --- >> "%LOG%"
  git push origin HEAD:main >> "%LOG%" 2>&1
  if not errorlevel 1 (
    echo PUSH SUCCEEDED on attempt %%i >> "%LOG%"
    echo.
    echo   ==========================================
    echo   Published. Vercel is building now.
    echo   Settings -^> Website is the new tab.
    echo   ==========================================
    echo.
    pause
    exit /b 0
  )
  echo   attempt %%i failed, waiting 15s...
  timeout /t 15 /nobreak >nul
)

echo ALL PUSH ATTEMPTS FAILED >> "%LOG%"
echo.
echo   [X] The files are updated locally but GitHub could not be
echo       reached after %ATTEMPTS% tries. Run this again later,
echo       or try a phone hotspot. Details: publish-log.txt
echo.
pause
exit /b 1
