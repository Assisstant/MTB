param([switch]$Apply)
# Credentials stay in this process; no .env or database data is rewritten.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$oldAdmin = $env:MTB_MIRROR_ADMIN_DATABASE_URL
try {
    if ($Apply) {
        $settings = @{}
        foreach ($line in Get-Content (Join-Path $repo 'server\.env') -Encoding UTF8) {
            if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim().Trim('"') }
        }
        $target = [Uri]$settings['MTB_MIRROR_READER_DATABASE_URL']
        if ($target.Host -notin @('localhost','127.0.0.1','[::1]') -or $target.AbsolutePath -notmatch '^/[a-z][a-z0-9_]*_mirror$') {
            throw 'Refusing a non-local or non-mirror target.'
        }
        Write-Host ('Create SELECT-only reader in ' + $target.AbsolutePath.TrimStart('/') + '. No changes to therapy_dev.')
        $secure = Read-Host 'Password for the local PostgreSQL postgres superuser (not your MTB login)' -AsSecureString
        $plain = [System.Net.NetworkCredential]::new('', $secure).Password
        $port = if ($target.Port -gt 0) { $target.Port } else { 5432 }
        $env:MTB_MIRROR_ADMIN_DATABASE_URL = 'postgresql://postgres:' + [Uri]::EscapeDataString($plain) + '@' + $target.Host + ':' + $port + $target.AbsolutePath
        $plain = $null
    }
    Push-Location (Join-Path $repo 'server')
    try {
        if ($Apply) { & npx.cmd tsx scripts/setup-mirror-reader.ts --apply }
        else { & npx.cmd tsx scripts/setup-mirror-reader.ts }
        if ($LASTEXITCODE -ne 0) { throw 'Reader setup did not finish. Nothing was activated; review the message above.' }
    } finally { Pop-Location }
} finally { $env:MTB_MIRROR_ADMIN_DATABASE_URL = $oldAdmin }
