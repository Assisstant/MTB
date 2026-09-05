# mtb.ps1 — the front door. One window that opens the day and closes it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\mtb.ps1            влез, апликации, мени
#   ... -Action start     само влезните процедури
#   ... -Action stop      само излезните
#   ... -Action status    ништо не менува
#
# The desktop shortcut points here, not at a page: this runs the checks, then
# opens the apps itself. See docs/PLAN-start-stop.md for why each decision is
# the way it is.
#
# The two rules that matter:
#
#   On the way IN it gives up at the first FAIL. Apps opened on a server that
#   does not answer, or a database on the wrong migration, do not fail visibly —
#   they answer wrongly, and that is worse than not opening.
#
#   On the way OUT it never gives up. A failed backup must not stop the publish;
#   a failed publish must not leave the server running. Every step runs, the
#   failures are reported, and the exit code carries them.

param(
    [ValidateSet('run', 'start', 'stop', 'status')]
    [string] $Action = 'run',
    [int] $Port = 3000
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot

$Ctx = @{
    RepoRoot = $repoRoot
    Scripts  = $PSScriptRoot
    Port     = $Port
    BaseUrl  = "http://127.0.0.1:$Port"
}

function Write-Line {
    param([string] $Status, [string] $Label, [string] $Message, [string] $Fix)
    $colour = switch ($Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ('  {0,-5}' -f $Status) -ForegroundColor $colour -NoNewline
    Write-Host (' {0,-11} ' -f $Label) -NoNewline
    Write-Host $Message
    if ($Fix) { Write-Host ('        ' + $Fix) -ForegroundColor DarkGray }
}

# Procedures are files, discovered and ordered by name. Adding one is a new
# numbered file in the folder; nothing here changes.
function Invoke-Phase {
    param([string] $Phase, [switch] $StopOnFail)

    $dir = Join-Path $PSScriptRoot "procedures\$Phase"
    if (-not (Test-Path $dir)) {
        Write-Host "  (нема процедури во procedures\$Phase)" -ForegroundColor DarkGray
        return @()
    }

    $results = @()
    foreach ($file in (Get-ChildItem -Path $dir -Filter '*.ps1' | Sort-Object Name)) {
        $label = $file.BaseName -replace '^\d+-', ''
        $result = $null
        try {
            $emitted = @(& $file.FullName -Ctx $Ctx)
            $result = $emitted |
                Where-Object { $_ -and $_.PSObject.Properties.Name -contains 'Status' } |
                Select-Object -Last 1
        } catch {
            $result = [pscustomobject]@{ Status = 'FAIL'; Message = $_.Exception.Message }
        }
        if (-not $result) {
            $result = [pscustomobject]@{ Status = 'WARN'; Message = 'процедурата не врати резултат' }
        }

        Write-Line -Status $result.Status -Label $label -Message $result.Message -Fix $result.Fix
        $results += [pscustomobject]@{ Label = $label; Status = $result.Status }

        if ($StopOnFail -and $result.Status -eq 'FAIL') {
            Write-Host ''
            Write-Host '  Застанувам тука. Апликациите не се отвораат врз ова.' -ForegroundColor Red
            break
        }
    }
    return $results
}

function Show-Health {
    try {
        $h = Invoke-RestMethod -Uri "$($Ctx.BaseUrl)/api/health" -TimeoutSec 3
        $label = if ($h.server.label) { $h.server.label } else { 'СЕРВЕР' }
        Write-Host "  $label · база $($h.database) · $($Ctx.BaseUrl)" -ForegroundColor Cyan
        if ($h.server.warning) { Write-Host "  $($h.server.warning)" -ForegroundColor Yellow }
    } catch {
        Write-Host "  серверот не одговара на $($Ctx.BaseUrl)" -ForegroundColor Red
    }
}

function Invoke-Stop {
    Write-Host ''
    Write-Host 'Затворам го денот' -ForegroundColor Cyan
    $results = Invoke-Phase -Phase 'stop'          # без -StopOnFail, намерно
    $bad = @($results | Where-Object { $_.Status -eq 'FAIL' })
    Write-Host ''
    if ($bad.Count) {
        Write-Host "  $($bad.Count) чекор(и) не поминаа: $(($bad.Label) -join ', ')" -ForegroundColor Red
        return 1
    }
    Write-Host '  Готово. Може да се затвори.' -ForegroundColor Green
    return 0
}

Write-Host ''
Write-Host 'MTB' -ForegroundColor Cyan -NoNewline
Write-Host "  $repoRoot"
Write-Host ''

switch ($Action) {
    'status' { Show-Health; Write-Host ''; exit 0 }
    'stop'   { exit (Invoke-Stop) }
}

Write-Host 'Отворам го денот' -ForegroundColor Cyan
$startResults = Invoke-Phase -Phase 'start' -StopOnFail
$failed = @($startResults | Where-Object { $_.Status -eq 'FAIL' }).Count -gt 0
Write-Host ''

if ($failed) {
    Write-Host 'Поправи го горното па пушти пак.' -ForegroundColor Red
    Write-Host ''
    if ($Action -eq 'run') { Read-Host 'Enter за затворање' | Out-Null }
    exit 1
}
if ($Action -eq 'start') { exit 0 }

# ── the window stays: this is what makes an exit possible at all ────────────
while ($true) {
    Write-Host ''
    Show-Health
    Write-Host ''
    Write-Host '  [Enter]  заврши го денот — бекап, објава на pCloud, гаси сервер' -ForegroundColor Green
    Write-Host '  [O]      отвори ги апликациите пак'
    Write-Host '  [S]      состојба'
    Write-Host '  [Q]      само затвори — серверот останува, објава нема' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Ако го затвориш прозорецот со X, објавата нема да се направи.' -ForegroundColor DarkGray
    Write-Host ''

    $key = $null
    try {
        $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    } catch {
        # No real console (piped, or a host without RawUI): fall back to a line.
        $typed = Read-Host '  избор'
        $key = [pscustomobject]@{ VirtualKeyCode = if ($typed) { [int][char]([string]$typed).ToUpper()[0] } else { 13 } }
    }

    switch ($key.VirtualKeyCode) {
        13 { exit (Invoke-Stop) }                                  # Enter
        79 { & (Join-Path $PSScriptRoot 'procedures\start\50-open.ps1') -Ctx $Ctx | Out-Null }   # O
        83 { }                                                     # S — the loop redraws health
        81 {                                                       # Q
            Write-Host ''
            Write-Host '  Серверот останува вклучен. Објавата не е направена.' -ForegroundColor Yellow
            Write-Host ''
            exit 0
        }
        default { }
    }
}
