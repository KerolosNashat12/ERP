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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "The shop website wears the design its owner sent. Near-black paper, cards a step above it, cream text, and the shop's own colour on every price, every brand line, every hairline and every button - measured off the published page in his browser rather than guessed at, because figma.site cannot be reached from where this is built. Serif product names and section titles, in Playfair Display for English and Amiri for Arabic, since Playfair has no Arabic letters at all and an Arabic shop would otherwise have had its headings quietly fall back to the body sans and looked like a different shop in its own main language. Four-pixel corners, square photographs, and not one shadow anywhere - depth is carried by a hairline in the shop's colour at twenty-two percent, which is the single measurement that carries most of the look. Nothing about the site DOES anything different: same filters, same filter panel, same favourites, same checkout, same delivery arithmetic, same search, same banner controls. Every selector the new styles touch already existed, the browser check that drives the filters end to end in both languages and at both sizes still passes, and the storefront in daylight is asserted byte-for-byte identical to what it was, so a shop that has not chosen a dark identity sees no change and neither does the landing page. None of the colours are written into the stylesheet: they are what the palette deriver produces for a gold accent, so a shop that picks violet gets the same design in violet-black, and a shop that picks grey gets a true grey night rather than a red-tinted one. That last part found a bug that had been sitting in the deriver since it was written - one guard watching both ends of the range at once, invisible while colours only ever walked darker, which meant a shop whose accent was pure black would have been given a black price on a black page the moment it walked lighter. Also in this release, and more important than any of it: a swap with a supplier was taking money off a debt that was still owed in full. The value of what came back in exchange was computed on every replacement document and read by nothing, so a supplier replacing three faulty bottles with three identical ones took the price of three bottles off a debt where nothing had changed, and a swap for a dearer item moved the balance the wrong way entirely. The goods were always right; it was only the money. The credit is now what left minus what came back, and the order shows both halves and the net. And sending goods back and swapping them are two separate screens now rather than one screen with a chooser on it. 1061 tests passing." >> "%LOG%" 2>&1
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
