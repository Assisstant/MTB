# Install the tasks that make this machine keep itself in order.
#
# Nothing here is new behaviour — it is the existing scripts, run on a schedule
# so they do not depend on being remembered:
#
#   TherapyServer        run-server.ps1 at every logon (server machine only)
#   TherapyBackupWeekly  backup-db.ps1 once a week + prune old dumps
#   TherapySyncPeer      sync-peer.ps1 whenever the other machine is reachable
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1
#       installs the server and backup tasks
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 -Peer https://zenpc-1.tailXXXXX.ts.net
#       also installs the peer sync
#
#   ... -WhatIf      show what would be installed, change nothing
#   ... -Remove      remove all three tasks
#
# Scheduled tasks are registered for the CURRENT user and run only while that
# user is logged on. That is deliberate: the server needs the user session
# anyway, and a task running as SYSTEM would not see the same PATH or profile.

param(
    [string] $Peer,
    [string] $BackupDay = 'Sunday',
    [string] $BackupTime = '20:00',
    [int]    $SyncEveryHours = 2,
    [switch] $NoServer,
    [switch] $Remove,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$user = "$env:USERNAME"

$tasks = @(
    @{ Name = 'TherapyServer';       Script = 'run-server.ps1' },
    @{ Name = 'TherapyBackupWeekly'; Script = 'backup-db.ps1' },
    @{ Name = 'TherapySyncPeer';     Script = 'sync-peer.ps1' }
)

if ($Remove) {
    foreach ($t in $tasks) {
        if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
            if ($WhatIf) { Write-Host "would remove $($t.Name)" }
            else { Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false; Write-Host "removed $($t.Name)" -ForegroundColor Yellow }
        }
    }
    exit 0
}

foreach ($t in $tasks) {
    $path = Join-Path $root ('scripts\' + $t.Script)
    if (-not (Test-Path $path)) { Write-Host "missing: $path" -ForegroundColor Red; exit 1 }
}

function Register-One {
    param([string]$Name, [string]$ScriptPath, [string]$ScriptArgs, $Trigger, [string]$Describe)

    $argument = '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    if ($ScriptArgs) { $argument += ' ' + $ScriptArgs }

    if ($WhatIf) {
        Write-Host ("would install {0,-20} {1}" -f $Name, $Describe)
        return
    }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
                    -DontStopOnIdleEnd -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings `
                    -Description $Describe -Force | Out-Null
    Write-Host ("installed {0,-20} {1}" -f $Name, $Describe) -ForegroundColor Green
}

# --- the server ---------------------------------------------------------------
if (-not $NoServer) {
    Register-One -Name 'TherapyServer' `
        -ScriptPath (Join-Path $root 'scripts\run-server.ps1') `
        -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
        -Describe 'starts the therapy API at logon'
}

# --- weekly backup ------------------------------------------------------------
# Weekly, not daily: backup-db.ps1 writes a full dump plus two JSON exports, and
# fourteen retained dumps of a year of clinical data is already a real amount of
# disk. Anything lost between two backups is still in the app's own storage.
Register-One -Name 'TherapyBackupWeekly' `
    -ScriptPath (Join-Path $root 'scripts\backup-db.ps1') `
    -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $BackupDay -At $BackupTime) `
    -Describe "dump + JSON export every $BackupDay at $BackupTime"

# --- peer sync ----------------------------------------------------------------
if ($Peer) {
    # Repeating rather than once: the other machine is off most of the time, so
    # most runs will find nothing and exit quietly. -Quiet keeps them silent and
    # appends one line to backups\sync-peer.log so a quiet week is provably quiet.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Hours $SyncEveryHours) `
        -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

    Register-One -Name 'TherapySyncPeer' `
        -ScriptPath (Join-Path $root 'scripts\sync-peer.ps1') `
        -ScriptArgs ('-Peer "{0}" -Apply -Quiet' -f $Peer) `
        -Trigger $trigger `
        -Describe "sync with $Peer every $SyncEveryHours h when it is reachable"
} else {
    Write-Host 'skipped  TherapySyncPeer      (no -Peer given)' -ForegroundColor DarkGray
}

if (-not $WhatIf) {
    Write-Host ''
    Write-Host 'Installed. Check them with:' -ForegroundColor Cyan
    Write-Host '  Get-ScheduledTask TherapyServer, TherapyBackupWeekly, TherapySyncPeer | Format-Table TaskName, State'
    Write-Host 'Run one now without waiting:' -ForegroundColor Cyan
    Write-Host '  Start-ScheduledTask -TaskName TherapyBackupWeekly'
}
