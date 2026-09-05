# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Is the backup route open, and how old is what is on it?
#
# This can only ever WARN. The two databases are independent on purpose — when
# pCloud is gone the apps must work exactly as before, which is the whole reason
# the architecture is shaped this way. Blocking the day because a sync folder is
# missing would break the property it was built to have.
#
# It also never accepts anything. Comparing and accepting are deliberate manual
# actions (docs/MANUAL-DB-SYNC.md); the real comparison is
#   scripts\manual-db-sync.ps1 -Mode Compare

param([hashtable] $Ctx)

$envFile = Join-Path $Ctx.RepoRoot 'server\.env'
if (-not (Test-Path $envFile)) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'server\.env недостасува — не знам каде е pCloud' }
}
$lines = Get-Content $envFile
function Val([string] $name) {
    $hit = $lines | Select-String "^$name=" | Select-Object -First 1
    if ($hit) { return ($hit.Line -replace "^$name=", '').Trim() }
    return $null
}
$dir = Val 'MANUAL_SYNC_DIR'; if (-not $dir) { $dir = Val 'HANDOFF_DIR' }; if (-not $dir) { $dir = Val 'SYNC_DIR' }
$me  = Val 'MANUAL_SYNC_NAME'; if (-not $me) { $me = Val 'HANDOFF_NAME' }; if (-not $me) { $me = Val 'SYNC_NAME' }

if (-not $dir) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'ниедна sync папка не е поставена во .env' }
}
if (-not (Test-Path $dir)) {
    return [pscustomobject]@{
        Status  = 'WARN'
        Message = 'папката не е достапна — работам локално, објавата на крајот ќе се прескокне'
        Fix     = 'провери дали pCloud е вклучен'
    }
}

$mine = Join-Path $dir $me
if (-not (Test-Path $mine)) {
    return [pscustomobject]@{ Status = 'WARN'; Message = "$me сè уште нема објавено snapshot тука" }
}
$newest = Get-ChildItem -Path $mine -Recurse -File -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest) {
    return [pscustomobject]@{ Status = 'WARN'; Message = "папката на $me е празна" }
}
$age = [int]((Get-Date) - $newest.LastWriteTime).TotalDays
if ($age -ge 7) {
    return [pscustomobject]@{
        Status  = 'WARN'
        Message = "последната објава е од пред $age дена"
        Fix     = 'заврши го денот со Enter, тоа објавува'
    }
}
return [pscustomobject]@{ Status = 'OK'; Message = "последна објава пред $age ден(а)" }
