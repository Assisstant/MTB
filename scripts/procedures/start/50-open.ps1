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

#
# Where the day opens (owner, 2 Oct 2026): straight in S-Dnevnik inside the
# work space, not on the launcher. WHICH diary is this machine's own setting,
# because the local one and the cloud one are two browser copies of two
# databases: MTB_OPEN_URL in server\.env (ignored by Git; the cloud's address
# is not written in this repository) names the page to open instead. Without
# it the day opens on this machine's server.

param([hashtable] $Ctx)

$url = "$($Ctx.BaseUrl)/MTB-Workspace.html?app=S-Dnevnik.html"
$envFile = Join-Path $Ctx.RepoRoot 'server\.env'
if (Test-Path $envFile) {
    $line = Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*MTB_OPEN_URL\s*=' } | Select-Object -First 1
    if ($line) {
        $chosen = ($line -replace '^\s*MTB_OPEN_URL\s*=\s*', '').Trim().Trim('"')
        if ($chosen -match '^https?://\S+$') { $url = $chosen }
        elseif ($chosen) {
            return [pscustomobject]@{ Status = 'WARN'; Message = 'MTB_OPEN_URL во server\.env не е адреса (http/https) — ништо не е отворено' }
        }
    }
}
try {
    Start-Process $url | Out-Null
    return [pscustomobject]@{ Status = 'OK'; Message = $url }
} catch {
    return [pscustomobject]@{ Status = 'WARN'; Message = "не можев да го отворам прелистувачот — отвори рачно: $url" }
}
