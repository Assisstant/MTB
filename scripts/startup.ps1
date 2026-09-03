# Startup gate: update clean code, complete the pCloud database handoff, then
# start the API supervisor. Independent mode never imports a database; optional
# handoff mode still fails closed before exposing stale data to the apps.

[CmdletBinding()]
param(
    [string]$Dir,
    [string]$Me,
    [string]$PeerName,
    [string]$Primary = 'work',
    [int]$WaitSeconds = 180,
    [int]$SettleSeconds = 15,
    [switch]$SkipGitPull,
    [switch]$Independent
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path $PSScriptRoot -Parent
$logFile = Join-Path $repoRoot 'backups\startup-log.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile -Parent) | Out-Null

function Startup-Log([string]$level, [string]$message) {
    Add-Content -LiteralPath $logFile -Value ('{0}  {1,-7} {2}' -f (Get-Date -Format 's'), $level, $message)
}

if (-not $SkipGitPull) {
    try {
        $git = (Get-Command git.exe -ErrorAction Stop).Source
        $dirty = @(& $git -C $repoRoot status --porcelain 2>&1)
        if ($LASTEXITCODE -eq 0 -and -not $dirty.Count) {
            $pull = @(& $git -C $repoRoot pull --ff-only 2>&1)
            if ($LASTEXITCODE -eq 0) { Startup-Log 'ok' 'git pull --ff-only completed.' }
            else { Startup-Log 'warning' ("git pull failed; continuing with installed code: " + ($pull -join ' ')) }
        } else {
            Startup-Log 'warning' 'git pull skipped because the working tree is not clean.'
        }
    } catch { Startup-Log 'warning' ("git pull check failed: " + $_.Exception.Message) }
}

if ($Independent) {
    Startup-Log 'ok' 'Independent database mode; no database sync or restore runs at startup.'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-server.ps1')
    exit $LASTEXITCODE
}

$handoff = Join-Path $PSScriptRoot 'db-handoff.ps1'
$handoffArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $handoff,
    '-Mode', 'Startup', '-Dir', $Dir, '-Me', $Me, '-PeerName', $PeerName, '-Primary', $Primary,
    '-WaitSeconds', [string]$WaitSeconds, '-SettleSeconds', [string]$SettleSeconds, '-Apply', '-Quiet')
& powershell.exe @handoffArgs
$handoffCode = $LASTEXITCODE
if ($handoffCode -ne 0) {
    Startup-Log 'blocked' "Database handoff exited $handoffCode; API server was not started."
    exit $handoffCode
}

Startup-Log 'ok' 'Database handoff is safe; starting API supervisor.'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-server.ps1')
exit $LASTEXITCODE
