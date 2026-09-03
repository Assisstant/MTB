# Carry state between this machine's database and the other machine's.
#
# Both machines run their own PostgreSQL. They are used one at a time, so
# whichever side changed since the last sync is the one to copy. The script
# refuses when BOTH changed, because that cannot be merged.
#
#   powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1
#       report only — shows both sides and what would happen, changes nothing
#
#   powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1 -Apply
#       actually sync
#
#   powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1 `
#       -Dir "D:\pCloudDrive\MTB-sync" -Me work -Apply
#       carry through a shared folder instead, so the two PCs never have to be
#       on at the same time
#
# The peer address is read from server\.env (PEER_URL=https://...), or pass
# -Peer https://zenpc-1.tailXXXXX.ts.net to override it.

param(
    [string] $Peer,
    [string] $Dir,           # mailbox folder (pCloud) - use INSTEAD of -Peer
    [string] $Me,            # this machine's name inside that folder
    [string] $PeerName,      # the other machine's name; only if the folder has more than two
    [string] $Local = 'http://127.0.0.1:3000',
    [switch] $Apply,
    [switch] $Force,
    [switch] $Quiet          # for the scheduled task: only speak when it matters
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'

if (-not (Test-Path (Join-Path $server 'node_modules'))) {
    Write-Host "Server dependencies are missing. Run scripts\setup-home-postgres.ps1 first." -ForegroundColor Red
    exit 1
}

# Not $args — that is an automatic variable and assigning to it invites trouble.
$npmArgs = @('run', 'sync', '--')
if ($Peer)     { $npmArgs += @('--peer', $Peer) }
if ($Dir)      { $npmArgs += @('--dir', $Dir) }
if ($Me)       { $npmArgs += @('--me', $Me) }
if ($PeerName) { $npmArgs += @('--peer-name', $PeerName) }
if ($Local)    { $npmArgs += @('--local', $Local) }
if ($Apply) { $npmArgs += '--apply' }
if ($Force) { $npmArgs += '--force' }

Push-Location $server
try {
    $output = & npm @npmArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

# Exit codes from sync-peer.ts: 0 fine, 2 something needs a human, 1 failed.
if ($Quiet -and $code -eq 0) {
    # Nothing to say. Still leave a trail, so a silent week is provably silent.
    $log = Join-Path $root 'backups\sync-peer.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Add-Content -Path $log -Value ("[{0}] ok" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    exit 0
}

Write-Host $output

if ($code -eq 2) {
    Write-Host ''
    Write-Host 'The two machines have diverged and nothing was changed.' -ForegroundColor Yellow
    Write-Host 'Read the report above, decide which side to keep, then rerun with -Force.' -ForegroundColor Yellow
} elseif ($code -ne 0) {
    Write-Host ''
    Write-Host 'Sync failed. Is the other machine on, and is its server running?' -ForegroundColor Red
}

exit $code
