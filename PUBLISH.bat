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
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "A supplier swap is now visible everywhere it happened, which it was not. The owner sent one bottle back, took a different one in, and found the purchase order still listing only the bottle that had gone, with no mark on it and no sign of the one that replaced it; the returns list called the document a return; and the two columns he had to type into were headed with two spellings of the same Arabic word, so he had to ask which was which. All four are fixed. Each purchase order line now carries its own history beside it without the line itself changing by a single figure, because the order has to go on saying what was agreed and what arrived: how many went back, how many came in, and what came in, named and priced, so a different item reads as swapped for Yara outlet, two hundred and fifty pounds becoming three hundred and eighty. The supplier returns list has a type column that says return or swap, derived from whether goods actually came back rather than from the word somebody chose in a dialog, and three money columns instead of one, because a swap has three numbers and showing only the first is what made that list disagree with the order it belongs to. The two quantity columns are now named for their direction and their counterparty, and each dialog carries a sentence saying what it does. A reversed swap leaves no mark at all, the same rule the balance follows. Four new tests ask the question the old ones never did, which is not whether the arithmetic is right but whether a person can see what happened, and all four were confirmed to fail with the fix removed. The browser check found a second bug while this was being written: renaming the column had silently renamed the submit button, because they were one string, and the return was no longer being recorded at all. Also in this release, the storefront moves closer to the design its owner sent. The hero runs edge to edge and full height with a gold tracked eyebrow over a large light serif headline; the section labels, the brand names, the category marks and the footer headings all take the reference's small tracked capitals; the delivery promises become one thin banded row with hairline dividers instead of three floating cards; and the category marks become thin rings rather than filled discs. No functionality changed: the filters, the favourites, the checkout and the search are untouched, and the browser check that drives the filter panel end to end in both languages and at both sizes still passes. 1066 tests passing." >> "%LOG%" 2>&1
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
