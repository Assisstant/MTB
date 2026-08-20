# ============================================================================
#  finish-setup.ps1  —  MTB one-shot finisher (companion to STATUS20260819.md)
#
#  Run the SAME script on the home PC and the work PC:
#
#      powershell -ExecutionPolicy Bypass -File .\finish-setup.ps1
#
#  It reads the database state and does only what is still missing:
#    - students = 0            -> runs the data import with --apply   (home step)
#    - schema_migrations absent -> creates and seeds the ledger        (work step)
#    - always                  -> git pull, verifies the five counts,
#                                 marks stage 10 done in the plan file
#  Safe to run repeatedly — a finished machine just reports ALL DONE.
# ============================================================================

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING = 'UTF8'                       # lesson from commit 3e53a95
if (-not $env:PGPASSWORD) { $env:PGPASSWORD = 'therapy_local' }

# ---------------------------------------------------------------- find psql --
$Psql = @(
    'C:\Program Files\PostgreSQL\18\bin\psql.exe',
    'C:\Program Files\PostgreSQL\17\bin\psql.exe',
    'C:\Program Files\PostgreSQL\16\bin\psql.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Psql) {
    $cmd = Get-Command psql -ErrorAction SilentlyContinue
    if ($cmd) { $Psql = $cmd.Source }
}
if (-not $Psql) { throw 'psql not found - is PostgreSQL installed on this machine?' }

function Invoke-Sql([string]$Sql) {
    $out = & $Psql -U therapy -h localhost -d therapy_dev -X -A -t -v ON_ERROR_STOP=1 -c $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "psql failed:`n$($out -join "`n")" }
    return ($out -join "`n").Trim()
}

# ------------------------------------------------------------ find the repo --
function Test-RepoRoot([string]$p) {
    if (-not $p) { return $false }
    (Test-Path (Join-Path (Join-Path $p 'server') 'package.json')) -and
    (Test-Path (Join-Path (Join-Path $p 'database') 'migrations'))
}
$Repo = @(
    $PSScriptRoot,
    $(if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot }),
    (Get-Location).Path,
    (Join-Path (Join-Path (Join-Path $HOME 'Documents') 'GitHub') 'MTB')
) | Where-Object { Test-RepoRoot $_ } | Select-Object -First 1
if (-not $Repo) {
    $Repo = Read-Host 'Path to the MTB repo'
    if (-not (Test-RepoRoot $Repo)) { throw "That path does not look like the MTB repo (need server/package.json and database/migrations)." }
}
Set-Location $Repo
Write-Host "Repo:  $Repo"
Write-Host "psql:  $Psql"
Write-Host ''

# ------------------------------------------------------------------ git pull --
Write-Host '== 1. git pull ==' -ForegroundColor Cyan
try {
    git -C $Repo pull
    if ($LASTEXITCODE -ne 0) { Write-Warning 'git pull did not succeed - continuing with the local copy.' }
} catch { Write-Warning "git pull failed ($($_.Exception.Message)) - continuing with the local copy." }

# sanity: are the two committed fixes actually present here?
$setupScript = Join-Path (Join-Path $Repo 'scripts') 'setup-home-postgres.ps1'
if ((Test-Path $setupScript) -and -not (Select-String -Path $setupScript -Pattern 'PGCLIENTENCODING' -Quiet)) {
    Write-Warning 'scripts/setup-home-postgres.ps1 is missing the UTF-8 fix - this copy predates commit 3e53a95. Pull before using the setup script.'
}

# ------------------------------------------------------------- read DB state --
Write-Host ''
Write-Host '== 2. Database state ==' -ForegroundColor Cyan
$students     = [int](Invoke-Sql "SELECT count(*) FROM students;")
$ledgerExists = (Invoke-Sql "SELECT to_regclass('public.schema_migrations') IS NOT NULL;") -eq 't'
$ledgerRows   = if ($ledgerExists) { [int](Invoke-Sql "SELECT count(*) FROM schema_migrations;") } else { 0 }
Write-Host ("   students: {0}    migrations ledger: {1}" -f $students, $(if ($ledgerExists) { "$ledgerRows rows" } else { 'missing' }))

# ------------------------------------------- home step: apply the import ----
if ($students -eq 0) {
    Write-Host ''
    Write-Host '== 3. Import not applied yet - applying now (STATUS20260819.md "Remaining action") ==' -ForegroundColor Cyan
    Push-Location (Join-Path $Repo 'server')
    try {
        npm run import -- "../backups/raspored-backup-2026-05-22-10-14-03.json" "../backups/SDnevnik_v3_full_16_uchenici_20260528083905.json" --apply
        if ($LASTEXITCODE -ne 0) { throw 'import exited with an error - see output above.' }
    } finally { Pop-Location }
    $students = [int](Invoke-Sql "SELECT count(*) FROM students;")
} else {
    Write-Host ''
    Write-Host '== 3. Import already applied - skipping ==' -ForegroundColor Cyan
}

# ------------------------------------------- work step: seed the ledger -----
if (-not $ledgerExists -or $ledgerRows -lt 9) {
    Write-Host ''
    Write-Host '== 4. Seeding the schema_migrations ledger (STATUS20260819.md "What to do at work" / 2) ==' -ForegroundColor Cyan
    Invoke-Sql @"
CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations (filename)
SELECT unnest(ARRAY['001_app_state.sql','002_core_tables.sql','003_sdnevnik_id_bigint.sql','004_schedule.sql','005_attendance_plans.sql','006_clinical_records.sql','007_school_years.sql','008_link_past_student_audiograms.sql','009_diary_schedule_links.sql'])
ON CONFLICT DO NOTHING;
"@ | Out-Null
} else {
    Write-Host ''
    Write-Host '== 4. Migrations ledger already present - skipping ==' -ForegroundColor Cyan
}
$ledgerRows = [int](Invoke-Sql "SELECT count(*) FROM schema_migrations;")
Write-Host "   ledger now holds $ledgerRows rows"

# --------------------------------------------------------- verify the counts --
Write-Host ''
Write-Host '== 5. Verifying counts against the dry-run numbers ==' -ForegroundColor Cyan
$expected = [ordered]@{ students = 82; therapists = 10; schedule_slots = 436; attendance = 919; audiograms = 16 }
$mismatch = $false
foreach ($t in $expected.Keys) {
    $n  = [int](Invoke-Sql "SELECT count(*) FROM $t;")
    $ok = ($n -eq $expected[$t])
    if (-not $ok) { $mismatch = $true }
    Write-Host ("   {0,-16} {1,5}   expected {2,5}   {3}" -f $t, $n, $expected[$t], $(if ($ok) { 'OK' } else { '** MISMATCH **' }))
}

# -------------------------------------- mark stage 10 done in the plan file --
Write-Host ''
Write-Host '== 6. Plan file: stage 10 (retire Supabase path) ==' -ForegroundColor Cyan
$plan = Get-ChildItem -Path $Repo -Recurse -Depth 3 -Filter 'therapy_app_postgres_local_plan_v2.md' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $plan) {
    Write-Warning 'therapy_app_postgres_local_plan_v2.md not found - mark stage 10 done manually.'
} else {
    $text    = Get-Content -Raw -Encoding UTF8 $plan.FullName
    $pattern = '(?m)^(\|\s*10\b[^|]*\|\s*)open(\s*\|)[^|]*(\|.*)$'
    if ($text -match $pattern) {
        $newText = [regex]::Replace($text, $pattern, '${1}done${2} Supabase removed in 3c3450a ${3}')
        Set-Content -Path $plan.FullName -Value $newText -Encoding UTF8 -NoNewline
        Write-Host "   marked done in $($plan.FullName)"
        Write-Host '   (remember to commit + push this change)'
    } elseif ($text -match '(?m)^\|\s*10\b[^|]*\|\s*done') {
        Write-Host '   already marked done - nothing to change.'
    } else {
        Write-Warning '   could not find the stage-10 row in the expected format - flip it to done manually.'
    }
}

# ------------------------------------------------------------------ summary --
Write-Host ''
if (-not $mismatch -and $ledgerRows -ge 9 -and $students -eq 82) {
    Write-Host 'ALL DONE on this machine.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Reminders that cannot be scripted:'
    Write-Host '  * Only ONE machine is live at a time - the last one you worked on holds the newest data.'
    Write-Host '  * At WORK, before the next home session: export fresh backups from Rasporedi and'
    Write-Host '    S-Dnevnik (the home data is from May) and carry them across.'
    Write-Host ''
    Write-Host 'To start testing:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts/run-server.ps1'
    Write-Host '  then open http://localhost:3000/Pregled-Baza.html'
    exit 0
} else {
    Write-Warning 'Setup is NOT complete on this machine - fix the mismatches above before testing.'
    exit 1
}