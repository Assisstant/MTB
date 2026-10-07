param([switch]$Apply, [switch]$Views)
# Credentials stay in this process; no .env or database data is rewritten.
# -Views: an EXISTING reader gets SELECT on the business views it cannot read
# yet (schedule_conflicts, teaching_clashes). The account itself is untouched.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$oldAdmin = $env:MTB_MIRROR_ADMIN_DATABASE_URL
# Out-Host keeps the tool's lines out of the return value, which is its exit code.
function Invoke-ReaderSetup([string[]]$Flags) {
    Push-Location (Join-Path $repo 'server')
    try {
        & npx.cmd tsx scripts/setup-mirror-reader.ts @Flags | Out-Host
        return $LASTEXITCODE
    } finally { Pop-Location }
}
try {
    $flags = @()
    if ($Views) { $flags += '--views' }
    if (-not $Apply) {
        if ((Invoke-ReaderSetup $flags) -ne 0) { throw 'Reader check did not finish; review the message above.' }
        return
    }
    if ($Views) {
        # The mirror's own sync role can grant on views it owns: no password needed then.
        # Exit 3 means the views belong to another role, and only then is postgres asked for.
        $env:MTB_MIRROR_ADMIN_DATABASE_URL = $null
        $code = Invoke-ReaderSetup ($flags + '--apply')
        if ($code -eq 0) { return }
        if ($code -ne 3) { throw 'Reader setup did not finish. Nothing was changed; review the message above.' }
    }
    $settings = @{}
    foreach ($line in Get-Content (Join-Path $repo 'server\.env') -Encoding UTF8) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim().Trim('"') }
    }
    $target = [Uri]$settings['MTB_MIRROR_READER_DATABASE_URL']
    if ($target.Host -notin @('localhost','127.0.0.1','[::1]') -or $target.AbsolutePath -notmatch '^/[a-z][a-z0-9_]*_mirror$') {
        throw 'Refusing a non-local or non-mirror target.'
    }
    $what = if ($Views) { 'Grant the existing reader SELECT on the business views in ' } else { 'Create SELECT-only reader in ' }
    Write-Host ($what + $target.AbsolutePath.TrimStart('/') + '. No changes to therapy_dev.')
    $secure = Read-Host 'Password for the local PostgreSQL postgres superuser (not your MTB login)' -AsSecureString
    $plain = [System.Net.NetworkCredential]::new('', $secure).Password
    $port = if ($target.Port -gt 0) { $target.Port } else { 5432 }
    $env:MTB_MIRROR_ADMIN_DATABASE_URL = 'postgresql://postgres:' + [Uri]::EscapeDataString($plain) + '@' + $target.Host + ':' + $port + $target.AbsolutePath
    $plain = $null
    if ((Invoke-ReaderSetup ($flags + '--apply')) -ne 0) { throw 'Reader setup did not finish. Nothing was activated; review the message above.' }
} finally { $env:MTB_MIRROR_ADMIN_DATABASE_URL = $oldAdmin }
