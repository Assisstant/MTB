# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# The shortcuts live in one folder on the Desktop, „MTB", and this keeps that
# folder current on whichever machine starts the day (owner, 1 Oct 2026): a
# shortcut added to create-shortcuts.ps1 on one PC used to exist only there
# until somebody remembered to run the script on the other. Runs after the
# pull, so a new shortcut arrives with the code that added it. A missing
# shortcut never blocks the day, so nothing here can FAIL.

param([hashtable] $Ctx)

$script = Join-Path $Ctx.Scripts 'create-shortcuts.ps1'
$folder = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MTB'
$before = @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object Name)

# To a file, not the console: a nested powershell.exe under a host with no
# console of its own can die before its first line (see CLAUDE.md, git-sync).
$log = Join-Path $Ctx.RepoRoot 'backups\shortcuts.log'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Folder MTB *> $log
if ($LASTEXITCODE -ne 0) {
    return [pscustomobject]@{
        Status  = 'WARN'
        Message = 'кратенките не се обновени'
        Fix     = "види $log"
    }
}

$after = @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object Name)
$new = @($after | Where-Object { $before -notcontains $_ })
if ($new.Count) {
    return [pscustomobject]@{ Status = 'OK'; Message = "нови во папката MTB: $(($new -replace '\.lnk$', '') -join ', ')" }
}
return [pscustomobject]@{ Status = 'OK'; Message = "$($after.Count) во папката MTB на работната површина" }
