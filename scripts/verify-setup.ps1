# ============================================================================
# verify-setup.ps1 — checks a machine is set up correctly and reports what is
# missing, without changing anything.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1
#
# Every line is either OK, WARN (works, but worth knowing) or FAIL (with the
# fix to run). Read-only: it never writes to the database.
# ============================================================================

$ErrorActionPreference = 'Continue'
$fails = 0
$warns = 0

function Ok   ($m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  WARN  $m" -ForegroundColor Yellow; $script:warns++ }
function Fail ($m, $fix) {
    Write-Host "  FAIL  $m" -ForegroundColor Red
    if ($fix) { Write-Host "        fix: $fix" -ForegroundColor DarkGray }
    $script:fails++
}

Write-Host ""
Write-Host "=== Setup check on $env:COMPUTERNAME ===" -ForegroundColor Cyan
Write-Host ""

# --- repo -------------------------------------------------------------------
$repoRoot = $PSScriptRoot
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'server'))) { $repoRoot = Split-Path $repoRoot -Parent }
if (-not $repoRoot) { Fail "project folder not found" "run this from inside the MTB folder"; exit 1 }
Write-Host "Project: $repoRoot"
Write-Host ""

# --- 1. tools ---------------------------------------------------------------
Write-Host "1. Tools"
$psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if ($psql) { Ok "PostgreSQL ($(Split-Path (Split-Path $psql -Parent) -Parent | Split-Path -Leaf))" }
else { Fail "PostgreSQL not installed" "winget install PostgreSQL.PostgreSQL.18" }

if (Get-Command node -ErrorAction SilentlyContinue) { Ok "Node.js $(node --version)" }
else { Fail "Node.js not installed" "winget install OpenJS.NodeJS.LTS" }

$svc = Get-Service -Name "*postgres*" -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running'
if ($svc) { Ok "PostgreSQL service running" }
else { Fail "PostgreSQL service not running" "Get-Service *postgres* | Start-Service" }

# --- 2. project files -------------------------------------------------------
Write-Host ""
Write-Host "2. Project"
if (Test-Path (Join-Path $repoRoot 'server\.env')) { Ok "server\.env exists" }
else { Fail "server\.env missing" "powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1" }

if (Test-Path (Join-Path $repoRoot 'server\node_modules')) { Ok "server dependencies installed" }
else { Fail "server dependencies missing" "cd server ; npm install" }

# --- 3. database ------------------------------------------------------------
Write-Host ""
Write-Host "3. Database"
$env:PGPASSWORD = 'therapy_local'
$dbOk = $false
if ($psql) {
    $r = & $psql -U therapy -h localhost -d therapy_dev -t -A -c "SELECT 1" 2>&1
    if ($LASTEXITCODE -eq 0 -and "$r".Trim() -eq '1') { Ok "connected to therapy_dev as 'therapy'"; $dbOk = $true }
    else { Fail "cannot connect to therapy_dev" "powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1" }
}

if ($dbOk) {
    $expected = @('app_state','students','therapists','therapist_students','schedule_slots',
                  'attendance','plans','plan_activities','student_plan_progress','student_records',
                  'assessments','triage_tests','audiograms','scale_templates','school_years',
                  'student_enrollments','diary_schedule','resource_links')
    $tablesSql = "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    $have = (& $psql -U therapy -h localhost -d therapy_dev -t -A -c $tablesSql) -split "`n" |
            ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $missing = $expected | Where-Object { $have -notcontains $_ }
    if ($missing.Count -eq 0) { Ok "all $($expected.Count) tables present" }
    else { Fail "missing tables: $($missing -join ', ')" "apply migrations: see setup-home-postgres.ps1" }

    $countsSql = "SELECT (SELECT count(*) FROM students), (SELECT count(*) FROM therapists), (SELECT count(*) FROM schedule_slots), (SELECT count(*) FROM attendance), (SELECT count(*) FROM assessments)"
    $counts = & $psql -U therapy -h localhost -d therapy_dev -t -A -F '|' -c $countsSql
    $p = "$counts".Trim() -split '\|'
    if ($p.Count -ge 5) {
        Write-Host "        students=$($p[0])  therapists=$($p[1])  terms=$($p[2])  attendance=$($p[3])  assessments=$($p[4])" -ForegroundColor DarkGray
        if ([int]$p[0] -eq 0) { Warn "database is empty - import your JSON export (see docs/HOME-SETUP.md, step B5)" }
        else { Ok "data present" }
    }

    $year = (& $psql -U therapy -h localhost -d therapy_dev -t -A -c "SELECT label FROM school_years WHERE is_current").Trim()
    if ($year) { Ok "current school year: $year" } else { Warn "no current school year set" }
}
$env:PGPASSWORD = $null

# --- 4. server --------------------------------------------------------------
Write-Host ""
Write-Host "4. Server"
try {
    $health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    if ($health.ok) { Ok "API answering on http://localhost:3000" } else { Warn "API answered oddly" }
    try {
        $stats = Invoke-RestMethod -Uri 'http://localhost:3000/api/stats' -TimeoutSec 5
        Write-Host "        year=$($stats.school_year)  students=$($stats.active_students)  terms=$($stats.slots)  conflicts=$($stats.double_booked)" -ForegroundColor DarkGray
    } catch { }
} catch {
    Fail "API not answering on port 3000" "powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1"
}

# --- summary ----------------------------------------------------------------
Write-Host ""
if ($fails -eq 0 -and $warns -eq 0) {
    Write-Host "Everything checks out. Open:" -ForegroundColor Green
    Write-Host "  http://localhost:3000/Rasporedi.html"
    Write-Host "  http://localhost:3000/S-Dnevnik.html"
    Write-Host "  http://localhost:3000/Pregled-Baza.html   (overview)"
} elseif ($fails -eq 0) {
    Write-Host "Working, with $warns thing(s) worth a look above." -ForegroundColor Yellow
} else {
    Write-Host "$fails problem(s) to fix, $warns warning(s). Each FAIL above has its fix." -ForegroundColor Red
}
Write-Host ""
