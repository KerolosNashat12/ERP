@echo off
setlocal
title M^&M Accessories ERP - push to GitHub
cd /d "%~dp0"

set "REPO=https://github.com/KerolosNashat12/ERP.git"

echo.
echo   Pushing this folder to GitHub
echo   ==========================================
echo   Folder: %CD%
echo   Repo:   %REPO%
echo.

where git >/dev/null 2>nul
if errorlevel 1 (
  echo   [X] Git is not installed, or not on PATH.
  echo       Install it from https://git-scm.com/download/win and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "src\server.js" (
  echo   [X] This does not look like the project folder.
  echo       src\server.js is missing. Put this file next to package.json.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo   Setting up git in this folder...
  git init -b main
  git remote add origin "%REPO%"
) else (
  git remote set-url origin "%REPO%" 2>/dev/null || git remote add origin "%REPO%"
)

echo.
echo   Fetching what is already on GitHub...
git fetch origin main
if errorlevel 1 (
  echo.
  echo   [!] Could not reach GitHub. If it asked you to sign in and you
  echo       cancelled, run this file again and complete the sign-in.
  echo.
  pause
  exit /b 1
)

rem Build this version as a normal commit on top of what is already there,
rem so nothing is force-pushed and no history is lost.
git reset --soft FETCH_HEAD
git add -A
git commit -m "Add Deals of the Day and Bundles. Deals of the Day is a new home-page shelf, off by default and switched on from Settings -> the Website, showing whatever products are manually flagged is_deal_of_day on their own product form or in bulk from the Products grid; the storefront's product listing also gained a matching dealOfDay filter. A bundle is a new kind of product: a checkbox on the product form swaps the size-matrix controls for a component picker (two or more existing products, each with its own quantity), prices either typed by hand or computed live as the sum of every component's price times its quantity, and every bundle is auto-filed under a new Bundles category, which is what makes it filterable on the storefront through the browsing that already existed. A bundle carries no stock of its own - selling, returning, reserving, or cancelling one expands into moving each component's own stock by quantity-in-the-recipe times units sold, through one shared expansion path reused by POS sale/void, customer returns with per-component cost tracing, and the full web-order lifecycle; a bundle's available quantity is computed as the scarcest component's free stock divided by how many of it the recipe needs, and a bundle can never contain another bundle, checked at create and edit time. npm test 1279 -> 1299, a new 20-subtest file covering bundle pricing, all four refusal cases, availability arithmetic, sale/oversell/void, partial return plus reversal, the full web-order lifecycle, and Deals of the Day end to end"
if errorlevel 1 (
  echo.
  echo   Nothing changed compared to GitHub - already up to date.
  echo.
  pause
  exit /b 0
)

echo.
echo   Pushing...
git push origin HEAD:main
if errorlevel 1 (
  echo.
  echo   [X] Push failed. Usually a cancelled GitHub sign-in - run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo   Pushed. Vercel will pick up the new commit and redeploy.
echo   ==========================================
echo.
pause
