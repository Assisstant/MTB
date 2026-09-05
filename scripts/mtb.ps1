# mtb.ps1 — the front door. Opens the day; closes it when asked.
#
#   двоен клик на кратенката MTB              проверки, па прелистувач
#   двоен клик на „MTB - Zavrshi den"         бекап, објава на pCloud, гаси сервер
#
#   ... -Action run | stop | status
#
# QUIET WHEN THERE IS NOTHING TO SAY. On a clean start the window closes itself
# as soon as the browser opens: a report nobody needs is a window in the way,
# and a window that is always there stops being read. It stays only when a step
# warned, and it stops and says so out loud — a message box, not a line in a
# console that may be minimised — when a step failed.
#
# There is deliberately no window to keep open and no menu to remember. Relying
# on someone pressing Exit at the end of a school day is relying on the wrong
# thing; the closing procedures belong to a shortcut and, from step 4 of
# docs/PLAN-start-stop.md, to a logoff trigger and an idle rule. A lid closed in
# a hurry should be as safe as a button pressed on purpose.
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
    [switch] $Stay          # keep the window open even when everything is fine
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'procedures-lib.ps1')
$Ctx = New-MtbContext -ScriptsDir $PSScriptRoot -Port $Port

function Show-Popup {
    param([string] $Text, [string] $Icon = 'Warning')
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [void][System.Windows.Forms.MessageBox]::Show($Text, 'MTB', 'OK', $Icon)
    } catch {
        # No WinForms is not a reason to lose the message.
        Write-Host ''
        Write-Host $Text -ForegroundColor Red
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
    $results = @()
    foreach ($p in (Get-MtbProcedures -ScriptsDir $PSScriptRoot -Phase $Phase)) {
        $r = Invoke-MtbProcedure -Procedure $p -Ctx $Ctx
        Write-Result $r
        $results += $r
        if ($StopOnFail -and $r.Status -eq 'FAIL') { break }
    }
    return $results
}

function Get-Bad { param($Results) return @($Results | Where-Object { $_.Status -eq 'FAIL' }) }
function Get-Warned { param($Results) return @($Results | Where-Object { $_.Status -eq 'WARN' }) }

Write-Host ''
Write-Host 'MTB' -ForegroundColor Cyan -NoNewline
Write-Host "  $($Ctx.RepoRoot)"
Write-Host ''

switch ($Action) {

    'status' {
        Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan
        Write-Host ''
        Read-Host 'Enter за затворање' | Out-Null
        exit 0
    }

    'stop' {
        Write-Host 'Затворам го денот' -ForegroundColor Cyan
        $results = Invoke-Phase -Phase 'stop'          # без -StopOnFail, намерно
        $bad = Get-Bad $results
        Write-Host ''
        if ($bad.Count) {
            Show-Popup ("Денот е затворен, но не сè помина:" + [Environment]::NewLine + [Environment]::NewLine +
                        (($bad | ForEach-Object { "$($_.Label): $($_.Message)" }) -join [Environment]::NewLine))
            Read-Host 'Enter за затворање' | Out-Null
            exit 1
        }
        Write-Host '  Бекап направен, snapshot објавен, серверот спуштен.' -ForegroundColor Green
        Start-Sleep -Seconds 3
        exit 0
    }

    default {
        Write-Host 'Отворам го денот' -ForegroundColor Cyan
        $results = Invoke-Phase -Phase 'start' -StopOnFail
        $bad = Get-Bad $results
        Write-Host ''

        if ($bad.Count) {
            $first = $bad[0]
            $text = "Застанав пред да ги отворам апликациите." + [Environment]::NewLine + [Environment]::NewLine +
                    "$($first.Label): $($first.Message)"
            if ($first.Fix) { $text += [Environment]::NewLine + [Environment]::NewLine + $first.Fix }
            Show-Popup $text 'Error'
            Read-Host 'Enter за затворање' | Out-Null
            exit 1
        }

        if ($Action -eq 'start') { exit 0 }

        $warned = Get-Warned $results
        if ($warned.Count -or $Stay) {
            Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan
            Write-Host ''
            Write-Host "  $($warned.Count) работа(и) вредат поглед — прозорецот останува." -ForegroundColor Yellow
            Write-Host '  Кога ќе завршиш за денес: кратенката „MTB - Zavrshi den".' -ForegroundColor DarkGray
            Write-Host ''
            Read-Host 'Enter за затворање' | Out-Null
        }
        exit 0
    }
}
