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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "A security sweep of every layer, a swap for a different item, and the brands screen saying why the website hides one. THE SECURITY FIRST. A full audit of tenant, user and console isolation turned up two critical holes and six lesser ones, all now closed with tests that fail if they come back. One: the identity cache - added yesterday to save two database round trips per request - keyed itself with the tenant CONTEXT OBJECT, and an object in a template literal is the string object Object for every shop alike. So it was one namespace keyed by user id alone: shop A's user 2 and shop B's user 2 were the same entry, and whichever shop asked second was served the other one's row and the other one's PERMISSIONS. The tenant claim in the token does not catch this, because the attacker uses their own valid token for their own shop. The test proves it through authorisation rather than identity - the same user id in two shops, an administrator in one and a stock clerk in the other - because the identity endpoint re-reads the profile from the right database and looks innocent while the decision behind it is being made from another shop's list. Two: file backups. The shop-side backup service knew nothing about tenants, so every shop wrote into one shared folder and then listed that whole folder back - shop B's administrator opened Settings, saw shop A's backup and could download it, and that file is the entire other shop: prices, costs, customers, payroll. Restore was worse in the other direction: it copied over the process default database rather than the caller's. Now a folder per shop, and restore on a fleet is refused and pointed at the console's own per-tenant restore. Also fixed: the console had NO rate limiting at all on the single most valuable password in the system, the one that can download and restore every shop on the fleet - unlimited guesses against a known username, and now six attempts and a ten minute lock; signing out of the console threw a ReferenceError on every attempt, so the owner's cookie was never cleared and the session survived every sign-out for twelve hours; the public image endpoint asked only whether the product was published while the shop window also requires it to be active, its brand and category published, and none of them in the recycle bin, so photographs of deleted and switched-off products were served to anybody counting upwards through sequential ids; the web order checkout never asked the recycle bin at all, so a deleted product could still be ordered by anyone holding its id from a cached page, reserving real stock; a user trusted with users.update could open their OWN record and set their role to Administrator, walking straight around the undelegatable permission list in two hops; and a public sort parameter reached an inherited property and answered 500. Second: a replacement can now be a DIFFERENT item. A supplier who cannot replace the faulty bottle sends another one against the same credit, at ITS cost, so an uneven swap leaves the difference owing rather than pretending both were worth the same - chosen on the return screen, both items moving on the shelf, and undone together if the return is reversed. Those two columns went into a NEW migration rather than into the one that shipped yesterday, because a migration that has already run never runs again and editing it would have added them to nobody. Third: the brands screen now says whether the website is showing each brand, and when it is not, which of the two reasons - not published, or no published products - because uploading a logo and seeing nothing happen on the site with nothing anywhere to explain it is not a thing anybody should have to guess at. 979 tests passing and five browser checks." >> "%LOG%" 2>&1
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
