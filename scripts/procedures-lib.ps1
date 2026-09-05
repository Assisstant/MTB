# procedures-lib.ps1 — finding and running the procedure files.
#
# Dot-sourced by mtb.ps1 so the window and the console text mode run exactly the
# same steps in the same order. A second copy of this logic is a second place
# for the start/stop asymmetry to be got wrong.
#
# A procedure is a .ps1 in scripts\procedures\<phase>\, ordered by filename:
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }

function New-MtbContext {
    param([string] $ScriptsDir, [int] $Port = 3000)
    return @{
        RepoRoot = Split-Path -Parent $ScriptsDir
        Scripts  = $ScriptsDir
        Port     = $Port
        BaseUrl  = "http://127.0.0.1:$Port"
    }
}

function Get-MtbProcedures {
    param([string] $ScriptsDir, [string] $Phase)
    $dir = Join-Path $ScriptsDir (Join-Path 'procedures' $Phase)
    if (-not (Test-Path $dir)) { return @() }
    return @(Get-ChildItem -Path $dir -Filter '*.ps1' | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{ Path = $_.FullName; Label = ($_.BaseName -replace '^\d+-', '') }
    })
}

# Runs one procedure and always returns a result, whatever it does. A procedure
# that throws is a FAIL with its message; one that returns nothing usable is a
# WARN, because silence is not success. Stray pipeline output is ignored: the
# result is the last object that actually carries a Status.
function Invoke-MtbProcedure {
    param([pscustomobject] $Procedure, [hashtable] $Ctx)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $emitted = @(& $Procedure.Path -Ctx $Ctx)
        $result = $emitted |
            Where-Object { $_ -and $_.PSObject.Properties.Name -contains 'Status' } |
            Select-Object -Last 1
    } catch {
        $result = [pscustomobject]@{ Status = 'FAIL'; Message = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $previous
    }

    if (-not $result) {
        $result = [pscustomobject]@{ Status = 'WARN'; Message = 'процедурата не врати резултат' }
    }
    return [pscustomobject]@{
        Label   = $Procedure.Label
        Status  = $result.Status
        Message = [string]$result.Message
        Fix     = [string]$result.Fix
    }
}

function Get-MtbHealth {
    param([hashtable] $Ctx)
    try {
        $h = Invoke-RestMethod -Uri "$($Ctx.BaseUrl)/api/health" -TimeoutSec 3
        $label = if ($h.server.label) { $h.server.label } else { 'СЕРВЕР' }
        return [pscustomobject]@{
            Ok = [bool]$h.ok; Label = $label; Database = [string]$h.database
            Warning = [string]$h.server.warning
            Line = "$label · база $($h.database) · $($Ctx.BaseUrl)"
        }
    } catch {
        return [pscustomobject]@{
            Ok = $false; Label = ''; Database = ''; Warning = ''
            Line = "серверот не одговара на $($Ctx.BaseUrl)"
        }
    }
}

# ── running a phase without blocking whoever asked ──────────────────────────
#
# A procedure can take most of a minute — 40-server waits for the API to answer.
# Run that on the thread that paints a window and Windows stops receiving
# messages from it, marks it "not responding" and paints it black. The window
# then looks broken at exactly the moment it is doing its job.
#
# So the phase runs in its own runspace and pushes each result into a queue as
# it finishes. The caller drains the queue whenever it likes — a Forms timer, a
# loop, anything — and never waits on a procedure.

function Start-MtbPhase {
    param(
        [string] $ScriptsDir,
        [string] $Phase,
        [hashtable] $Ctx,
        [bool] $StopOnFail = $false
    )

    $queue = New-Object System.Collections.Concurrent.ConcurrentQueue[object]

    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = 'STA'
    $runspace.ThreadOptions  = 'ReuseThread'
    $runspace.Open()
    $runspace.SessionStateProxy.SetVariable('Queue', $queue)

    $worker = [powershell]::Create()
    $worker.Runspace = $runspace
    [void]$worker.AddScript({
        param([string] $ScriptsDir, [string] $Phase, [hashtable] $Ctx, [bool] $StopOnFail)
        . (Join-Path $ScriptsDir 'procedures-lib.ps1')
        foreach ($p in (Get-MtbProcedures -ScriptsDir $ScriptsDir -Phase $Phase)) {
            $Queue.Enqueue([pscustomobject]@{ Kind = 'started'; Label = $p.Label })
            $r = Invoke-MtbProcedure -Procedure $p -Ctx $Ctx
            $Queue.Enqueue([pscustomobject]@{ Kind = 'result'; Result = $r })
            if ($StopOnFail -and $r.Status -eq 'FAIL') { break }
        }
        $Queue.Enqueue([pscustomobject]@{ Kind = 'done' })
    })
    [void]$worker.AddArgument($ScriptsDir)
    [void]$worker.AddArgument($Phase)
    [void]$worker.AddArgument($Ctx)
    [void]$worker.AddArgument($StopOnFail)

    return [pscustomobject]@{
        Queue    = $queue
        Worker   = $worker
        Runspace = $runspace
        Handle   = $worker.BeginInvoke()
    }
}

# Takes whatever has arrived so far. Never waits.
function Receive-MtbPhase {
    param([pscustomobject] $Phase)
    $items = @()
    $item = $null
    while ($Phase.Queue.TryDequeue([ref]$item)) { $items += $item }
    return $items
}

function Stop-MtbPhase {
    param([pscustomobject] $Phase)
    try { if ($Phase.Handle) { [void]$Phase.Worker.EndInvoke($Phase.Handle) } } catch { }
    try { $Phase.Worker.Dispose() } catch { }
    try { $Phase.Runspace.Close(); $Phase.Runspace.Dispose() } catch { }
}
