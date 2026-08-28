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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "The swap gets its own door, the sidebar says which build is live, and sixteen more edge cases on sending goods back to a supplier. The swap was already there but lived as a choice inside a dialog, and the owner looked for the word on the purchase order three times without finding it - a feature nobody can find is a feature nobody has - so the order now carries two buttons into ONE screen: send back to supplier, and swap with the supplier, the second opening it with the settlement already set so the columns for what is coming back are on screen before anybody has to know they exist. The build number rides on the call the shell already makes and prints beside the version, because is my update live took a browser and a search inside the JavaScript to answer. Then the edge cases, written after the feature worked, which is when the interesting ones are visible. A part-received order can only send back what actually ARRIVED, not what was ordered. One document can send back several lines and must leave the others alone. The same product on two lines keeps two separate allowances and each is credited at its own line cost. Shipping is not refunded - the lorry came. A cheaper swap leaves the difference the other way. Costs like 33.333 a piece stay to the piastre, and half a bottle can go back if that is how it was bought. Nothing, zero and a negative are all refused before anything moves. A line belonging to another order is a 404 rather than a quiet success. A draft order has received nothing whatever its lines say. Pressing send twice sends the goods back ONCE - the idempotency key makes the second press the same act as the first, and six pieces leaving the shelf because a button was double-clicked is the kind of thing nobody notices until a stock count. Two returns racing for the same carton cannot both win: one is refused and the shop never sends back more than it received. Returning does not re-price the stock still on the shelf. Every return is a numbered document with an audit row and a stock movement behind it. And the right to send goods back is the right to receive them, which the till does not have. 995 tests passing, 36 of them on this one module, and five browser checks." >> "%LOG%" 2>&1
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
