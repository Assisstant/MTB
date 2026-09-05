# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# Open the apps through the server, never as files and never through the Pages
# copy: a page served by this machine is locked to this machine's server, while
# a copy opened from GitHub Pages keeps separate browser storage and stays a
# local copy until a server is chosen. That distinction is where a day's work
# goes missing (docs/MANUAL-DB-SYNC.md).

param([hashtable] $Ctx)

$url = "$($Ctx.BaseUrl)/start.html"
try {
    Start-Process $url | Out-Null
    return [pscustomobject]@{ Status = 'OK'; Message = $url }
} catch {
    return [pscustomobject]@{ Status = 'WARN'; Message = "не можев да го отворам прелистувачот — отвори рачно: $url" }
}
