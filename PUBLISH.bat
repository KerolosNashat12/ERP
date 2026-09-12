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
rem ---------------------------------------------------------------------------
rem STALE GIT LOCKS. An interrupted run leaves a .lock file behind and git then
rem refuses the operation it guards with "Another git process seems to be running
rem in this repository". This script used to carry straight on to the push, the
rem push honestly reported "Everything up-to-date" because nothing had been
rem committed, the retry loop printed PUSH SUCCEEDED, and the deploy check
rem confirmed the site was serving the commit it was already serving. A publish
rem that changed nothing reported success at every single step.
rem
rem There is MORE THAN ONE lock: index.lock guards "git add", HEAD.lock guards
rem "git commit", and refs\heads\main.lock guards moving the branch. Clearing
rem only index.lock got the add through and then failed on HEAD.lock - which is
rem exactly what happened here on 12 Sep 2026. So this clears EVERY .lock under
rem .git, which is safe precisely because no other git process is running: this
rem script is the only thing that touches this repository.
rem ---------------------------------------------------------------------------
set "LOCKSFOUND="
for /r ".git" %%L in (*.lock) do (
  set "LOCKSFOUND=1"
  del /f /q "%%L" >> "%LOG%" 2>&1
)
rem Earlier attempts renamed locks to *.lock.stale* instead of deleting them and
rem left the renamed files sitting in .git. They do nothing; sweep them up.
for /r ".git" %%L in (*.lock.stale*) do del /f /q "%%L" >> "%LOG%" 2>&1
if defined LOCKSFOUND echo   Cleared a stale git lock left by an interrupted run.

echo   Committing...
git add -A >> "%LOG%" 2>&1
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Publish from PC - %DATE% %TIME%" >> "%LOG%" 2>&1
if errorlevel 1 echo   Nothing new to commit - pushing whatever is outstanding.

echo   Pushing (your connection to GitHub drops sometimes, so this retries)...
for /L %%i in (1,1,%ATTEMPTS%) do (
  echo. >> "%LOG%"
  echo --- push attempt %%i --- >> "%LOG%"
  git push origin HEAD:main >> "%LOG%" 2>&1
  if not errorlevel 1 (
    echo PUSH SUCCEEDED on attempt %%i >> "%LOG%"
    for /f %%s in ('git rev-parse --short HEAD') do set "SHA=%%s"
    echo.
    echo   Pushed. Checking that the live site picked it up...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0WAIT-FOR-DEPLOY.ps1" -Sha "!SHA!" >> "%LOG%" 2>&1
    if not errorlevel 1 (
      echo.
      echo   ==========================================
      echo   Published AND confirmed live.
      echo   Settings -^> Website is the new tab.
      echo   ==========================================
    ) else (
      echo.
      echo   ==========================================
      echo   Pushed to GitHub, but could not yet confirm
      echo   it is live - the build may still be running.
      echo   Check publish-log.txt or vercel.com, or just
      echo   wait a minute and refresh the site.
      echo   ==========================================
    )
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
