<#
  Confirms a push actually reached the LIVE site, not just GitHub.

  A push can succeed and the site can still be on the old build - most often
  because the Vercel build itself failed, which git has no way to see or
  report. This polls the site's own /api/health, which reports the exact
  commit it is currently running (see src/shared/deploymentInfo.js), until
  it matches the commit that was just pushed, or the timeout runs out.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File WAIT-FOR-DEPLOY.ps1 -Sha <short-sha> [-Url <site-url>]

  Exit code 0  = the live site is confirmed running that commit.
  Exit code 1  = it never showed up within the timeout (still building,
                 the build failed, or the site could not be reached) -
                 not necessarily a real failure, just "not confirmed yet".
#>
param(
  [Parameter(Mandatory = $true)][string]$Sha,
  [string]$Url = "https://erp-rust-one.vercel.app",
  [int]$TimeoutSeconds = 300,
  [int]$IntervalSeconds = 10
)

# Some of this machine's older PowerShell/.NET setups default to TLS 1.0,
# which modern hosts (Vercel included) refuse outright.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # Best effort - an older .NET that does not know Tls12 by name will still
  # often negotiate it by default. Never let this line stop the script.
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$attempt = 0
$healthUrl = "$Url/api/health"

Write-Host ""
Write-Host "  Waiting for the live site to pick up commit $Sha ..."

while ((Get-Date) -lt $deadline) {
  $attempt++
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10 -ErrorAction Stop
    $live = $response.deployment.build.commit
    if ($live -eq $Sha) {
      Write-Host ""
      Write-Host "  [OK] Live - the site is running commit $Sha."
      exit 0
    }
    $liveLabel = if ($live) { $live } else { "(unknown build)" }
    Write-Host "  attempt $attempt - site is still on $liveLabel, waiting..."
  } catch {
    Write-Host "  attempt $attempt - site not reachable yet, waiting..."
  }
  Start-Sleep -Seconds $IntervalSeconds
}

Write-Host ""
Write-Host "  [!] Still not showing commit $Sha after $TimeoutSeconds seconds."
Write-Host "      This usually just means the Vercel build is still running -"
Write-Host "      wait a bit and refresh the site. If it has been several"
Write-Host "      minutes, check https://vercel.com for the build logs."
exit 1
