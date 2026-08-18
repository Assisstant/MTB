# ============================================================================
# backup-db.ps1 — the two backups the plan calls for, in one run:
#
#   1. PostgreSQL dump   (complete, restores the database exactly)
#   2. JSON export       (human-portable, still readable by both apps)
#
# Output:
#   backups\db\therapy_dev-<stamp>.dump
#   backups\UnifiedSync-from-postgres-<stamp>.json
#   backups\SDnevnik-from-postgres-<stamp>.json
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# Restore into a fresh database (verify a backup before trusting it):
#   createdb -U postgres -O therapy therapy_restore_test
#   pg_restore -U therapy -h localhost -d therapy_restore_test backups\db\<file>.dump
# ============================================================================

param(
    [int]$KeepDumps = 14,     # how many dumps to retain
    [switch]$SkipJson         # database dump only
)

$ErrorActionPreference = 'Stop'

$AppRole = 'therapy'
$AppPassword = 'therapy_local'
$AppDb = 'therapy_dev'

# --- locate repo root and tools ----------------------------------------------
$repoRoot = $PSScriptRoot
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'server'))) {
    $repoRoot = Split-Path $repoRoot -Parent
}
if (-not $repoRoot) { Write-Error "Could not find repo root (folder containing 'server')."; exit 1 }

$pgDump = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
          Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $pgDump) { $pgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source }
if (-not $pgDump) { Write-Error "pg_dump.exe not found. Is PostgreSQL installed?"; exit 1 }

$backupDir = Join-Path $repoRoot 'backups'
$dumpDir = Join-Path $backupDir 'db'
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
$dumpFile = Join-Path $dumpDir "$AppDb-$stamp.dump"
$logFile = Join-Path $backupDir 'backup-log.txt'

# Unattended runs need a trace: without it a scheduled backup can fail every
# week and look exactly like one that never ran.
trap {
    Add-Content $logFile "$(Get-Date -Format 's')  FAILED  $($_.Exception.Message)"
    break
}

# --- 1. database dump (custom format: compressed, restores selectively) ------
$env:PGPASSWORD = $AppPassword
& $pgDump -U $AppRole -h localhost -d $AppDb -Fc -f $dumpFile
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed."; exit 1 }
$sizeMb = [math]::Round((Get-Item $dumpFile).Length / 1MB, 2)
Write-Host "Database dump: $dumpFile ($sizeMb MB)" -ForegroundColor Green

# --- verify the dump is readable before trusting it --------------------------
# pg_restore --list parses the archive without writing anything, so a
# truncated or corrupt dump is caught now rather than on the day it is needed.
$pgRestore = Join-Path (Split-Path $pgDump -Parent) 'pg_restore.exe'
$objectCount = 0
if (Test-Path $pgRestore) {
    $listing = & $pgRestore --list $dumpFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "The dump could not be read back by pg_restore - treat it as FAILED."
        Add-Content $logFile "$(Get-Date -Format 's')  FAILED  dump unreadable: $dumpFile"
        exit 1
    }
    $objectCount = ($listing | Where-Object { $_ -notmatch '^;' -and $_.Trim() }).Count
    Write-Host "Dump verified readable ($objectCount objects)." -ForegroundColor Green
} else {
    Write-Warning "pg_restore.exe not found - dump was NOT verified."
}

# --- 2. JSON export (portable, app-readable) ---------------------------------
if (-not $SkipJson) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = "C:\Program Files\nodejs\npm.cmd" }
    if (Test-Path $npm) {
        Push-Location (Join-Path $repoRoot 'server')
        & $npm run export --silent
        Pop-Location
    } else {
        Write-Warning "npm not found - skipping the JSON export."
    }
}

# --- retention ----------------------------------------------------------------
$old = Get-ChildItem (Join-Path $dumpDir '*.dump') | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepDumps
if ($old) {
    $old | Remove-Item -Force -Confirm:$false
    Write-Host "Removed $($old.Count) dump(s) older than the last $KeepDumps." -ForegroundColor Yellow
}

$env:PGPASSWORD = $null
Add-Content $logFile "$(Get-Date -Format 's')  OK      $([System.IO.Path]::GetFileName($dumpFile))  $sizeMb MB  $objectCount objects"

Write-Host ""
Write-Host "Backup complete." -ForegroundColor Green
Write-Host "Log: $logFile"
Write-Host "A backup you have never restored is not yet a backup - test one now and then:"
Write-Host "  pg_restore -U therapy -h localhost -d therapy_restore_test `"$dumpFile`""
