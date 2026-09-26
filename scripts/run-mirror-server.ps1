# ============================================================================
# run-mirror-server.ps1 — a SECOND, read-only server over the cloud copy.
#
# The normal server (port 3000, run-server.ps1) keeps serving therapy_dev and
# stays writable: that is local mode, the fallback. This one serves the
# therapy_mirror database — the last copy pulled from Supabase — on its own
# port, so the cloud's data can be read without Internet. Which mode you are
# in is decided by the address you open; neither server replaces the other.
#
# Read-only twice over, because one guard that someone forgets is none:
#   - it connects as MTB_MIRROR_READER_DATABASE_URL, a role with SELECT only;
#   - MTB_MIRROR_MODE=readonly makes every connection transaction-read-only
#     and makes the API answer 423 to every write.
# The mirror's writer credential (MTB_MIRROR_TARGET_DATABASE_URL) and the pull
# key are deliberately NOT handed to this process.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\run-mirror-server.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\run-mirror-server.ps1 -Port 3002
# Stop it with Ctrl+C in its window.
# ============================================================================

param([int]$Port = 3001)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$serverDir = Join-Path $repoRoot 'server'
$envFile = Join-Path $serverDir '.env'
if (-not (Test-Path $envFile)) { throw "server\.env not found. The mirror server reads its settings from there." }

$settings = @{}
foreach ($line in Get-Content $envFile -Encoding UTF8) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
}

$reader = $settings['MTB_MIRROR_READER_DATABASE_URL']
if (-not $reader) {
    throw "MTB_MIRROR_READER_DATABASE_URL is not set in server\.env. It must name the SELECT-only role on the mirror database (docs\SUPABASE-MIRROR.md)."
}
$readerUri = [Uri]$reader
$database = $readerUri.AbsolutePath.TrimStart('/')
$user = [Uri]::UnescapeDataString($readerUri.UserInfo.Split(':')[0])
if ($database -notmatch '_mirror$') {
    throw "Refusing: the reader URL points at '$database'. The mirror server only ever serves a *_mirror database, never therapy_dev."
}
$writer = $settings['MTB_MIRROR_TARGET_DATABASE_URL']
if ($writer -and ([Uri]::UnescapeDataString(([Uri]$writer).UserInfo.Split(':')[0]) -eq $user)) {
    throw "Refusing: the reader URL uses '$user', the same role that WRITES the mirror. Use the SELECT-only reader role."
}
$normalPort = if ($settings['PORT']) { [int]$settings['PORT'] } else { 3000 }
if ($Port -eq $normalPort) {
    throw "Refusing: port $Port is the normal server's port. The mirror server runs beside it, not instead of it."
}

# dotenv never overrides a variable that is already set, so these win over
# server\.env for this process only. The placeholders keep the writer
# credential and the pull key out of this server's environment.
$env:DATABASE_URL = $reader
$env:PORT = "$Port"
$env:MTB_MIRROR_MODE = 'readonly'
$env:MTB_MIRROR_EXPORT = '0'
$env:MTB_MIRROR_TARGET_DATABASE_URL = 'not-used-by-the-mirror-server'
$env:MTB_MIRROR_PULL_KEY = 'not-used-by-the-mirror-server'
$role = $settings['SYNC_NAME']
if ($role) { $env:MTB_SERVER_ID = "$role-mirror" }
$place = switch ($role) { 'home' { 'ДОМА' } 'work' { 'РАБОТА' } default { 'СЕРВЕР' } }
$env:MTB_SERVER_LABEL = "$place · копија од облакот"

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = 'C:\Program Files\nodejs\npm.cmd' }

Write-Host "Read-only copy of the cloud: database '$database' as '$user'"
Write-Host "Open http://localhost:$Port/start.html  (the normal server stays on its own port)"
Set-Location $serverDir
& $npm run start
