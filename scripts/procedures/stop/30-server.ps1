# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Last, because everything above needs the database and some of it needs the
# server. Stopping has to deal with the scheduled task, the supervisor and the
# node process in that order — server-control.ps1 already knows.

param([hashtable] $Ctx)

$control = Join-Path $Ctx.Scripts 'server-control.ps1'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $control stop -Port $Ctx.Port *> $null
} finally { $ErrorActionPreference = $previous }

Start-Sleep -Milliseconds 500
$listening = Get-NetTCPConnection -LocalPort $Ctx.Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    return [pscustomobject]@{ Status = 'WARN'; Message = "нешто сè уште слуша на $($Ctx.Port)"; Fix = 'scripts\server-control.ps1 status' }
}
return [pscustomobject]@{ Status = 'OK'; Message = 'серверот е спуштен' }
