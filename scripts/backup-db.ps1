# ============================================================================
# backup-db.ps1 — the two backups the plan calls for, in one run:
#
#   1. PostgreSQL dump   (complete, restores the database exactly)
#   2. JSON export       (human-portable, still readable by both apps)
#
# Output:
#   backups\db\<configured-database>-<stamp>.dump
#   backups\UnifiedSync-from-postgres-<stamp>.json
#   backups\SDnevnik-from-postgres-<stamp>.json
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# Database settings come from DATABASE_URL, with server\.env as the fallback,
# exactly as in manual-db-sync.ps1. Restore rehearsals use a separate database.
# ============================================================================

# A BACKUP IS A STATE, NOT A RUN (owner, 1 Oct 2026). Every start, update and
# end of day calls this script, so "keep the last 5 files" had become five
# copies of one afternoon and nothing from last week. Two rules replace it:
#
#   - a database that has not changed since the last dump gets NO new dump:
#     the one that exists is that state, and it is checked to still be intact;
#   - what is kept is the newest $KeepDumps states AND the last state of each
#     of the last $KeepDumps days that had one, so several runs in a day never
#     push the earlier days out.
#
# -Force dumps anyway.
param(
    [ValidateRange(1, 2147483647)]
    [int]$KeepDumps = 5,      # how many states, and how many days, to retain
    [switch]$SkipJson,        # database dump only
    [switch]$Force            # dump even when nothing changed
)

# The newest $Keep files, plus the newest file of each of the last $Keep days.
# The day and the order come from the timestamp in the NAME: an unchanged
# state's file is touched to say "still current", which would lie about its day.
function Get-ExpiredStates {
    param([object[]]$Files, [int]$Keep)
    $sorted = @($Files | Sort-Object Name -Descending)
    $kept = @{}
    foreach ($file in ($sorted | Select-Object -First $Keep)) { $kept[$file.Name] = $true }
    $days = @($sorted | Group-Object { [regex]::Match($_.Name, '\d{4}-\d{2}-\d{2}(?=-\d{2}-\d{2}-\d{2}\.)').Value } |
        Sort-Object Name -Descending | Select-Object -First $Keep)
    foreach ($day in $days) { $kept[($day.Group | Sort-Object Name -Descending | Select-Object -First 1).Name] = $true }
    return @($sorted | Where-Object { -not $kept.ContainsKey($_.Name) })
}

$ErrorActionPreference = 'Stop'

# --- locate repo root --------------------------------------------------------
$repoRoot = $PSScriptRoot
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'server'))) {
    $repoRoot = Split-Path $repoRoot -Parent
}
if (-not $repoRoot) { Write-Error "Could not find repo root (folder containing 'server')."; exit 1 }

$backupDir = Join-Path $repoRoot 'backups'
$dumpDir = Join-Path $backupDir 'db'
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null

$logFile = Join-Path $backupDir 'backup-log.txt'

# Unattended runs need a trace: without it a scheduled backup can fail every
# week and look exactly like one that never ran.
try {
    . (Join-Path $PSScriptRoot 'db-handoff-lib.ps1')
    $context = New-HandoffContext -RepoRoot $repoRoot -StateDir $dumpDir
    $database = $context.Db.Database
    if ($database.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw 'The configured database name cannot be used in a Windows backup filename.'
    }
    $stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
    $dumpFile = Join-Path $dumpDir "$database-$stamp.dump"

    # --- 0. is this a state we already hold? ----------------------------------
    # The same fingerprint the dump itself is verified with: every table's rows
    # and every sequence. The dump on disk must also still be the file that
    # was written, or it is not a backup of anything.
    $stateFile = Join-Path $dumpDir "$database-last-state.json"
    $needJson = -not $SkipJson
    if (-not $Force -and (Test-Path -LiteralPath $stateFile)) {
        $last = $null
        try { $last = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $last = $null }
        $held = if ($last -and $last.file) { Join-Path $dumpDir ([string]$last.file) } else { $null }
        if ($held -and (Test-Path -LiteralPath $held) -and
            $last.hash -eq (Get-DatabaseFingerprint -Context $context) -and
            $last.dumpSha256 -eq (Get-FileSha256 -Path $held)) {
            (Get-Item -LiteralPath $held).LastWriteTime = Get-Date
            if ($needJson -and -not $last.json) {
                # The state is held as a dump but was never exported: do that part only.
                $dumpFile = $held
            } else {
                Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 's')  SAME    $($last.file)  unchanged since that dump"
                Write-Host "The database has not changed since $($last.file); that dump is still intact. No new copy made." -ForegroundColor Green
                exit 0
            }
        }
    }
    $reuse = (Test-Path -LiteralPath $dumpFile)

    # --- 1. verified complete dump -------------------------------------------
    # The shared helper checks the archive and that the database stayed stable
    # during the dump. Its PostgreSQL calls restore the caller's PGPASSWORD.
    if ($reuse) {
        $proof = [pscustomobject]@{ DatabaseHash = $last.hash; DumpSha256 = $last.dumpSha256; DumpBytes = (Get-Item -LiteralPath $dumpFile).Length }
    } else {
        $proof = New-VerifiedDatabaseDump -Context $context -Path $dumpFile
    }
    $sizeMb = [math]::Round($proof.DumpBytes / 1MB, 2)
    $listing = @(Invoke-PostgresTool -Context $context -Tool $context.PgRestore -Arguments @('--list', $dumpFile) -Capture)
    $objectCount = @($listing | Where-Object { $_ -notmatch '^;' -and $_.Trim() }).Count
    if ($reuse) {
        Write-Host "Database unchanged since $([IO.Path]::GetFileName($dumpFile)); adding only the JSON export of that state." -ForegroundColor Green
    } else {
        Write-Host "Database dump: $dumpFile ($sizeMb MB)" -ForegroundColor Green
        Write-Host "Dump verified readable ($objectCount objects); database fingerprint stayed unchanged." -ForegroundColor Green
    }

    # --- 2. JSON export (portable, app-readable) ------------------------------
    if (-not $SkipJson) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        $npm = if ($npmCommand) { $npmCommand.Source } else { 'C:\Program Files\nodejs\npm.cmd' }
        if (-not (Test-Path -LiteralPath $npm)) {
            throw "npm was not found; JSON export failed. The verified database dump remains at $dumpFile. Use -SkipJson only when a dump alone is intended."
        }
        Push-Location (Join-Path $repoRoot 'server')
        try {
            & $npm run export --silent
            if ($LASTEXITCODE -ne 0) {
                throw "JSON export failed with exit code $LASTEXITCODE. The verified database dump remains at $dumpFile."
            }
        } finally { Pop-Location }
    }

    # Which state is now held, so the next run can tell whether it has a new one.
    # Written only after everything above succeeded.
    $state = [ordered]@{
        file = [IO.Path]::GetFileName($dumpFile); hash = $proof.DatabaseHash; dumpSha256 = $proof.DumpSha256
        json = [bool]($needJson -or ($reuse -and $last.json)); at = (Get-Date -Format 's')
    }
    [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

    # --- retention: only this database's normal timestamped backups ---------
    # Other databases and manually named recovery dumps share this directory.
    $ownDumpPattern = '^' + [regex]::Escape($database) + '-\d{4}(?:-\d{2}){5}\.dump$'
    $old = @(Get-ExpiredStates -Keep $KeepDumps -Files @(Get-ChildItem -LiteralPath $dumpDir -File |
        Where-Object { $_.Name -match $ownDumpPattern }))
    foreach ($oldDump in $old) {
        Remove-Item -LiteralPath $oldDump.FullName -Force -Confirm:$false
    }
    if ($old.Count) {
        Write-Host "Removed $($old.Count) dump(s) for $database beyond the last $KeepDumps states and $KeepDumps days." -ForegroundColor Yellow
    }
    # The JSON exports are the same states in another form. Only after an
    # export that just succeeded, and only the timestamped names this script's
    # export writes: a hand-named file stays.
    if (-not $SkipJson) {
        foreach ($app in 'UnifiedSync', 'SDnevnik') {
            $ownJsonPattern = '^' + $app + '-from-postgres-\d{4}(?:-\d{2}){5}\.json$'
            $oldJson = @(Get-ExpiredStates -Keep $KeepDumps -Files @(Get-ChildItem -LiteralPath $backupDir -File |
                Where-Object { $_.Name -match $ownJsonPattern }))
            foreach ($file in $oldJson) { Remove-Item -LiteralPath $file.FullName -Force -Confirm:$false }
            if ($oldJson.Count) {
                Write-Host "Removed $($oldJson.Count) $app JSON export(s) beyond the last $KeepDumps states and $KeepDumps days." -ForegroundColor Yellow
            }
        }
    }

    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 's')  $(if ($reuse) { 'JSON   ' } else { 'OK     ' }) $([System.IO.Path]::GetFileName($dumpFile))  $sizeMb MB  $objectCount objects"

    Write-Host ''
    Write-Host 'Backup complete.' -ForegroundColor Green
    Write-Host "Log: $logFile"
    Write-Host 'Rehearse restoring a backup into a separate disposable database periodically.'
} catch {
    $message = $_.Exception.Message
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 's')  FAILED  $message"
    Write-Error "Backup failed: $message" -ErrorAction Continue
    exit 1
}
