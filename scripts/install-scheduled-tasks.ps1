# Install the tasks that make this machine keep itself in order.
#
# Nothing here is new behaviour — it is the existing scripts, run on a schedule
# so they do not depend on being remembered:
#
#   TherapyServer        run-server.ps1 at every logon (server machine only)
#   TherapyBackupWeekly  backup-db.ps1 once a week + prune old dumps
#   TherapySyncPeer      sync-peer.ps1 whenever the other machine is reachable
#   TherapySyncMailbox   sync-peer.ps1 through a shared folder (pCloud), which
#                        works even when the two machines are never on together
#   TherapyDbPublish     full PostgreSQL handoff through pCloud
#   TherapyDbSnapshotWeekly  independent, manually accepted DB snapshot
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1
#       installs the server and backup tasks
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 -Peer https://zenpc-1.tailXXXXX.ts.net
#       also installs the peer sync
#
#   ... -WhatIf      show what would be installed, change nothing
#   ... -Remove      remove all MTB automation tasks
#
# Scheduled tasks are registered for the CURRENT user and run only while that
# user is logged on. That is deliberate: the server needs the user session
# anyway, and a task running as SYSTEM would not see the same PATH or profile.

param(
    [string] $Peer,
    [string] $Dir,           # mailbox folder (pCloud); can be used together with -Peer
    [string] $Me,            # this machine's name inside that folder
    [string] $PeerName,
    [string] $Primary = 'work',
    [string] $BackupDay = 'Sunday',
    [string] $BackupTime = '20:00',
    [int]    $SyncEveryHours = 2,
    [int]    $PublishEveryMinutes = 30,
    [switch] $FullDbHandoff,
    [switch] $ManualDbSync,
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
    @{ Name = 'TherapySyncPeer';     Script = 'sync-peer.ps1' },
    @{ Name = 'TherapySyncMailbox';  Script = 'sync-peer.ps1' },
    @{ Name = 'TherapyDbPublish';    Script = 'db-handoff.ps1' },
    @{ Name = 'TherapyDbSnapshotWeekly'; Script = 'manual-db-sync.ps1' }
)

if ($FullDbHandoff -and $ManualDbSync) { throw 'Choose either -FullDbHandoff or -ManualDbSync, never both.' }

if ($Remove) {
    foreach ($t in $tasks) {
        if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
            if ($WhatIf) { Write-Host "would remove $($t.Name)" }
            else { Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false; Write-Host "removed $($t.Name)" -ForegroundColor Yellow }
        }
    }
    if (Get-ScheduledTask -TaskName 'TherapyBackup' -ErrorAction SilentlyContinue) {
        if ($WhatIf) { Write-Host 'would remove legacy TherapyBackup' }
        else { Unregister-ScheduledTask -TaskName 'TherapyBackup' -Confirm:$false; Write-Host 'removed legacy TherapyBackup' -ForegroundColor Yellow }
    }
    exit 0
}

foreach ($t in @($tasks | Where-Object {
    ($_.Name -ne 'TherapyDbPublish' -or $FullDbHandoff) -and
    ($_.Name -ne 'TherapyDbSnapshotWeekly' -or $ManualDbSync)
})) {
    $path = Join-Path $root ('scripts\' + $t.Script)
    if (-not (Test-Path $path)) { Write-Host "missing: $path" -ForegroundColor Red; exit 1 }
}

function New-RepeatingLogonTrigger {
    param([int]$Minutes)

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
        -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
    $repetition.Duration = ''
    $trigger.Repetition = $repetition
    return $trigger
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
    $restartCount = if ($Name -eq 'TherapyServer') { 999 } else { 3 }
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
                    -DontStopOnIdleEnd -RestartCount $restartCount -RestartInterval (New-TimeSpan -Minutes 5)

    try {
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings `
                        -Description $Describe -Force -ErrorAction Stop | Out-Null
    } catch {
        # Windows builds disagree about how a repeating trigger may say "forever".
        # If this one refuses the duration we chose, fall back to a long finite
        # one rather than leaving the task uninstalled: a year of repetition is
        # far better than none, and reinstalling is a one-liner.
        if ($Trigger.Repetition -and $Trigger.Repetition.Interval) {
            Write-Host ("  {0}: the task service refused the repetition duration, retrying with one year" -f $Name) -ForegroundColor Yellow
            $Trigger.Repetition.Duration = (New-TimeSpan -Days 365)
            Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings `
                            -Description $Describe -Force -ErrorAction Stop | Out-Null
        } else {
            throw
        }
    }
    Write-Host ("installed {0,-20} {1}" -f $Name, $Describe) -ForegroundColor Green
}

# --- the server ---------------------------------------------------------------
if (-not $NoServer) {
    if ($FullDbHandoff) {
        if (-not $Dir -or -not $Me) { throw '-FullDbHandoff requires -Dir and -Me.' }
        if (-not $PeerName) { $PeerName = if ($Me -eq 'work') { 'home' } else { 'work' } }
        $startupArgs = '-Dir "{0}" -Me "{1}" -PeerName "{2}" -Primary "{3}"' -f $Dir, $Me, $PeerName, $Primary
        Register-One -Name 'TherapyServer' `
            -ScriptPath (Join-Path $root 'scripts\startup.ps1') `
            -ScriptArgs $startupArgs `
            -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
            -Describe 'pulls the safe full-DB pCloud handoff, then starts the therapy API'
    } elseif ($ManualDbSync) {
        Register-One -Name 'TherapyServer' `
            -ScriptPath (Join-Path $root 'scripts\startup.ps1') `
            -ScriptArgs '-Independent' `
            -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
            -Describe 'pulls clean code, then starts the independent local therapy database API'
    } else {
        Register-One -Name 'TherapyServer' `
            -ScriptPath (Join-Path $root 'scripts\run-server.ps1') `
            -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
            -Describe 'starts the therapy API at logon'
    }
}

if (-not $FullDbHandoff -and (Get-ScheduledTask -TaskName 'TherapyDbPublish' -ErrorAction SilentlyContinue)) {
    if ($WhatIf) { Write-Host 'would remove automatic TherapyDbPublish' }
    else {
        Unregister-ScheduledTask -TaskName 'TherapyDbPublish' -Confirm:$false
        Write-Host 'removed automatic TherapyDbPublish' -ForegroundColor Yellow
    }
}

# --- weekly backup ------------------------------------------------------------
# Weekly, not daily: backup-db.ps1 writes a full dump plus two JSON exports, and
# fourteen retained dumps of a year of clinical data is already a real amount of
# disk. Anything lost between two backups is still in the app's own storage.
if (Get-ScheduledTask -TaskName 'TherapyBackup' -ErrorAction SilentlyContinue) {
    if ($WhatIf) { Write-Host 'would remove legacy TherapyBackup' }
    else {
        Unregister-ScheduledTask -TaskName 'TherapyBackup' -Confirm:$false
        Write-Host 'removed legacy TherapyBackup' -ForegroundColor Yellow
    }
}
Register-One -Name 'TherapyBackupWeekly' `
    -ScriptPath (Join-Path $root 'scripts\backup-db.ps1') `
    -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $BackupDay -At $BackupTime) `
    -Describe "dump + JSON export every $BackupDay at $BackupTime"

# --- full database handoff ----------------------------------------------------
# DB-first screens write relational rows that sync-peer never carried. The full
# handoff is therefore exclusive with the legacy app_state transport.
if ($FullDbHandoff) {
    if (-not $Dir -or -not $Me) { throw '-FullDbHandoff requires -Dir and -Me.' }
    if (-not $PeerName) { $PeerName = if ($Me -eq 'work') { 'home' } else { 'work' } }

    foreach ($oldName in @('TherapySyncPeer', 'TherapySyncMailbox')) {
        if (Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue) {
            if ($WhatIf) { Write-Host "would remove retired $oldName" }
            else {
                Unregister-ScheduledTask -TaskName $oldName -Confirm:$false
                Write-Host "removed retired $oldName" -ForegroundColor Yellow
            }
        }
    }

    $publishArgs = '-Mode Publish -Dir "{0}" -Me "{1}" -PeerName "{2}" -Primary "{3}" -WaitSeconds 0 -Apply -Quiet' -f $Dir, $Me, $PeerName, $Primary
    Register-One -Name 'TherapyDbPublish' `
        -ScriptPath (Join-Path $root 'scripts\db-handoff.ps1') `
        -ScriptArgs $publishArgs `
        -Trigger (New-RepeatingLogonTrigger -Minutes $PublishEveryMinutes) `
        -Describe "publishes a verified full DB generation every $PublishEveryMinutes min when data changed"
}

# --- independent databases with manual acceptance ----------------------------
if ($ManualDbSync) {
    if (-not $Dir -or -not $Me) { throw '-ManualDbSync requires -Dir and -Me.' }
    if (-not $PeerName) { $PeerName = if ($Me -eq 'work') { 'home' } else { 'work' } }

    foreach ($oldName in @('TherapySyncPeer', 'TherapySyncMailbox')) {
        if (Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue) {
            if ($WhatIf) { Write-Host "would remove automatic $oldName" }
            else {
                Unregister-ScheduledTask -TaskName $oldName -Confirm:$false
                Write-Host "removed automatic $oldName" -ForegroundColor Yellow
            }
        }
    }

    $snapshotAt = ([datetime]::ParseExact($BackupTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)).AddMinutes(30).ToString('HH:mm')
    $snapshotArgs = '-Mode Export -Dir "{0}" -Me "{1}" -PeerName "{2}" -WaitSeconds 30' -f $Dir, $Me, $PeerName
    Register-One -Name 'TherapyDbSnapshotWeekly' `
        -ScriptPath (Join-Path $root 'scripts\manual-db-sync.ps1') `
        -ScriptArgs $snapshotArgs `
        -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $BackupDay -At $snapshotAt) `
        -Describe "exports this independent DB snapshot every $BackupDay at $snapshotAt; import is always manual"
} elseif (Get-ScheduledTask -TaskName 'TherapyDbSnapshotWeekly' -ErrorAction SilentlyContinue) {
    if ($WhatIf) { Write-Host 'would remove TherapyDbSnapshotWeekly' }
    else {
        Unregister-ScheduledTask -TaskName 'TherapyDbSnapshotWeekly' -Confirm:$false
        Write-Host 'removed TherapyDbSnapshotWeekly' -ForegroundColor Yellow
    }
}

# --- legacy app_state peer sync ----------------------------------------------
# -Peer and -Dir are not alternatives here. Direct is faster and confirms the
# other side received it; the mailbox works when the machines are never awake
# together. Installing both means the sync uses whichever is possible that hour.
if (-not $FullDbHandoff -and -not $ManualDbSync -and ($Peer -or ($Dir -and $Me))) {
    # Repeating rather than once: the other machine is off most of the time, so
    # most runs will find nothing and exit quietly. -Quiet keeps them silent and
    # appends one line to backups\sync-peer.log so a quiet week is provably quiet.
    $trigger = New-RepeatingLogonTrigger -Minutes ($SyncEveryHours * 60)

    if ($Peer) {
        Register-One -Name 'TherapySyncPeer' `
            -ScriptPath (Join-Path $root 'scripts\sync-peer.ps1') `
            -ScriptArgs ('-Peer "{0}" -Apply -Quiet' -f $Peer) `
            -Trigger $trigger `
            -Describe "sync with $Peer every $SyncEveryHours h when it is reachable"
    }
    if ($Dir -and $Me) {
        Register-One -Name 'TherapySyncMailbox' `
            -ScriptPath (Join-Path $root 'scripts\sync-peer.ps1') `
            -ScriptArgs ('-Dir "{0}" -Me "{1}" -Apply -Quiet' -f $Dir, $Me) `
            -Trigger $trigger `
            -Describe "carry through $Dir as '$Me' every $SyncEveryHours h"
    } elseif ($Dir -and -not $Me) {
        Write-Host 'skipped  TherapySyncMailbox   (-Dir given without -Me)' -ForegroundColor Yellow
    }
} elseif (-not $FullDbHandoff -and -not $ManualDbSync) {
    Write-Host 'skipped  TherapySyncPeer      (no -Peer and no -Dir/-Me given)' -ForegroundColor DarkGray
}

if (-not $WhatIf) {
    Write-Host ''
    Write-Host 'Installed. Check them with:' -ForegroundColor Cyan
    Write-Host '  Get-ScheduledTask TherapyServer, TherapyBackupWeekly, TherapyDbSnapshotWeekly, TherapyDbPublish, TherapySyncPeer, TherapySyncMailbox | Format-Table TaskName, State'
    Write-Host 'Run one now without waiting:' -ForegroundColor Cyan
    Write-Host '  Start-ScheduledTask -TaskName TherapyBackupWeekly'
}
