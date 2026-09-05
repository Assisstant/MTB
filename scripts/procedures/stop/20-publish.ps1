# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Publish this machine's own verified snapshot to its own pCloud folder.
#
# Export only ever writes where this machine writes. It does not read, compare
# or accept the other machine's data — that stays a deliberate manual action
# through the Manual Sync menu, with a snapshot id typed by hand.
#
# An unreachable pCloud is a WARN, not a FAIL: the day is already safe in the
# local dump from the previous step.

param([hashtable] $Ctx)

$sync = Join-Path $Ctx.Scripts 'manual-db-sync.ps1'
if (-not (Test-Path $sync)) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'manual-db-sync.ps1 недостасува' }
}
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $text = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $sync -Mode Export 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $previous }

if ($code -ne 0) {
    $why = ($text -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
    if ($text -match 'unavailable|not available|недостап') {
        return [pscustomobject]@{ Status = 'WARN'; Message = 'pCloud не е достапен — објавата се прескокна, локалниот бекап е направен' }
    }
    return [pscustomobject]@{ Status = 'WARN'; Message = "објавата не помина: $($why -replace '\s+', ' ')"; Fix = 'scripts\manual-db-sync-menu.ps1' }
}
return [pscustomobject]@{ Status = 'OK'; Message = 'snapshot објавен во pCloud' }
