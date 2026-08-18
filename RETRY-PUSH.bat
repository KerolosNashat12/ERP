@echo off
setlocal enabledelayedexpansion
title M^&M Accessories ERP - retry push
cd /d "%~dp0"

set "REPO=https://github.com/KerolosNashat12/ERP.git"
set "LOG=%~dp0push-log.txt"
set "ATTEMPTS=12"

echo Retry push started %DATE% %TIME%> "%LOG%"

echo.
echo   Pushing to GitHub
echo   ==========================================
echo   Your connection to github.com is dropping
echo   intermittently, so this will keep trying.
echo.

rem Windows TLS stack — git's bundled one cannot reach github here.
git config --global http.sslBackend schannel >> "%LOG%" 2>&1
git config --global http.version HTTP/1.1 >> "%LOG%" 2>&1
git config --global http.lowSpeedLimit 1000 >> "%LOG%" 2>&1
git config --global http.lowSpeedTime 20 >> "%LOG%" 2>&1

if not exist ".git" (
  echo   [X] No git repository here.
  echo.
  pause
  exit /b 1
)
git remote set-url origin "%REPO%" >> "%LOG%" 2>&1

rem Stage whatever is outstanding, so a half-finished earlier run is picked up.
git add -A >> "%LOG%" 2>&1
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Login hardening, admin-approved password reset, scan into product form, optional variants, Arabic translations" >> "%LOG%" 2>&1

for /L %%i in (1,1,%ATTEMPTS%) do (
  echo   Attempt %%i of %ATTEMPTS% ...
  echo. >> "%LOG%"
  echo --- attempt %%i --- >> "%LOG%"
  git push origin HEAD:main >> "%LOG%" 2>&1
  if not errorlevel 1 (
    echo PUSH SUCCEEDED on attempt %%i >> "%LOG%"
    echo.
    echo   ==========================================
    echo   Pushed on attempt %%i. Vercel will redeploy.
    echo   ==========================================
    echo.
    pause
    exit /b 0
  )
  echo   ...connection failed, waiting 15s
  timeout /t 15 /nobreak >nul
)

echo ALL ATTEMPTS FAILED >> "%LOG%"
echo.
echo   [X] Could not reach GitHub after %ATTEMPTS% tries.
echo       Your connection to github.com:443 keeps dropping,
echo       though ordinary web browsing works. Try again on a
echo       different network - a phone hotspot is a good test.
echo.
pause
exit /b 1
