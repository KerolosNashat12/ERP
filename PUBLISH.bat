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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "The recycle bin: a delete button that says what it will do before it does it, and thirty days in which to change your mind. The owner asked for it in his own words - anything deleted goes to a bin, split by module, stays thirty days, and can be brought back, but before it goes make sure nothing else depends on it and be certain what it does to the money. Those two sentences are the whole design and everything else is what it took to keep them. What may be deleted is written down now in one place, per kind, with what it costs. Master data - a brand, a category, a supplier, a customer, a product, an employee, a promotion - is HIDDEN and never touched: restoring is exact, and destroying it for good is refused while anything still points at it, asked again on the day rather than assumed from the day it went in. Documents are REVERSED first, through the service that owns them, and then hidden: an invoice is voided, its stock put back and its money undone; a return un-writes-off the damaged pieces, takes the restocked ones back off the shelf, returns the loyalty points and cancels the store-credit voucher; a posted stock adjustment posts its opposite; a draft, which never moved anything, is simply destroyed. A cost leaves the ledger, and the dialog says by how much the month's profit will move before you press the button. The refusals matter more than the deletions: an invoice with a live return against it refuses and names it, a return whose store credit has already been spent refuses, a purchase order with goods received or money paid refuses. A restored invoice comes back VOID - restoring undoes the hiding, never the reversal, because the day that quietly stops being true is the day this system starts lying about money. And where cash was refunded from the till, the bin says so in plain words instead of pretending a computer put it back. That last promise needed a new column: a return carries its own state now, and one the bin undid stops counting as a refund everywhere at once - the home screen's revenue, the profit report, the returns report, the product's own history, and the console. Every existing return is 'completed', so no figure moves by a piastre today. Wastage and the recycle bin are in the owner console at last: the module list there was a hand-written copy of the server's and had gone stale, which is why opening a shop's settings showed no wastage to switch on. It is fenced by a test now so it cannot go stale again quietly. The shop report gained what is in each shop's bin and how much of it is days from being destroyed, and the console brings a shop's schema up to date on its own read path - a report should never answer 500 because a shop had not been migrated yet. One security detail worth naming: deleting asks for the right to delete THAT KIND OF THING - products.delete for a product, sales.void for an invoice - never the right to see the bin, which goes out with the audit log to few people. Gated the other way round, every delete button in the shop would have worked for the administrator and for nobody else. 826 tests, all passing." >> "%LOG%" 2>&1
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
