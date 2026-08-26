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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Gender, offers, bulk edits and exchanges - the storefront filter panel rebuilt around a phone - and every document now says how many PIECES it is for. Every product says who it is for, women men or unisex, and the shop can be browsed that way; the classification screen suggests a gender from the name so 163 products do not have to be set one at a time, and the products page can set it for everything a filter matches in one pass. An offer is a percentage or an amount with a start and an end, and it is one rule in one file that the shop, the product page, the web orders and the till all read - so a discount cannot mean one thing on the website and another at the counter. A discounted card draws three things, the new price, the old one struck through and how much off, and the till charges the offer price without anybody remembering to. The filter panel is now groups that collapse, chips for gender with the count beside each, switches for on offer and in stock, price bands taken from what this shop actually sells, and the chosen filters listed above the results where each one can be taken off again. A group that would not narrow anything is not drawn at all, which is why an all-unisex shop shows no gender chips until the products are classified. On a phone it is a sheet that stays open while choices are made and closes on a button that says how many products are waiting - the previous version closed on the first tap and left the dark scrim behind it, which froze the page and is the kind of bug that loses a customer mid-order. Bulk edits are checkboxes with a bar saying how many are picked, one field at a time on purpose, and a confirmation naming the field, the value and the count. An exchange is a return plus a sale inside one transaction, line by line, so swapping one bottle out of a four line invoice leaves the other three exactly as they were; the credit is a payment on the new invoice and never a discount off it, so the month keeps the revenue the shop was actually given. Every refusal at the returns counter now has a code and a sentence in both languages. And the piece count: an order for 4 of one bottle and 52 of another says 56, on the order, on the invoice, on the customer's receipt, on a return and on a web order - the number is summed from the lines every time rather than stored, so it cannot drift away from them. Fixing that turned up a rougher edge underneath: typing a quantity rebuilt the whole line table around the box being typed into, which threw the caret away and made the browser refuse to remove a node that was no longer there. The row's own total is now patched in place and only the totals block is redrawn - the same lesson the products page taught with its checkboxes. The stock count screen had it too and is fixed the same way. 928 tests passing, plus four browser checks: the storefront at 1280 and 390 in both languages, the bulk and exchange screens, a whole exchange completed by clicking, and the piece count read off a real purchase order, a real invoice and a real receipt." >> "%LOG%" 2>&1
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
