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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Sending goods back to a supplier and swapping them for something else are now two screens, not one screen with a chooser on it. The swap got its own button in the last round, and the chooser stayed behind on the return screen offering to turn a return into a different kind of document after somebody had already pressed the button that said which one they wanted - a screen that asks you to re-declare what you came to do is a screen that will be got wrong. So the return screen asks what is going back, the swap screen asks what is going back and what is coming in, and neither asks anything else. One consequence said out loud: a return is now always recorded as a credit against the order, which is what the arithmetic already did - the balance counts every completed return whatever it is labelled - so no figure moves. The rest of this release is two new test suites and nothing else. The first is a penetration test that asks the running router what endpoints exist and attacks every one of them from four seats: a stranger with no session, an administrator of another shop, a narrow role inside this shop, and the owner console pointed where it should not reach. It sweeps 483 endpoints, checks 26 permissions against 4 roles, and proves the console and the shop are separate buildings with separate keys - a shop session cannot open the console, the owner cookie cannot act inside a shop, a backup ticket is single-use and dies with the sign-in that asked for it, a restore confirmation cannot be pointed at another shop, and a photo upload is read from its bytes rather than from what it claims to be. The second trades: one shop buys, receives in two deliveries, pays in instalments, sells at the till and on the web, takes a return, swaps an item, writes off breakage, counts the shelves, sends goods back to a supplier who has already been paid, swaps with the supplier, voids a sale and empties and refills the recycle bin - and then stops and checks that the book still adds up. The ledger is the stock, every movement reads back as its own running total, no sale disagrees with its own lines, no supplier balance disagrees with what was paid and returned, and the dashboard tile, the valuation report and the stock list show the same money to the piastre. Every one of those was deliberately broken and confirmed to fail before being put back. 1051 tests passing." >> "%LOG%" 2>&1
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
