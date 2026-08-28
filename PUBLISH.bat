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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "One shelf, one set of numbers - and counters above Products, Stock and Suppliers. The owner photographed two of his own screens minutes apart: the home screen said 682 units and EGP 108,005 of stock, the valuation report said 673 and EGP 107,195. Same shop, same moment, two answers, nothing on either screen to say which was right. The cause was that each screen kept its own copy of the question - the home screen summed the whole stock view, while the report and the stock grid each added their own active-variants-only condition. Nine pieces were sitting on a variant somebody had switched off: real stock, real money, invisible on two screens out of three. It is one function now, and the rule is the one that matches the shelf: stock that EXISTS is counted whether or not the variant is still being sold, because a variant is switched off to stop selling it, not to stop owning it, and money that stops being counted when a checkbox is unticked is money that goes missing quietly. What used to be dropped is named instead - the tile now says how much of its total sits on stopped items, the report has a status column and a stopped-only filter, and a product with nine boxes in the back is no longer reported as out of stock because somebody unticked a box. Then the counters. Products: how many, how many variants, how many for women, for men, for everyone with the share of the catalogue each is, how many have an offer running today, how many are on the website, how many have run out, how many are switched off and how many still have no photo. Stock: what the shelf costs, what it is worth at selling price, the profit in between, how many lines, how many are low or gone, and the stopped stock when there is any. Suppliers: what is owed and to how many of them first, then open orders, then the total ever bought and the head count as small print - because the question a shop owner actually has about that screen is not how many suppliers he has. Every card that names a subset is a way INTO it: tapping the women card filters the list to those products, lights the card and moves the dropdown, and tapping it again puts everything back - a filter with no way off is a trap, and a narrowed screen with nothing saying why is worse. The cards read the same filters as the list beneath them, so a header can never describe a different set of rows from the table it is sitting on. 945 tests passing, including one that fails if the home screen and the report ever disagree about the same shelf again, and five browser checks." >> "%LOG%" 2>&1
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
