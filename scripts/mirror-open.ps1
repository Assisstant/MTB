# mirror-open.ps1 — „MTB - Kopija od oblakot": open the read-only copy of the
# cloud, starting its server if it is not running, and say how old the data is.
#
# The copy is the therapy_mirror database, served by run-mirror-server.ps1 on a
# port of its own beside the normal server (docs\SUPABASE-MIRROR.md). That
# server is started by hand and does not come back after a restart, so the
# copy was there and unreachable. This is the one click that reaches it.
#
# It READS. It starts a server that cannot write, and opens a page. It never
# pulls from the cloud — that is mirror-refresh.ps1, which asks first.
#
# A port that answers is not proof of a copy: something else may be listening
# there. The page is opened only when the server itself says it is a read-only
# mirror, so a click on this tile can never land on a writable database.
#
#   powershell -ExecutionPolicy Bypass -File scripts\mirror-open.ps1
#   -NoBrowser   say where the copy stands, open nothing
#   -NoWait      do not wait for Enter at the end (for a check, not for a person)

param(
    [int] $Port = 3001,
    [string] $Page = 'MTB-Workspace.html?app=S-Dnevnik.html',
    [switch] $NoBrowser,
    [switch] $NoWait
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'server\.env'

function Close-Window([int] $Code) {
    if (-not $NoWait) { [void](Read-Host 'Enter за затворање') }
    exit $Code
}
function Stop-Here([string] $Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Yellow
    Close-Window 1
}
function Get-MirrorHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 } catch { return $null }
}
function Test-ReadOnlyCopy($Health) {
    return [bool]($Health -and $Health.mirror -and $Health.mirror.mode -eq 'readonly')
}

$configured = (Test-Path -LiteralPath $envFile) -and
    [bool](Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*MTB_MIRROR_READER_DATABASE_URL\s*=\s*\S' } | Select-Object -First 1)
if (-not $configured) {
    Stop-Here ('На овој компјутер нема поставена копија од облакот (во server\.env нема MTB_MIRROR_READER_DATABASE_URL).' +
        [Environment]::NewLine + 'Како се поставува: docs\SUPABASE-MIRROR.md.')
}

$health = Get-MirrorHealth
if ($health -and -not (Test-ReadOnlyCopy $health)) {
    Stop-Here ("На портата $Port одговара сервер што НЕ е копија само за читање. Ништо не е отворено." +
        [Environment]::NewLine + 'Исклучи го тој сервер, или пушти ја копијата на друга порта.')
}

if (-not $health) {
    Write-Host 'Серверот на копијата не работи. Го вклучувам (во свој, минимизиран прозорец)…'
    $server = Join-Path $PSScriptRoot 'run-mirror-server.ps1'
    Start-Process powershell.exe -WindowStyle Minimized -WorkingDirectory $root -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $server + '"'), '-Port', "$Port")
    for ($i = 0; $i -lt 60 -and -not $health; $i++) {
        Start-Sleep -Seconds 1
        $health = Get-MirrorHealth
    }
    if (-not $health) {
        Stop-Here ('Серверот на копијата не одговори за една минута. Погледни го неговиот прозорец на лентата со задачи: таму пишува зошто.')
    }
    if (-not (Test-ReadOnlyCopy $health)) {
        Stop-Here "Серверот на портата $Port тргна, но не се претставува како копија само за читање. Ништо не е отворено."
    }
}

Write-Host ''
Write-Host ('Копија од облакот: ' + $health.server.label + ' · база ' + $health.database) -ForegroundColor Green
$raw = $health.mirror.dataAt
if ($raw) {
    # Windows PowerShell leaves the JSON date as text; PowerShell 7 makes it a DateTime.
    $at = if ($raw -is [DateTime]) { $raw.ToLocalTime() }
          else { [DateTimeOffset]::Parse([string]$raw, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime }
    $age = (Get-Date) - $at
    $old = if ($age.TotalHours -lt 1) { 'помалку од еден час' }
           elseif ($age.TotalHours -lt 48) { [string][int][Math]::Floor($age.TotalHours) + ' часа' }
           else { [string][int][Math]::Floor($age.TotalDays) + ' дена' }
    Write-Host ('Податоците се од ' + $at.ToString('dd.MM.yyyy, HH:mm') + ' — стари ' + $old + '.')
    Write-Host 'Она што е внесено во облакот потоа го нема тука. „Освежи ја копијата“ кажува колку се разликува.'
} else {
    Write-Host 'Во копијата уште нема преземена снимка. „Освежи ја копијата“ ја презема.' -ForegroundColor Yellow
}
Write-Host 'Само за читање: ништо што ќе смениш таму не се зачувува.'

$url = "http://localhost:$Port/$Page"
if (-not $NoBrowser) {
    Start-Process $url
    Write-Host ''
    Write-Host ('Отворено во прелистувачот: ' + $url)
}
Close-Window 0
