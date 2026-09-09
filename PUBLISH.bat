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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Backups: mm's own shop crossed the 64 MB stored ceiling in September 2026 because its product photos live as BLOBs in the row store and a JPEG does not compress the way text does - every scheduled backup had been failing, twice a day, since. Raised to 200 MB; raise it again rather than lower it if a shop outgrows that too, and use retention (KEEP) for control-plane storage instead. Also fixed three test files (labels-symbology, weborder-delivery, smoke) that called initDb() without applying the schema, seeding the administrator or running migrations - on a database that already had those from a previous run they passed anyway, and on a truly fresh one all fifty-five of their subtests failed with 'no such table: users' or a wrong password. All three now bootstrap exactly as start() does. Also added an Export CSV button to the Products screen, honouring the same filters already on it, built on the same CSV encoder the Reports screen uses, paging past the repository's 500-row page ceiling so a shop bigger than that is not silently truncated - the same class of bug the stock count sheet once shipped, caught this time by a test that fails if the paging is reverted to one call. Also raised the product photo size limit from 400 KB to 5 MB after a phone photo at 513 KB was refused, and raised the request body limit alongside it from 5 MB to 8 MB since a base64 photo runs about a third bigger than what it decodes to and would otherwise have been capped around 3.5 MB regardless of the new photo limit - the same BLOB weight behind the backup ceiling above, so a bigger photo limit means bigger backups too. Also fixed the storefront loading slowly: measured against the live site, the page shell and images were already fast and already lazy, the real cost was one network round trip per brand logo firing the instant the home page painted. Brand logos of 20 KB or under are now inlined as data URIs directly in the brands list and home page responses, read in the same single query the brand list already ran, so the browser has the picture with zero further requests; larger logos are untouched and still fetched by address exactly as before. npm test 1273 -> 1279. Then, two days later, every scheduled backup started failing again - the 200 MB ceiling above was crossed too, the shop's last good backup at 128 MB on Sep 7 followed by 251-252 MB reads that failed on Sep 8 and Sep 9, almost certainly the same photo-size increase already taking effect: bigger photos allowed in, bigger BLOBs stored, bigger backups. Raised the ceiling again, to 400 MB, with the same standing note in the code now spelling out what a third crossing would mean: raise it again, or reconsider how large product photos actually need to be, rather than treat this constant as the only knob. Then, at his request to use less storage, lowered scheduled-backup retention (KEEP.scheduled) from 14 kept copies to 2 - a separate knob from the size ceiling above, this one controls how many stored copies pile up rather than how big any one of them is allowed to be, and lowering it trims the recoverable history window from roughly two weeks down to about a day, since the scheduled cron runs twice daily." >> "%LOG%" 2>&1
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
