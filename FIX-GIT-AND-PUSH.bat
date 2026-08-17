@echo off
setlocal enabledelayedexpansion
title M^&M Accessories ERP - fix git and push
cd /d "%~dp0"

set "REPO=https://github.com/KerolosNashat12/ERP.git"
set "LOG=%~dp0git-diagnosis.txt"

echo Diagnosis started %DATE% %TIME%> "%LOG%"
echo.
echo   Why can't git reach GitHub?
echo   ==========================================
echo   Everything is written to git-diagnosis.txt
echo   in this same folder.
echo.

call :log "--- git version ---"
git --version >> "%LOG%" 2>&1

call :log "--- existing git http config ---"
git config --global --get-regexp "^http\." >> "%LOG%" 2>&1

call :log "--- windows proxy settings ---"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable >> "%LOG%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer >> "%LOG%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL >> "%LOG%" 2>&1

call :log "--- proxy environment variables ---"
echo http_proxy=%http_proxy%>> "%LOG%"
echo https_proxy=%https_proxy%>> "%LOG%"

call :log "--- can curl reach github over https? ---"
curl -s -o nul -w "curl_status=%%{http_code}" https://github.com >> "%LOG%" 2>&1
echo.>> "%LOG%"

call :log "--- dns lookup ---"
nslookup github.com >> "%LOG%" 2>&1

call :log "--- is tcp 443 open to github? ---"
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $r = Test-NetConnection -ComputerName github.com -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue; Write-Output ('tcp443=' + $r)" >> "%LOG%" 2>&1

echo   Applying the usual Windows fixes...
call :log "--- applying fixes ---"

rem Use the Windows TLS stack. It honours the system proxy and certificate
rem store, which is the most common reason git fails where a browser works.
git config --global http.sslBackend schannel >> "%LOG%" 2>&1
call :log "set http.sslBackend=schannel"

rem Some proxies and TLS-inspection appliances break HTTP/2 multiplexing.
git config --global http.version HTTP/1.1 >> "%LOG%" 2>&1
call :log "set http.version=HTTP/1.1"

rem Adopt the Windows proxy if one is configured.
set "WINPROXY="
for /f "tokens=3" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| find /i "ProxyServer"') do set "WINPROXY=%%a"
if not "!WINPROXY!"=="" (
  echo   Found a Windows proxy: !WINPROXY!
  git config --global http.proxy "http://!WINPROXY!" >> "%LOG%" 2>&1
  call :log "set http.proxy=http://!WINPROXY!"
) else (
  call :log "no windows proxy configured"
)

echo.
echo   Retrying the connection...
call :log "--- retry: git ls-remote ---"
git ls-remote "%REPO%" HEAD >> "%LOG%" 2>&1
if errorlevel 1 goto :stillbroken

call :log "CONNECTION OK"
echo   Connected. Pushing...
echo.

if not exist ".git" (
  git init -b main >> "%LOG%" 2>&1
  git remote add origin "%REPO%" >> "%LOG%" 2>&1
) else (
  git remote set-url origin "%REPO%" >> "%LOG%" 2>&1
)

git fetch origin main >> "%LOG%" 2>&1
if errorlevel 1 (
  call :log "FETCH FAILED"
  echo   [X] Fetch failed - see git-diagnosis.txt
  echo.
  pause
  exit /b 1
)

git reset --soft FETCH_HEAD >> "%LOG%" 2>&1
git add -A >> "%LOG%" 2>&1
git -c user.email="kerolosnashatestfanous@gmail.com" -c user.name="KerolosNashat12" commit -m "v1.6: dual database driver (local SQLite or hosted Turso), async data layer, Vercel deploy" >> "%LOG%" 2>&1

git push origin HEAD:main >> "%LOG%" 2>&1
if errorlevel 1 (
  call :log "PUSH FAILED"
  echo   [X] Push failed - see git-diagnosis.txt
  echo       If a GitHub sign-in window appeared, complete it and run this again.
  echo.
  pause
  exit /b 1
)

call :log "PUSH SUCCEEDED"
echo.
echo   ==========================================
echo   Pushed. Vercel will redeploy automatically.
echo   ==========================================
echo.
pause
exit /b 0

:stillbroken
call :log "STILL FAILING AFTER FIXES"
echo.
echo   [X] git still cannot reach GitHub, but your browser can.
echo       That points at antivirus or a firewall blocking git.exe,
echo       or a proxy that only the browser knows about.
echo.
echo       The full details are in git-diagnosis.txt - send it to me
echo       and I will tell you exactly what to change.
echo.
pause
exit /b 1

:log
echo.>> "%LOG%"
echo %~1>> "%LOG%"
goto :eof
