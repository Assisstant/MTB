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

param(
    [ValidateRange(1, 2147483647)]
    [int]$KeepDumps = 14,     # how many dumps for this database to retain
    [switch]$SkipJson         # database dump only
)

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

    # --- 1. verified complete dump -------------------------------------------
    # The shared helper checks the archive and that the database stayed stable
    # during the dump. Its PostgreSQL calls restore the caller's PGPASSWORD.
    $proof = New-VerifiedDatabaseDump -Context $context -Path $dumpFile
    $sizeMb = [math]::Round($proof.DumpBytes / 1MB, 2)
    $listing = @(Invoke-PostgresTool -Context $context -Tool $context.PgRestore -Arguments @('--list', $dumpFile) -Capture)
    $objectCount = @($listing | Where-Object { $_ -notmatch '^;' -and $_.Trim() }).Count
    Write-Host "Database dump: $dumpFile ($sizeMb MB)" -ForegroundColor Green
    Write-Host "Dump verified readable ($objectCount objects); database fingerprint stayed unchanged." -ForegroundColor Green

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

    # --- retention: only this database's normal timestamped backups ---------
    # Other databases and manually named recovery dumps share this directory.
    $ownDumpPattern = '^' + [regex]::Escape($database) + '-\d{4}(?:-\d{2}){5}\.dump$'
    $old = @(Get-ChildItem -LiteralPath $dumpDir -File |
        Where-Object { $_.Name -match $ownDumpPattern } |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepDumps)
    foreach ($oldDump in $old) {
        Remove-Item -LiteralPath $oldDump.FullName -Force -Confirm:$false
    }
    if ($old.Count) {
        Write-Host "Removed $($old.Count) dump(s) for $database older than the last $KeepDumps." -ForegroundColor Yellow
    }

    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 's')  OK      $([System.IO.Path]::GetFileName($dumpFile))  $sizeMb MB  $objectCount objects"

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
