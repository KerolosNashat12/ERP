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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Bulk edits, exchanges, and every refusal a returns counter needs. Three of the six things on this list turned out to need no database change at all, which is worth writing down because the instinct is always to add a column. Partial returns already worked, line by line, and had since the returns screen was built. Marking an invoice as fully returned needs no status value and no column: it is a fact about the lines, every line fully returned, and deriving it is the only way it cannot drift out of step with them - a stored flag has to be maintained by the return path, the reversal path, the recycle bin and anything written next year, and the first one to forget makes the invoice say something its own lines contradict. Bulk editing is the same UPDATE the product form already does, many times, in one transaction. What genuinely needed storing was the LINK between an exchange's two halves, and that is the one table this round adds. An exchange is not a third kind of document. It is a return plus a sale, both of which this system already knows how to do properly - they move stock through the ledger, treat a damaged piece differently from a resellable one, take back loyalty points, respect the return window, and are audited. Writing a third document that did all of that again would be a second implementation of the two most delicate paths in the shop, kept in step by good intentions. So the exchange orchestrates those two inside ONE transaction and owns exactly one thing: the row saying the original invoice, the return that credited it and the sale that replaced it are one act. If the replacement cannot be sold - no stock, a variant that does not exist - the return rolls back with it, so a customer is never left having handed a bottle over for nothing. The credit is a PAYMENT on the new invoice, never a discount off it: a 1,200 replacement settled with 800 of credit and 400 in cash is 1,200 of revenue paid for in two ways, and recorded as a discount it would take 800 off the month for money the shop had already been given. That needed a payment kind the header column has never heard of, so a payment method the header cannot hold now reads as mixed and the truth lives in the payments beneath it - no migration, no table rebuilt under a live shop. A cheaper swap hands the difference back in cash and it is recorded on the exchange rather than as a negative payment against an invoice that was settled in full, because payments that do not sum to what an invoice says was paid are how a reconciliation stops being trusted. The refusals got the most attention. Every one now carries a code and a sentence in both languages, because a cashier reading only 0 of that line remain unreturned to a customer standing in front of them is not a sentence anybody should have to say out loud. Returning more than was bought names how many are actually left. A line already fully returned says so. An invoice with nothing left on it says THAT, once, rather than complaining about whichever line was ticked first. A cancelled invoice, a window that has closed, an exchange with nothing coming back or nothing going out - each has its own words. And the recycle bin now refuses to delete half an exchange, naming the exchange and the invoice the customer already took away. Bulk edits are checkboxes with a bar that says how many are selected, a way to widen that to everything the current filter matches with the number said out loud first, one field at a time on purpose - a dialog that could set four things at once would need four leave-this-alone states, and the difference between set the brand to nothing and do not touch the brand is exactly the mistake that makes a bulk tool dangerous - and a confirmation naming the field, the value and the count. Only rows that actually move are written, each with one audit entry. 927 tests, all passing, including every scenario on the owner's own list: one product, several, all of them, only the selected ones changed; one line back, several, partial, whole invoice, more than bought, already returned, twice; dearer, cheaper and same-price exchanges with stock checked in both directions; and a rollback proving a failed exchange leaves nothing half-done. Plus the screens driven in a real browser, and an exchange completed by clicking." >> "%LOG%" 2>&1
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
