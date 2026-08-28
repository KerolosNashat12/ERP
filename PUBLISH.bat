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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "A session that belongs to one shop and to no other - plus the supplier-return screen, and a default picture wherever a shop has not uploaded one. THE SECURITY FIX FIRST, because it is the serious one. Every shop on this platform is its own database behind one deployment, one domain and one signing secret, and user ids start at 1 in each of them: every shop has a user 1, and any shop with staff has a 2 and a 3. The session token used to say only user 3. That is a true statement about every shop at once - so a cashier could sign in to their own shop, change the slug in the address bar from one shop to another, and the server would verify the signature with the same secret, read user 3, look that user up in the OTHER shop's database and serve the request as whoever their user 3 happens to be, with that person's permissions. Nothing in the request would look wrong in a log. The whole attack was editing a URL. The token now carries the shop it was issued for, the middleware refuses it anywhere else, and seven tests take a real unexpired session from one shop and try it against another as a cookie, as a bearer token, on the products, sales, dashboard and settings routes, and on the single-shop routes as well. With the check removed the first of those tests fails, which is how it is known to be testing something. The cookie is also scoped to its own shop's path now, so a browser does not even offer it elsewhere, and Secure follows the connection instead of being hard-coded off - the live shop's session cookie was allowed onto an unencrypted connection and now is not, while the shop PC on a plain LAN still works. Signing out clears it with the scope it was set with, which a cleared cookie needs or the browser keeps it. The console's token was already separate, signed with a different secret and carrying an audience, and there are now tests holding that line in both directions. Second: the supplier-return screen. It lives on the order the goods came in on, because that is where a person has both facts - the order, and the faulty bottle in their hand. Each line shows what arrived, what has already gone back, and what is ACTUALLY on the shelf, and the box is capped at the smallest of those, so the impossible return cannot be typed rather than being refused after the fact. Settlement is a choice of three - off what we owe, money back, or the same item again - and choosing replacement adds the coming-back column. Afterwards the order carries a strip saying what it came to, what went back, what is left and, when goods went back on an order already paid in full, that the supplier owes the shop this much, in those words. Every batch that has gone back is listed under Supplier Returns beside the orders, and one recorded in error is undone there, putting the stock back. Third: a product with no photograph now gets a drawn bottle in the shop's own accent and a brand with no logo gets its initials in a ring, in the card and in the brands rail, so a shelf never has a hole in it. 968 tests passing and five browser checks, including a whole supplier return done by clicking." >> "%LOG%" 2>&1
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
