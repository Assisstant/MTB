# mirror-refresh.ps1 — „MTB - Osvezi kopija": is the local read-only copy the
# same as the cloud, and if not, replace it — after being asked.
#
# The owner, 7 Oct 2026: „само кажи ако не се податоците во sync". So the first
# thing this does is TELL: it downloads one snapshot from the cloud, compares
# it with the copy, and says „иста" or how many rows differ, table by table.
# Nothing is changed by that. Only then does it ask „DA".
#
# It adds no way of its own to write the copy. Both steps are `npm run
# mirror:pull` (server\scripts\mirror-pull.ts), exactly as docs\SUPABASE-MIRROR.md
# describes doing by hand: a dry run, then an apply that names the SAME saved
# file, its snapshot id and its plan hash. Every guard is the tool's — a local
# target whose name ends in _mirror, the source's identity, the schema, an
# older snapshot, a plan that changed in between — and a refusal is shown as
# the tool said it, not worked around.
#
# ONE DIRECTION: cloud → this computer. Nothing is sent to the cloud, and
# therapy_dev (the normal local database) is never the target.
#
# A large deletion keeps its second question. The tool wants the exact number
# of rows typed after the deletions were looked at; this asks for that number
# instead of supplying it, or the speed bump would be a formality.
#
#   powershell -ExecutionPolicy Bypass -File scripts\mirror-refresh.ps1
#   -Check     only tell (exit 0 = the same, 2 = different, 1 = could not look)
#   -NoWait    do not wait for Enter at the end

param(
    [switch] $Check,
    [switch] $NoWait
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'server'
$envFile = Join-Path $serverDir '.env'
$nl = [Environment]::NewLine

function Close-Window([int] $Code) {
    if (-not $NoWait) { [void](Read-Host 'Enter за затворање') }
    exit $Code
}
function Stop-Here([string] $Text, [int] $Code = 1) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Yellow
    Close-Window $Code
}
function Test-EnvKey([string] $Key) {
    return (Test-Path -LiteralPath $envFile) -and
        [bool](Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=\s*\S" } | Select-Object -First 1)
}

foreach ($key in 'MTB_MIRROR_TARGET_DATABASE_URL', 'MTB_MIRROR_SOURCE_URL', 'MTB_MIRROR_PULL_KEY') {
    if (-not (Test-EnvKey $key)) {
        Stop-Here ("На овој компјутер копијата од облакот не е поставена (во server\.env нема $key)." + $nl +
            'Како се поставува: docs\SUPABASE-MIRROR.md.')
    }
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = 'C:\Program Files\nodejs\npm.cmd' }

# The tool's output goes to files and is read back: a native program's stderr
# through a PowerShell pipe becomes error records, and under 'Stop' those throw.
function Invoke-Pull([string] $ArgLine) {
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $npm -ArgumentList ('run --silent mirror:pull' + $ArgLine) -WorkingDirectory $serverDir `
            -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null = $p.Handle   # Windows PowerShell forgets the exit code of a process whose handle it never took
        $p.WaitForExit()
        $lines = @(Get-Content -LiteralPath $out -Encoding UTF8) + @(Get-Content -LiteralPath $err -Encoding UTF8)
        return @{ Code = $p.ExitCode; Lines = @($lines | Where-Object { $_ -ne $null }) }
    } finally {
        Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    }
}
function Find-Value([string[]] $Lines, [string] $Pattern) {
    foreach ($line in $Lines) { if ($line -match $Pattern) { return $Matches[1].Trim() } }
    return ''
}

Write-Host 'Ја преземам снимката од облакот и ја споредувам со копијата.'
Write-Host 'Овој чекор не менува ништо. Може да потрае до една минута…'
$dry = Invoke-Pull ''
if ($dry.Code -ne 0) {
    Write-Host ''
    $dry.Lines | ForEach-Object { Write-Host ('  ' + $_) }
    Stop-Here ('Не можев да споредам — погоре е што рече алатката. Копијата не е сменета.' + $nl +
        'Најчесто: нема Интернет, облакот се буди (пробај пак по една минута), или облакот има понови миграции од копијата.')
}

$id = Find-Value $dry.Lines '^snapshot:\s+(\S+)'
$hash = Find-Value $dry.Lines '^plan hash:\s+(\S+)'
$file = Find-Value $dry.Lines '^snapshot file:\s+(.+)$'
$dataAt = Find-Value $dry.Lines '^data time:\s+(\S+)'
$totals = $dry.Lines | Where-Object { $_ -match '^changes:\s+\+(\d+)\s+~(\d+)\s+-(\d+)' } | Select-Object -First 1
if (-not $id -or -not $hash -or -not $file -or -not $totals) {
    $dry.Lines | ForEach-Object { Write-Host ('  ' + $_) }
    Stop-Here 'Алатката одговори, но не како што очекував. Ништо не е сменето; примени рачно според docs\SUPABASE-MIRROR.md.'
}
[void]($totals -match '^changes:\s+\+(\d+)\s+~(\d+)\s+-(\d+)')
$added = [int]$Matches[1]; $changed = [int]$Matches[2]; $deleted = [int]$Matches[3]

$when = $dataAt
try { $when = [DateTimeOffset]::Parse($dataAt, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime.ToString('dd.MM.yyyy, HH:mm') } catch { }

Write-Host ''
if ($dry.Lines | Where-Object { $_ -match '^REFUSED' }) {
    Stop-Here ('Облакот врати ПОСТАРА снимка од таа што веќе е во копијата. Ништо не е сменето.' + $nl +
        'Тоа не треба да се случи; не применувај ништо и провери го облакот.')
}
if (($added + $changed + $deleted) -eq 0) {
    Write-Host ('Копијата е ИСТА со облакот. Состојба на облакот од ' + $when + '.') -ForegroundColor Green
    Close-Window 0
}

Write-Host 'Копијата НЕ е иста со облакот.' -ForegroundColor Yellow
Write-Host ('Облакот (состојба од ' + $when + ') наспроти копијата: ' + $added + ' нови реда, ' + $changed + ' сменети, ' + $deleted + ' што ги нема повеќе.')
Write-Host 'По табела (+ нови, ~ сменети, - избришани):'
$dry.Lines | Where-Object { $_ -match '^\s{2}\S+\s+\+\d+ ~\d+ -\d+\s*$' } | ForEach-Object { Write-Host $_ }
$authNote = $dry.Lines | Where-Object { $_ -match '^local auth rows cleared' } | Select-Object -First 1
if ($authNote) { Write-Host ('  ' + $authNote) }

if ($Check) { Close-Window 2 }

# What goes on a command line is checked for shape, not trusted for it.
if ($id -notmatch '^[A-Za-z0-9._:-]+$' -or $hash -notmatch '^[A-Fa-f0-9]+$') {
    Stop-Here 'Ознаката на снимката не изгледа како што треба. Ништо не е сменето.'
}
$mirrorDir = [IO.Path]::GetFullPath((Join-Path $root 'backups\mirror'))
if (-not (Test-Path -LiteralPath $file) -or -not [IO.Path]::GetFullPath($file).StartsWith($mirrorDir, [StringComparison]::OrdinalIgnoreCase) -or $file.Contains('"')) {
    Stop-Here 'Зачуваната снимка не е таму каде што треба (backups\mirror). Ништо не е сменето.'
}

Write-Host ''
Write-Host 'Со „DA“ копијата се заменува со оваа снимка. Оди само од облакот кон овој компјутер;'
Write-Host 'ништо не се праќа во облакот и локалната база (therapy_dev) не се допира.'
$answer = Read-Host 'Напиши DA за да ја освежиш копијата (сè друго = откажи)'
if ($answer -cne 'DA') { Stop-Here 'Откажано. Копијата не е сменета.' 2 }

$deletePart = ''
$wanted = Find-Value $dry.Lines '--allow-delete-count (\d+)'
if ($wanted) {
    Write-Host ''
    Write-Host ('Ова бришење е големо: ' + $wanted + ' реда, повеќе од една петтина од копијата.') -ForegroundColor Yellow
    Write-Host 'Погледни ги табелите погоре. Ако е во ред, препиши го бројот на избришани редови.'
    $typed = Read-Host 'Број на редови што се бришат (сè друго = откажи)'
    if ($typed -ne $wanted) { Stop-Here 'Бројот не е ист. Откажано; копијата не е сменета.' 2 }
    $deletePart = ' --allow-delete-count ' + $wanted
}

Write-Host ''
Write-Host 'Ја применувам снимката…'
# The apply step insists that the copy is being treated as read-only. That is
# what this target is; saying so for this one command leaves server\.env — and
# the normal server's own mode — exactly as they were.
$env:MTB_MIRROR_MODE = 'readonly'
$apply = Invoke-Pull (' -- --apply --snapshot-file "' + $file + '" --snapshot-id ' + $id + ' --plan-hash ' + $hash + $deletePart)
$apply.Lines | Where-Object { $_ -match '^(Applied|\S+ was already applied|Mirror pull failed)' } | ForEach-Object { Write-Host ('  ' + $_) }
if ($apply.Code -ne 0) {
    Write-Host ''
    $apply.Lines | ForEach-Object { Write-Host ('  ' + $_) }
    Stop-Here 'Примената е одбиена — погоре е зошто. Копијата останува цела, каква што беше пред тоа.'
}
Write-Host ''
Write-Host ('Готово. Копијата сега е со состојбата на облакот од ' + $when + '.') -ForegroundColor Green
Close-Window 0
