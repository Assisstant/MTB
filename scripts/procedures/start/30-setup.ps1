# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# The machine itself: PostgreSQL, the migrations, the installed packages — and,
# last, whether the API answers. verify-setup.ps1 already asks all of it and
# prints OK/WARN/FAIL per line, so this runs it, counts, and surfaces only what
# is wrong. A FAIL here stops the day before the apps open, because an app on a
# half-migrated database does not fail — it answers wrongly, which is worse.
#
# It runs AFTER 20-server, not before. Its last question is whether the API
# answers, and on a cold machine nothing has started it yet; asking first turned
# every start on a healthy machine into a failure. The apps are still gated by
# it, because 50-open comes after and the phase stops at the first FAIL.

param([hashtable] $Ctx)

$verify = Join-Path $Ctx.Scripts 'verify-setup.ps1'
if (-not (Test-Path $verify)) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'verify-setup.ps1 недостасува' }
}

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $text = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verify 2>&1 | Out-String
} finally { $ErrorActionPreference = $previous }

$lines = $text -split "`r?`n"
$fails = @($lines | Where-Object { $_ -match '^\s*FAIL\s' })
$warns = @($lines | Where-Object { $_ -match '^\s*WARN\s' })

if ($fails.Count) {
    return [pscustomobject]@{
        Status  = 'FAIL'
        Message = ($fails[0].Trim() -replace '^FAIL\s+', '') + $(if ($fails.Count -gt 1) { " (и уште $($fails.Count - 1))" })
        Fix     = 'powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1'
    }
}
if ($warns.Count) {
    return [pscustomobject]@{ Status = 'WARN'; Message = "$($warns.Count) предупредување(а) — сè работи" ; Fix = 'scripts\verify-setup.ps1' }
}
return [pscustomobject]@{ Status = 'OK'; Message = 'машината е во ред' }
