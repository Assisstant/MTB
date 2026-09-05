# ============================================================================
# setup-home-postgres.ps1
# Sets up the SAME local PostgreSQL environment as the work computer, so the
# therapy apps + server run identically on both machines.
#
# Creates:
#   - role     therapy      (password: therapy_local)
#   - database therapy_dev  (owner: therapy)
#   - all tables from database\migrations\*.sql (applied in file order)
#   - server\.env with the matching DATABASE_URL
#   - installs server dependencies (npm install)
#
# Prerequisites on the home computer:
#   1. PostgreSQL installed (any recent version; 18 used at work)
#      winget install PostgreSQL.PostgreSQL.18
#   2. Node.js installed
#      winget install OpenJS.NodeJS.LTS
#   3. This repository cloned/copied (run this script from anywhere inside it)
#
# Run:  right-click > Run with PowerShell,  or:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1
#
# The script is idempotent — safe to run again; existing role/db/tables are kept.
# ============================================================================

$ErrorActionPreference = 'Stop'

# --- fixed app credentials (same on every machine; DB listens on localhost only)
$AppRole     = 'therapy'
$AppPassword = 'therapy_local'
$AppDb       = 'therapy_dev'

# --- migration files are UTF-8 (Cyrillic inside); do not let the Windows
# --- console codepage (WIN1252/WIN1251) decide psql's client encoding.
$env:PGCLIENTENCODING = 'UTF8'

# --- locate repo root (folder containing 'server' and 'database') -----------
$repoRoot = $PSScriptRoot
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'server'))) {
    $repoRoot = Split-Path $repoRoot -Parent
}
if (-not $repoRoot) { Write-Error "Could not find repo root (folder containing 'server'). Run from inside the project."; exit 1 }
Write-Host "Repo root: $repoRoot" -ForegroundColor Cyan

# --- locate psql -------------------------------------------------------------
$psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $psql) { $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source }
if (-not $psql) {
    Write-Error "psql.exe not found. Install PostgreSQL first:  winget install PostgreSQL.PostgreSQL.18"
    exit 1
}
Write-Host "Using psql: $psql" -ForegroundColor Cyan

# --- check the service is running -------------------------------------------
$svc = Get-Service -Name "*postgres*" -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running'
if (-not $svc) {
    Write-Warning "No running PostgreSQL service found. Trying to start it..."
    Get-Service -Name "*postgres*" -ErrorAction SilentlyContinue | Start-Service
    Start-Sleep -Seconds 3
}

# --- is the app role already able to reach its own database? ----------------
# The superuser is needed for exactly two things: CREATE ROLE and CREATE
# DATABASE. On a machine that has been running for a year both exist, and the
# postgres password is one nobody has typed since the day it was installed —
# so asking for it turns "apply one migration" into an afternoon, and the
# script dies before it ever reaches the migrations it came to run. That
# happened, on the machine holding the real data.
#
# So: try the app role first. Ask for the superuser only when something
# actually has to be created.
$env:PGPASSWORD = $AppPassword
$prevPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $psql -U $AppRole -h localhost -d $AppDb -t -A -c 'SELECT 1' 2>&1 | Out-Null
$appReady = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevPreference

if ($appReady) {
    Write-Host "Role '$AppRole' and database '$AppDb' are already here - the 'postgres' password is not needed." -ForegroundColor Yellow
} else {
    # --- superuser password (may differ per machine; asked, never stored) ----
    $securePw = Read-Host "Password for the 'postgres' superuser ON THIS MACHINE" -AsSecureString
    $env:PGPASSWORD = [System.Net.NetworkCredential]::new('', $securePw).Password

    function Invoke-Psql([string]$Database, [string]$Sql) {
        & $psql -U postgres -h localhost -d $Database -v ON_ERROR_STOP=1 -t -A -c $Sql
        if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
    }

    # --- 1. role (idempotent) ------------------------------------------------
    $roleExists = Invoke-Psql 'postgres' "SELECT 1 FROM pg_roles WHERE rolname = '$AppRole';"
    if ($roleExists -eq '1') {
        Write-Host "Role '$AppRole' already exists - keeping it." -ForegroundColor Yellow
    } else {
        Invoke-Psql 'postgres' "CREATE ROLE $AppRole LOGIN PASSWORD '$AppPassword';"
        Write-Host "Role '$AppRole' created." -ForegroundColor Green
    }

    # --- 2. database (idempotent) --------------------------------------------
    $dbExists = Invoke-Psql 'postgres' "SELECT 1 FROM pg_database WHERE datname = '$AppDb';"
    if ($dbExists -eq '1') {
        Write-Host "Database '$AppDb' already exists - keeping it." -ForegroundColor Yellow
    } else {
        Invoke-Psql 'postgres' "CREATE DATABASE $AppDb OWNER $AppRole;"
        Write-Host "Database '$AppDb' created." -ForegroundColor Green
    }
}

# --- 3. migrations (ledger-driven: every file applied exactly once) ----------
# A schema_migrations table records which files this database has already run.
# Each migration is applied inside a single transaction together with its own
# ledger row, so a file either fully applies and is recorded, or neither.
$env:PGPASSWORD = $AppPassword

function Invoke-AppPsql([string]$Sql) {
    $out = & $psql -U $AppRole -h localhost -d $AppDb -v ON_ERROR_STOP=1 -t -A -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
    return $out
}

Invoke-AppPsql "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" | Out-Null

$applied = @(Invoke-AppPsql "SELECT filename FROM schema_migrations;") | Where-Object { $_ -ne '' }

$migrations = Get-ChildItem (Join-Path $repoRoot 'database\migrations\*.sql') | Sort-Object Name
foreach ($m in $migrations) {
    if ($applied -contains $m.Name) {
        Write-Host "Already applied: $($m.Name)" -ForegroundColor DarkGray
        continue
    }
    Write-Host "Applying migration: $($m.Name)" -ForegroundColor Cyan
    & $psql -U $AppRole -h localhost -d $AppDb -v ON_ERROR_STOP=1 -1 `
            -f $m.FullName `
            -c "INSERT INTO schema_migrations (filename) VALUES ('$($m.Name)');"
    if ($LASTEXITCODE -ne 0) { Write-Error "Migration failed (rolled back): $($m.Name)"; exit 1 }
    Write-Host "  applied and recorded." -ForegroundColor Green
}

# --- 4. server\.env (same credentials everywhere) ----------------------------
$envFile = Join-Path $repoRoot 'server\.env'
if (Test-Path $envFile) {
    Write-Host "server\.env already exists - keeping it." -ForegroundColor Yellow
} else {
    @(
        "DATABASE_URL=postgres://${AppRole}:${AppPassword}@localhost:5432/${AppDb}"
        "PORT=3000"
    ) | Set-Content $envFile -Encoding utf8
    Write-Host "server\.env created." -ForegroundColor Green
}

# --- 5. npm install ----------------------------------------------------------
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $npm) {
    Write-Warning "npm not found - install Node.js (winget install OpenJS.NodeJS.LTS), then run 'npm install' inside the server folder."
} else {
    Push-Location (Join-Path $repoRoot 'server')
    npm install
    Pop-Location
}

# Rule 1 is enforced by a hook that lives in the repository, so a fresh clone
# carries it — but Git ignores a tracked hooks directory until it is told to
# use one. This is that telling; it is per-clone configuration, not a file.
if (Get-Command git -ErrorAction SilentlyContinue) {
    git -C $repoRoot config core.hooksPath .githooks
    Write-Host "Rule 1 guard:       pre-commit hook active (core.hooksPath=.githooks)" -ForegroundColor Green
} else {
    Write-Warning "git not found - run 'git config core.hooksPath .githooks' yourself to turn the Rule 1 hook on."
}

$env:PGPASSWORD = $null
Write-Host ""
Write-Host "================= DONE =================" -ForegroundColor Green
Write-Host "Start the server:   cd server ; npm run dev"
Write-Host "Open the app:       http://localhost:3000/Rasporedi.html"
Write-Host "Health check:       http://localhost:3000/api/health"
Write-Host ""
Write-Host "Carrying data between work and home (until Tailscale):"
Write-Host "  leaving:  in the app press 'Izvezi Unified Sync JSON' and take the file"
Write-Host "  arriving: 'Vchitaj Unified/backup JSON', then 'Zachuvaj na server'"
