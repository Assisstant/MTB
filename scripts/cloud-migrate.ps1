# Облак: миграциите на Supabase од овој компјутер, без да се паметат чекорите.
#
# Истиот пат како на 26 септември (SOSTOJBA.md): адресата на базата во облакот
# е во MTB\cloud.env (во .gitignore) или ..\MTB-cloude.env (надвор од репото), прво снимка со
# pg_dump во backups\, па `npm run deploy:workspace` — истиот runner што го
# пушта Render при deploy. Тој сам прави и приватна recovery шема и одбива
# непрегледана миграција, па двата пата не можат да се разминат.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-migrate.ps1          кажува што чека, прашува
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-migrate.ps1 -Apply   без прашање
#
# Без -Apply ништо не се менува додека не се внесе DA. Ако Render deploy веќе
# ја применил миграцијата, скриптата вели „нема што да се примени" и завршува.
param(
    [switch]$Apply,
    [string]$EnvFile = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Stop-WithMessage([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Red
    if (-not $Apply) { Read-Host 'Enter за затворање' | Out-Null }
    exit 1
}

# The address and the tools: one decision, shared with cloud-cleanup.ps1.
. (Join-Path $PSScriptRoot 'cloud-lib.ps1')
try { $cloud = Get-MtbCloud -Repo $repo -EnvFile $EnvFile } catch { Stop-WithMessage $_.Exception.Message }
$url = $cloud.Url
$pgDump = $cloud.PgDump
$psql = $cloud.Psql

Write-Host ''
Write-Host 'MTB · миграции во облакот (Supabase)' -ForegroundColor Cyan
Write-Host ('  ' + $cloud.Host)

# ── што чека ──────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Continue'
$appliedRaw = & $psql $url -At -c 'SELECT filename FROM schema_migrations ORDER BY filename' 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Stop-WithMessage ("Не можам да се поврзам со облакот:`n" + (($appliedRaw | Out-String).Trim())) }
$applied = @($appliedRaw | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
$files = @(Get-ChildItem (Join-Path $repo 'database\migrations') -Filter '*.sql' | Where-Object { $_.Name -match '^\d{3}_' } | Sort-Object Name | ForEach-Object Name)
$pending = @($files | Where-Object { $applied -notcontains $_ })
Write-Host "  применети: $($applied.Count) · во кодот: $($files.Count)"
if (-not $pending.Count) {
    Write-Host ''
    Write-Host '  Нема што да се примени — облакот е ажурен.' -ForegroundColor Green
    if (-not $Apply) { Read-Host 'Enter за затворање' | Out-Null }
    exit 0
}
Write-Host '  чекаат:' -ForegroundColor Yellow
$pending | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }

if (-not $Apply) {
    Write-Host ''
    $answer = Read-Host 'Прво снимка (backup), па миграција. Внеси DA за да продолжам'
    if ($answer -notmatch '^(da|да)$') { Write-Host '  Ништо не е сменето.'; exit 0 }
}

# ── снимка ────────────────────────────────────────────────────────────────
$backups = Join-Path $repo 'backups'
New-Item -ItemType Directory -Force -Path $backups | Out-Null
$label = ($pending[-1] -replace '\.sql$', '') -replace '^\d{3}_', ''
$dump = Join-Path $backups ('supabase-before-{0}-{1}.dump' -f $label, (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host ''
Write-Host "Снимка → $dump" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
$dumpOut = & $pgDump $url -Fc -n public --no-owner --no-privileges -f $dump 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0 -or -not (Test-Path $dump) -or (Get-Item $dump).Length -lt 1024) {
    Stop-WithMessage ("Снимката не успеа — миграцијата НЕ е пуштена.`n" + (($dumpOut | Out-String).Trim()))
}
Write-Host ('  {0:N0} KB' -f ((Get-Item $dump).Length / 1KB))
# Пет состојби се доволни (сопственикот, 1 октомври 2026): постарите снимки
# на облакот се бришат дури откако новата е проверена дека постои.
$oldDumps = @(Get-ChildItem -LiteralPath $backups -File |
    Where-Object { $_.Name -match '^supabase-before-[\w-]+-\d{8}-\d{6}\.dump$' } |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 5)
foreach ($old in $oldDumps) { Remove-Item -LiteralPath $old.FullName -Force -Confirm:$false }
if ($oldDumps.Count) { Write-Host "  избришани постари снимки на облакот: $($oldDumps.Count) (остануваат последните 5)" -ForegroundColor Yellow }

# ── миграцијата: истиот runner како Render ────────────────────────────────
Write-Host ''
Write-Host 'npm run deploy:workspace' -ForegroundColor Cyan
$previous = $env:DATABASE_URL
# node-postgres reads sslmode=require as verify-full, and Supabase's pooler
# certificate is not in Node's trust store („self-signed certificate in
# certificate chain"). libpq compatibility gives psql's meaning — encrypted,
# the same as the pg_dump above. psql itself would refuse this parameter.
$env:DATABASE_URL = $url + '&uselibpqcompat=true'
try {
    $ErrorActionPreference = 'Continue'
    Push-Location (Join-Path $repo 'server')
    & npm run --silent deploy:workspace 2>&1 | ForEach-Object { Write-Host "  $_" }
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    $env:DATABASE_URL = $previous
    $ErrorActionPreference = 'Stop'
}
Write-Host ''
if ($code -ne 0) {
    Stop-WithMessage "Миграцијата е одбиена и вратена (rollback). Облакот е како пред неа; снимката е во $dump."
}
Write-Host 'Готово. Следниот Render deploy ќе рече „Workspace schema already current".' -ForegroundColor Green
# Секоја група миграции остава своја recovery копија во облакот; постарите се
# тргаат (со архива тука) со кратенката „MTB - Oblak chistenje".
Write-Host 'Старите recovery копии во облакот: кратенката MTB - Oblak chistenje.' -ForegroundColor DarkGray
if (-not $Apply) { Read-Host 'Enter за затворање' | Out-Null }
exit 0
