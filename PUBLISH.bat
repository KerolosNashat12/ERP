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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Goods going back to the supplier, a discount that says which kind it is, and three screens that finally count the same pieces. The owner read 247 on the products page and 746 on the valuation report and asked which was right. Both were: one counts PRODUCTS, the other counts PIECES, and 313 against 307 was variants against variants-that-actually-have-stock. Nothing was miscalculated and nothing was reconciled by hand - the products page now says all of it out loud, pieces included, and there is a test that fails if that piece count ever stops matching the report's. A purchase return is now its own document rather than an edit of the order, for the same reason a sales return does not edit the invoice: the order records what was agreed and what arrived, and a shop reconciling a supplier statement in December needs the September order to still read the way it read in September. What the shop owes is derived from the order, its payments and its returns every time it is asked for, which is why they cannot disagree - and when goods go back on an order already paid in full that figure goes negative, which is correct and is said in words: the supplier owes the shop this much. Three refusals, each a different sentence because each needs a different action: more than the order ever received, naming how many are actually left after earlier returns; more than is on the shelf, which is the sold-it and the wrote-it-off-as-wastage case, naming what IS there; and anything at all against an order that received nothing or was cancelled. A replacement sends goods out and brings the same back inside one transaction, so a supplier who is short leaves the difference owing rather than leaving the shop having handed the goods over for nothing, and a return recorded in error is reversed rather than deleted, putting the stock back including a replacement's inbound half. A return credits what was actually PAID for that piece - the line discount, its tax, and its share of whatever the supplier took off the order as a whole - not the list cost, because crediting the list cost hands the shop money it never paid. The purchase discount can now be a rate or a sum of money, chosen on the form, stored as what was meant: 500 off used to become 4.1666 percent and come back as 499.99, which is how an order stopped matching the supplier's own invoice. And the website: a product with no photograph gets a drawn bottle in the shop's own accent and a brand with no logo gets its initials in a ring, so a shelf never has a hole in it; every card now fills its frame, so six products look like six products rather than six different sizes of thing; and the shop's logo has softened corners with no fixed size, so a square badge and a wide wordmark are both still themselves. 961 tests passing, 15 of them on the supplier return alone, every one of the owner's edge cases among them." >> "%LOG%" 2>&1
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
