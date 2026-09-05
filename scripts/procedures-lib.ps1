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
