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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "Four rounds in one publish. PHOTOS: the invoice photo button opened the camera and offered nothing else, so a photo taken earlier or sent on WhatsApp could not be attached at all. One attribute, capture=environment, which on iOS means the camera is the ONLY source and the Photo Library sheet never appears. Removed everywhere it reached: filing an invoice, adding a page to a saved one, a cost's bill, a salary payment, a supplier payment. A paper invoice is several pages, so the invoice picker now takes several photographs in one selection and files each as its own page, resized on the phone. SEARCH: one engine shared by the server and both browsers, a normalised index, and suggestions on every search box. It now finds ahmar for the hamza spelling, LX-08 for LX08, tobacco for the Arabic spelling, tabaco for either, and the gibberish produced by typing Arabic with the keyboard left on English. Typing two words returned nothing at all before, in every box. A term that matches nothing still returns nothing, and a scanned barcode still outranks every guess. BANNER: the heading is a text box now, so a shop types its own line breaks and the second line leans, which is the whole shape of the reference design. A second button beside the first. The title clamp followed two lines while the heading had three, so the last line was being cut. Arabic was having the tops of its tashkeel sliced off by a Latin line height, and was being faux-italicised by a font that has no italic; it now takes the shop's accent colour instead. A band of figures under the banner, off until switched on, every number counted from the shop's own catalogue and free shipping printed only by a shop that gives it. TEMPLATES: a shop chooses classic or luxe in Settings; no live shop's appearance changed. BULK PHOTOS: drop a folder named by product code and see what matched before anything uploads. ALSO FIXED: the stock count sheet stopped at 1000 lines in silence, so a shop with more would count part of itself believing it counted all of it. Nineteen duplicate translation keys, two of them wrong on screen - deleting a product photo asked whether to remove it from the invoice. 1175 tests passing." >> "%LOG%" 2>&1
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
