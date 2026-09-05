# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Start it, then wait until it actually answers. "The process is running" and
# "the API responds" are different claims and only the second one is worth
# opening the apps on top of.
#
# THIS RUNS BEFORE 30-setup ON PURPOSE. verify-setup.ps1 ends by asking whether
# the API answers, which on a cold machine it cannot until this step has run —
# so with the checks first, every single start failed on a machine that was
# perfectly fine. A gate that asks about a thing the next step creates is not a
# gate, it is a deadlock. Do not move this back above the checks.
#
# /api/health also says which installation this is and which database it holds,
# which is the one thing worth reading out loud before a day's work: the two
# machines are both called ZenPC and only the local configuration knows better.

param([hashtable] $Ctx)

$control = Join-Path $Ctx.Scripts 'server-control.ps1'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $control start -Port $Ctx.Port *> $null
} finally { $ErrorActionPreference = $previous }

$deadline = (Get-Date).AddSeconds(45)
$health = $null
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Uri "$($Ctx.BaseUrl)/api/health" -TimeoutSec 3
        if ($health.ok) { break }
    } catch { Start-Sleep -Milliseconds 700 }
}

if (-not $health -or -not $health.ok) {
    return [pscustomobject]@{
        Status  = 'FAIL'
        Message = "серверот не одговара на $($Ctx.BaseUrl) по 45 секунди"
        Fix     = 'powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 status'
    }
}

$label = if ($health.server.label) { $health.server.label } else { 'СЕРВЕР' }
$warn  = $health.server.warning
if ($warn) {
    return [pscustomobject]@{ Status = 'WARN'; Message = "$label · $($health.database) — $warn" }
}
return [pscustomobject]@{ Status = 'OK'; Message = "$label · база $($health.database)" }
