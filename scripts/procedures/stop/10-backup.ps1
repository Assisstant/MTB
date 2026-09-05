# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# The local copy first, because it needs nothing but this machine. If pCloud is
# gone, this is still a complete day's safety.

param([hashtable] $Ctx)

$backup = Join-Path $Ctx.Scripts 'backup-db.ps1'
if (-not (Test-Path $backup)) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'backup-db.ps1 недостасува' }
}
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $text = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $backup 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $previous }

if ($code -ne 0) {
    return [pscustomobject]@{ Status = 'FAIL'; Message = "бекапот падна (код $code)"; Fix = 'scripts\backup-db.ps1' }
}
$dump = Get-ChildItem (Join-Path $Ctx.RepoRoot 'backups\db') -Filter '*.dump' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($dump) {
    return [pscustomobject]@{ Status = 'OK'; Message = "$($dump.Name), $([int]($dump.Length/1MB)) MB" }
}
return [pscustomobject]@{ Status = 'OK'; Message = 'готово' }
