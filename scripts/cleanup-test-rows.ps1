# ============================================================================
# cleanup-test-rows.ps1 — staff identities left behind by browser suites
#
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup-test-rows.ps1          shows, asks DA, backup, delete
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup-test-rows.ps1 -List    only shows, asks nothing
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup-test-rows.ps1 -Apply   backup, then delete, asks nothing
#
# The first is the „MTB - Chistenje test-zapisi" tile and shortcut (mtb-actions.ps1).
#
# WHY. A few browser suites (test:podatoci, test:evidence-ui) write invented
# records into the LOCAL database and remove them at the end. Migration 035
# keeps a staff identity (`employees`) when its teacher or therapist profile
# goes — on purpose, for real people — so a suite that stops early, or whose
# cleanup misses it, leaves the identity behind. check:names then learns the
# invented name from the database and refuses commits that mention it.
# Seen 14 Oct 2026 on HOME: three „browser-evidence …" rows, five older
# „browser-odd …" rows.
#
# WHAT IS TOUCHED. Only `employees` whose name starts with the suites' tag
# `browser-` (no real person is named so), and only rows nothing points at:
# no teacher, therapist, annual role, annual details, identity link or merge.
# A row that is still referenced is listed and left. Only a database on this
# computer (127.0.0.1 / localhost): never the cloud.
# ============================================================================
param([switch]$Apply, [switch]$List)

$ErrorActionPreference = 'Stop'
# Run from a tile, the window is the person's: it waits for Enter before it closes.
function Close-Run([int]$Code) {
    if (-not $Apply -and -not $List) { Read-Host 'Enter за затворање' | Out-Null }
    exit $Code
}
# A failure (the database off, a refused delete) is said in the window, not lost with it.
trap { Write-Host ''; Write-Host ('Не успеа: ' + $_.Exception.Message) -ForegroundColor Red; Close-Run 1 }
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'db-handoff-lib.ps1')
$context = New-HandoffContext -RepoRoot $repoRoot -StateDir (Join-Path $repoRoot 'backups')
$db = $context.Db
if (@('127.0.0.1', 'localhost', '::1') -notcontains [string]$db.Host) {
    Write-Host ('Одбиено: базата е на ' + $db.Host + '. Оваа скрипта чисти само база на овој компјутер.') -ForegroundColor Red
    Close-Run 1
}

# The same conditions as the suites' own cleanup (test/podatoci.browser.mjs).
$where = @'
e.name LIKE 'browser-%'
  AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM employee_roles x WHERE x.employee_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM employee_year_details x WHERE x.employee_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM employee_identity_links x WHERE x.source_id = e.id OR x.target_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.superseded_by = e.id)
'@

# SQL goes in a file and the answer comes back in a file: a native argument
# loses its double quotes (trap 48) and a Cyrillic name read through the
# console arrives garbled (trap 47).
function Invoke-SqlFile([string]$Sql) {
    $in = [IO.Path]::GetTempFileName(); $out = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($in, $Sql, (New-Object Text.UTF8Encoding $false))
        $old = $env:PGCLIENTENCODING; $env:PGCLIENTENCODING = 'UTF8'
        try {
            Invoke-PostgresTool -Context $context -Tool $context.Psql -Capture -Arguments @(
                '-X', '-qAt', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', '-U', $db.User, '-h', $db.Host, '-p', [string]$db.Port,
                '-d', $db.Database, '-f', $in, '-o', $out) | Out-Null
        } finally { if ($null -eq $old) { Remove-Item Env:PGCLIENTENCODING -ErrorAction SilentlyContinue } else { $env:PGCLIENTENCODING = $old } }
        return @(Get-Content -LiteralPath $out -Encoding UTF8 | Where-Object { $_.Trim() })
    } finally { Remove-Item -LiteralPath $in, $out -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host ('MTB · тест-записи во локалната база ' + $db.Database) -ForegroundColor Cyan
$free = @(Invoke-SqlFile ("SELECT e.id, e.name, to_char(e.created_at, 'YYYY-MM-DD HH24:MI') FROM employees e WHERE $where ORDER BY e.id;"))
$held = @(Invoke-SqlFile ("SELECT e.id, e.name FROM employees e WHERE e.name LIKE 'browser-%' AND NOT ($where) ORDER BY e.id;"))
if (-not $free.Count -and -not $held.Count) { Write-Host '  Нема тест-записи. Нема што да се чисти.' -ForegroundColor Green; Close-Run 0 }
if ($free.Count) {
    Write-Host ('  За бришење (' + $free.Count + '):') -ForegroundColor Yellow
    $free | ForEach-Object { Write-Host ('    ' + $_) }
}
if ($held.Count) {
    Write-Host ('  Остануваат, бидејќи нешто покажува на нив (' + $held.Count + '):') -ForegroundColor DarkYellow
    $held | ForEach-Object { Write-Host ('    ' + $_) }
}
if (-not $free.Count) { Close-Run 0 }
if ($List) {
    Write-Host ''
    Write-Host '  Само преглед: ништо не е избришано.' -ForegroundColor Cyan
    exit 0
}
if (-not $Apply) {
    Write-Host ''
    $answer = Read-Host 'Прво резерва на локалната база, па бришење на горните. Внеси DA за да продолжам'
    if ($answer -notmatch '^(da|да)$') { Write-Host '  Ништо не е избришано.'; Close-Run 0 }
}

# ── резерва, па бришење ───────────────────────────────────────────────────
# The backup runs as its own process, its output to a file: a nested
# powershell -File can fail silently without a console of its own (trap 49).
$log = Join-Path $repoRoot 'backups\cleanup-test-rows-backup.log'
Write-Host ''
Write-Host 'Резерва (backup-db.ps1)…' -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup-db.ps1') -SkipJson *> $log
if ($LASTEXITCODE -ne 0) {
    Write-Host ('Резервата не успеа — ништо не е избришано. Види ' + $log) -ForegroundColor Red
    Close-Run 1
}
Get-Content -LiteralPath $log -Encoding UTF8 | Select-Object -Last 2 | ForEach-Object { Write-Host ('  ' + $_) }

$ids = @($free | ForEach-Object { [int](($_ -split ' \| ')[0]) })
$gone = @(Invoke-SqlFile ("BEGIN; DELETE FROM employees e WHERE e.id IN (" + ($ids -join ',') + ") AND $where RETURNING e.id; COMMIT;"))
Write-Host ''
Write-Host ('Избришано: ' + $gone.Count + ' (id ' + ($gone -join ', ') + ').') -ForegroundColor Green
Close-Run 0
