# mtb.ps1 — the front door. Opens the day; closes it when asked.
#
#   двоен клик на кратенката MTB              проверки, па прелистувач
#   двоен клик на „MTB - Zavrshi den"         бекап, објава на pCloud, гаси сервер
#
#   ... -Action run | stop | status
#   ... -Stay        не затворај го прозорецот ни кога сè е во ред
#
# QUIET WHEN THERE IS NOTHING TO SAY. On a clean start the window closes itself
# as soon as the browser opens: a report nobody needs is a window in the way,
# and a window that is always there stops being read. It stays only when a step
# warned, and it stops and says so out loud — a message box, not a line in a
# console that may already be gone — when a step failed.
#
# EVERY RUN LEAVES A TRANSCRIPT in backups\mtb.log. A front door that closes
# itself hides its own failures: the first version of this exited so fast that
# the error scrolled past before it could be read, which looked like doing
# nothing at all. The log is how a problem gets diagnosed after the fact instead
# of being reproduced in front of someone.
#
# There is deliberately no window to keep open and no menu to remember. Relying
# on someone pressing Exit at the end of a school day is relying on the wrong
# thing; the closing procedures belong to a shortcut and, from step 4 of
# docs/PLAN-start-stop.md, to a logoff trigger and an idle rule.
#
# The two rules, shared with everything else through procedures-lib.ps1:
#
#   On the way IN it gives up at the first FAIL. Apps opened on a server that
#   does not answer, or a database on the wrong migration, do not fail visibly —
#   they answer wrongly, which is worse than not opening.
#
#   On the way OUT it never gives up. A failed backup must not stop the publish;
#   a failed publish must not leave the server running.

param(
    [ValidateSet('run', 'start', 'stop', 'status')]
    [string] $Action = 'run',
    [int] $Port = 3000,
    [switch] $Stay
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $repoRoot 'backups'
$logFile  = Join-Path $logDir 'mtb.log'
try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 512KB)) { Remove-Item $logFile -Force }
    Start-Transcript -Path $logFile -Append -Force | Out-Null
} catch { }

function Show-Popup {
    param([string] $Text, [string] $Icon = 'Warning')
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [void][System.Windows.Forms.MessageBox]::Show($Text, 'MTB', 'OK', $Icon)
    } catch {
        Write-Host ''
        Write-Host $Text -ForegroundColor Red
        Read-Host 'Enter за затворање' | Out-Null
    }
}

function Write-Result {
    param([pscustomobject] $R)
    $colour = switch ($R.Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ('  {0,-5}' -f $R.Status) -ForegroundColor $colour -NoNewline
    Write-Host (' {0,-11} ' -f $R.Label) -NoNewline
    Write-Host $R.Message
    if ($R.Fix) { Write-Host ('        ' + $R.Fix) -ForegroundColor DarkGray }
}

function Invoke-Phase {
    param([string] $Phase, [switch] $StopOnFail)
    $procedures = @(Get-MtbProcedures -ScriptsDir $PSScriptRoot -Phase $Phase)
    Write-Host ("  ({0} процедури во procedures\{1})" -f $procedures.Count, $Phase) -ForegroundColor DarkGray
    if (-not $procedures.Count) {
        throw "Ниедна процедура не е најдена во $(Join-Path $PSScriptRoot ('procedures\' + $Phase))"
    }
    $results = @()
    foreach ($p in $procedures) {
        $r = Invoke-MtbProcedure -Procedure $p -Ctx $Ctx
        Write-Result $r
        $results += $r
        if ($StopOnFail -and $r.Status -eq 'FAIL') { break }
    }
    return $results
}

function Invoke-Main {
    Write-Host ''
    Write-Host 'MTB' -ForegroundColor Cyan -NoNewline
    Write-Host "  $repoRoot"
    Write-Host ''

    if ($Action -eq 'status') {
        Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan
        Write-Host ''
        Read-Host 'Enter за затворање' | Out-Null
        return 0
    }

    if ($Action -eq 'stop') {
        Write-Host 'Затворам го денот' -ForegroundColor Cyan
        $results = Invoke-Phase -Phase 'stop'          # без -StopOnFail, намерно
        $bad = @($results | Where-Object { $_.Status -eq 'FAIL' })
        Write-Host ''
        if ($bad.Count) {
            Show-Popup ("Денот е затворен, но не сè помина:" + [Environment]::NewLine + [Environment]::NewLine +
                        (($bad | ForEach-Object { "$($_.Label): $($_.Message)" }) -join [Environment]::NewLine))
            return 1
        }
        Write-Host '  Бекап направен, snapshot објавен, серверот спуштен.' -ForegroundColor Green
        Start-Sleep -Seconds 3
        return 0
    }

    Write-Host 'Отворам го денот' -ForegroundColor Cyan
    $results = Invoke-Phase -Phase 'start' -StopOnFail
    $bad = @($results | Where-Object { $_.Status -eq 'FAIL' })
    Write-Host ''

    if ($bad.Count) {
        $first = $bad[0]
        $text = "Застанав пред да ги отворам апликациите." + [Environment]::NewLine + [Environment]::NewLine +
                "$($first.Label): $($first.Message)"
        if ($first.Fix) { $text += [Environment]::NewLine + [Environment]::NewLine + $first.Fix }
        Show-Popup $text 'Error'
        return 1
    }

    if ($Action -eq 'start') { return 0 }

    $warned = @($results | Where-Object { $_.Status -eq 'WARN' })
    if ($warned.Count -or $Stay) {
        Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan
        Write-Host ''
        Write-Host "  $($warned.Count) работа(и) вредат поглед — прозорецот останува." -ForegroundColor Yellow
        Write-Host '  Кога ќе завршиш за денес: кратенката „MTB - Zavrshi den".' -ForegroundColor DarkGray
        Write-Host ''
        Read-Host 'Enter за затворање' | Out-Null
    }
    return 0
}

$code = 1
try {
    $lib = Join-Path $PSScriptRoot 'procedures-lib.ps1'
    if (-not (Test-Path $lib)) { throw "Недостасува $lib" }
    . $lib
    $Ctx = New-MtbContext -ScriptsDir $PSScriptRoot -Port $Port
    $code = Invoke-Main
} catch {
    # A front door that closes itself must never fail silently.
    $detail = "$($_.Exception.Message)"
    if ($_.InvocationInfo) { $detail += [Environment]::NewLine + [Environment]::NewLine + $_.InvocationInfo.PositionMessage }
    Show-Popup ("MTB не тргна." + [Environment]::NewLine + [Environment]::NewLine + $detail +
                [Environment]::NewLine + [Environment]::NewLine + "Целиот запис: backups\mtb.log") 'Error'
    $code = 1
} finally {
    try { Stop-Transcript | Out-Null } catch { }
}
exit $code
