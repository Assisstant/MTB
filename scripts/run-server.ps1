# ============================================================================
# run-server.ps1 — keeps the therapy API alive.
#
# Task Scheduler's "restart on failure" does not reliably fire when the child
# Node process dies (the task itself is what it watches, and killing node was
# observed to leave the task simply "terminated"). A supervisor loop is both
# simpler and dependable: if the server exits for any reason, start it again.
#
# The scheduled task TherapyServer runs this at logon.
# Stop it with: Stop-ScheduledTask -TaskName TherapyServer
# ============================================================================

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path $PSScriptRoot -Parent
$serverDir = Join-Path $repoRoot 'server'
$logFile = Join-Path $repoRoot 'backups\server-log.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile -Parent) | Out-Null

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = 'C:\Program Files\nodejs\npm.cmd' }

Set-Location $serverDir
Add-Content $logFile "$(Get-Date -Format 's')  supervisor started"

$backoff = 5
while ($true) {
    $started = Get-Date
    & $npm run start
    $ranFor = (Get-Date) - $started

    # A server that survived a while was healthy; reset the wait. One that dies
    # instantly is probably misconfigured, so back off rather than spin.
    if ($ranFor.TotalSeconds -gt 60) { $backoff = 5 } else { $backoff = [Math]::Min($backoff * 2, 300) }

    Add-Content $logFile "$(Get-Date -Format 's')  server exited after $([int]$ranFor.TotalSeconds)s - restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
}
