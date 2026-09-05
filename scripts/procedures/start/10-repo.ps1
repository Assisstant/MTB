# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Bring the code up to date, but never at the cost of losing local work: a dirty
# tree is left alone and reported. Being offline is not a problem worth blocking
# the day for, so nothing here can FAIL.

param([hashtable] $Ctx)

$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $git) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'git не е најден — кодот не е проверен' }
}

$dirty = @(& $git -C $Ctx.RepoRoot status --porcelain 2>&1 | Where-Object { $_ })
if ($dirty.Count) {
    return [pscustomobject]@{
        Status  = 'WARN'
        Message = "$($dirty.Count) неснимен(и) фајл(а) — не повлекувам"
        Fix     = 'git status'
    }
}

$out = @(& $git -C $Ctx.RepoRoot pull --ff-only 2>&1)
if ($LASTEXITCODE -ne 0) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'нема мрежа или гранката се разишла — работам со инсталираниот код' }
}
$head = (& $git -C $Ctx.RepoRoot log --oneline -1 2>&1) -join ''
if ($out -match 'Already up to date') {
    return [pscustomobject]@{ Status = 'OK'; Message = "во тек — $head" }
}
return [pscustomobject]@{ Status = 'OK'; Message = "повлечено — $head" }
