# cloud-backup.ps1 — „MTB - Oblak rezerva": the cloud database, whole, onto this computer.
#
# WHY. Since 9 Oct 2026 the work is written only in the cloud, so Supabase
# holds the one copy of the year. What ran every evening (backup-db.ps1) saves
# this computer's own database, which nobody writes any more, and the
# read-only copy leaves the colleagues' accounts out on purpose. This is the
# backup of the thing that is actually used.
#
# WHAT. pg_dump of the cloud's `public` schema — every table, the accounts and
# the migration ledger with them — into backups\cloud\. It only READS the
# cloud. Then, in this order:
#   1. the archive's index is read back. A file that cannot be listed is
#      deleted and reported; it never counts as a backup, and the last good
#      one is left alone;
#   2. a copy goes to the pCloud folder the two PCs share, so a lost PC is not
#      a lost backup. Without pCloud it says so and carries on;
#   3. older files are thinned to the newest of each day;
#   4. a note is left for the Контролна табла (cloud-lib.ps1): when, and how
#      many recovery copies the cloud holds, so the panel can remind without
#      asking the cloud itself.
#
# WHAT IT IS NOT. Reading the index is not a restore (CLAUDE.md, „the archive
# lists every table"). Nothing is deleted from the cloud on the strength of
# this file, so that proof is not needed for safety here — but it is owed
# once, by hand, into a scratch database, before anyone relies on it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-backup.ps1          makes it, waits for Enter
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-backup.ps1 -Quiet   no waiting
param(
    [switch]$Quiet,
    [string]$EnvFile = '',
    # Days kept on this computer and in pCloud: the newest file of each.
    [ValidateRange(1, 365)]
    [int]$KeepDays = 30,
    [ValidateRange(1, 365)]
    [int]$KeepDaysShared = 7
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$ownName = '^supabase-backup-(\d{8})-\d{6}\.dump$'

function Close-Window([int]$Code = 0) {
    if (-not $Quiet) { Read-Host 'Enter за затворање' | Out-Null }
    exit $Code
}
function Stop-WithMessage([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Red
    Close-Window 1
}

# Only this script's own files, and only the older ones of a day or the days
# past the limit. A dump made before a migration (supabase-before-…) is
# cloud-migrate.ps1's and is never touched here.
function Remove-OlderDumps([string]$Dir, [int]$Days) {
    $files = @(Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Name -match $ownName } | Sort-Object Name -Descending)
    $seen = @{}
    $gone = 0
    foreach ($f in $files) {
        $day = [regex]::Match($f.Name, $ownName).Groups[1].Value
        if ($seen.ContainsKey($day) -or $seen.Count -ge $Days) {
            Remove-Item -LiteralPath $f.FullName -Force -Confirm:$false
            $gone++
        } else {
            $seen[$day] = $true
        }
    }
    return $gone
}

. (Join-Path $PSScriptRoot 'cloud-lib.ps1')
try { $cloud = Get-MtbCloud -Repo $repo -EnvFile $EnvFile } catch { Stop-WithMessage $_.Exception.Message }

Write-Host ''
Write-Host 'MTB · резерва на облакот (Supabase)' -ForegroundColor Cyan
Write-Host ('  ' + $cloud.Host)

# ── the dump ──────────────────────────────────────────────────────────────
$dir = Join-Path $repo 'backups\cloud'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date
$dump = Join-Path $dir ('supabase-backup-{0}.dump' -f $stamp.ToString('yyyyMMdd-HHmmss'))
Write-Host ''
Write-Host "Резерва → $dump" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
$dumpOut = & $cloud.PgDump $cloud.Url -Fc -n public --no-owner --no-privileges -f $dump 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0 -or -not (Test-Path -LiteralPath $dump) -or (Get-Item -LiteralPath $dump).Length -lt 1024) {
    if (Test-Path -LiteralPath $dump) { Remove-Item -LiteralPath $dump -Force -Confirm:$false }
    Stop-WithMessage ("Резервата не успеа. Претходните резерви се недопрени.`n" + (($dumpOut | Out-String).Trim()))
}
$kb = [int][Math]::Round((Get-Item -LiteralPath $dump).Length / 1KB)
Write-Host ('  {0:N0} KB' -f $kb)

# ── can it be read back at all? ───────────────────────────────────────────
$ErrorActionPreference = 'Continue'
$listing = & $cloud.PgRestore --list $dump 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$tables = @($listing | Where-Object { "$_" -match '\sTABLE DATA public\s' }).Count
if ($code -ne 0 -or $tables -lt 20) {
    Remove-Item -LiteralPath $dump -Force -Confirm:$false
    Stop-WithMessage "Резервата е запишана, но не може да се прочита назад ($tables табели во индексот) — избришана е. Претходните резерви се недопрени."
}
Write-Host "  индексот се чита: $tables табели со податоци (ова не е пробно обновување)" -ForegroundColor Green

# ── a copy outside this computer ──────────────────────────────────────────
$shared = 'P:\MTB-sync'
$serverEnv = Join-Path $repo 'server\.env'
if (Test-Path -LiteralPath $serverEnv) {
    $dirLine = Get-Content -LiteralPath $serverEnv -Encoding UTF8 | Where-Object { $_ -match '^\s*SYNC_DIR\s*=' } | Select-Object -First 1
    if ($dirLine) { $shared = ($dirLine -replace '^\s*SYNC_DIR\s*=\s*', '').Trim().Trim('"') }
}
$inShared = $false
if (Test-Path -LiteralPath $shared) {
    try {
        $far = Join-Path $shared 'cloud-backup'
        New-Item -ItemType Directory -Force -Path $far | Out-Null
        $copy = Join-Path $far (Split-Path -Leaf $dump)
        Copy-Item -LiteralPath $dump -Destination $copy -Force
        if ((Get-Item -LiteralPath $copy).Length -ne (Get-Item -LiteralPath $dump).Length) { throw 'копијата не е со иста големина' }
        $inShared = $true
        Write-Host "  копија во pCloud: $copy" -ForegroundColor Green
        [void](Remove-OlderDumps $far $KeepDaysShared)
    } catch {
        Write-Host "  копијата во pCloud НЕ успеа: $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  pCloud ($shared) не е достапен — резервата е само на овој компјутер." -ForegroundColor Yellow
}

# ── thinning, only now that the new one is known to be readable ───────────
$gone = Remove-OlderDumps $dir $KeepDays
if ($gone) { Write-Host "  избришани постари резерви: $gone (останува најновата од секој ден, $KeepDays дена)" -ForegroundColor DarkGray }

# ── the note for the Контролна табла ──────────────────────────────────────
$note = @{
    backupAt     = $stamp.ToString('s')
    backupFile   = (Split-Path -Leaf $dump)
    backupKb     = $kb
    backupTables = $tables
    backupShared = $inShared
}
# No double quotes in the statement: Windows PowerShell drops them on the way to psql.
$out = [IO.Path]::GetTempFileName()
$ErrorActionPreference = 'Continue'
$null = & $cloud.Psql $cloud.Url -X -At -o $out -c 'SELECT count(*) FROM pg_namespace WHERE nspname ~ ''^mtb_workspace_recovery_[a-z0-9_]+$''' 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$answer = @(Get-Content -LiteralPath $out -Encoding UTF8 | Where-Object { $_ }) | Select-Object -First 1
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
if ($code -eq 0 -and "$answer" -match '^\d+$') {
    $note.recoverySchemas = [int]$answer
    $note.recoveryKeep = 3
    $note.checkedAt = $stamp.ToString('s')
    if ([int]$answer -gt 3) {
        Write-Host "  во облакот има $answer recovery копии (се чуваат 3): кратенката MTB - Oblak chistenje" -ForegroundColor Yellow
    }
}
Set-MtbCloudState -Repo $repo -Values $note

Write-Host ''
Write-Host 'Готово. Облакот не е сменет.' -ForegroundColor Green
Close-Window
