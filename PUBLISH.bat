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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "A swap with a supplier was quietly taking money off an order that was still owed in full. The value of the goods coming back in exchange was computed correctly, written onto every replacement document, and then read by nothing at all: the balance subtracted what LEFT the shop and never added what ARRIVED. So a supplier replacing three faulty bottles with three identical ones - the most ordinary thing that happens on this screen - took the price of three bottles off a debt where nothing had changed, and an uneven swap was worse in the other direction, because sending back 200 of goods and receiving 300 of a better item moved the debt DOWN by 200 when it should have moved UP by 100. On a paid-up order it showed the supplier owing 500 when he owed 200. Nothing about the goods was wrong - both halves always moved on the shelf and the stock ledger was right throughout - it was only the money, on a screen that looked entirely normal. The credit a return is worth is now what left minus what came back, and the order shows both halves and the net rather than jumping from one to a total: sent back, came back instead, credit on this order. An ordinary return is unchanged, because nothing comes back against it. Also in this release: sending goods back and swapping them are two separate screens now instead of one screen with a chooser sitting on it, since the swap already had its own button and the chooser was still offering to turn a return into something else after the choice had been made. And two new test suites - a penetration test that asks the running router what endpoints exist and attacks all 483 of them from four seats including the owner console pointed where it should not reach, and a whole-book test that trades a miniature year across every module and then checks that the ledger is the stock, that every sale totals its own lines, that every supplier balance is the order minus its credit minus what was paid, and that the dashboard tile, the valuation report and the stock list show the same money to the piastre. Every one of those was deliberately broken and confirmed to fail before being put back, which is exactly how the swap bug was found. 1054 tests passing." >> "%LOG%" 2>&1
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
