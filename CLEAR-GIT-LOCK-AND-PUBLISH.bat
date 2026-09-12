@echo off
setlocal
title M^&M Accessories - clear the stale git lock, then publish
cd /d "%~dp0"

rem WHY THIS FILE EXISTS
rem A publish run that is interrupted can leave .git\index.lock behind. Git
rem then refuses every "git add" and "git commit" with "Another git process
rem seems to be running in this repository", PUBLISH.bat carries on to the push
rem step, the push reports "Everything up-to-date" because nothing was
rem committed, and the whole run LOOKS successful while the site stays on the
rem old build. That has now happened twice.
rem
rem Only run this when no other git window is open.

echo.
if exist ".git\index.lock" (
  echo   Found a stale git lock - removing it.
  del /f /q ".git\index.lock"
) else (
  echo   No stale git lock. Nothing to clear.
)
echo.

call "%~dp0PUBLISH.bat"
