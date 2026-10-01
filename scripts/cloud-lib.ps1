# cloud-lib.ps1 — where the cloud database is, for the scripts that go there.
#
# Dot-sourced by cloud-migrate.ps1 and cloud-cleanup.ps1. Finding the address
# is ONE decision with an order in it (the file in the repo, the older one
# beside it, the copy the other PC left in pCloud) and one guard (the file must
# be gitignored, or the password goes to GitHub). A second copy of that in a
# second script is how the two would come to disagree.
#
# Nothing here writes to the database. Every function throws with a sentence
# meant for the person; the caller decides how to show it.

function Get-MtbCloudEnvFile {
    param([string]$Repo, [string]$EnvFile = '')

    if (-not $EnvFile) {
        $EnvFile = @((Join-Path $Repo 'cloud.env'), (Join-Path (Split-Path -Parent $Repo) 'MTB-cloude.env')) |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        # Neither is here: the other machine may have left the file in the pCloud
        # folder the two PCs already share (P:\MTB-sync, or SYNC_DIR in server\.env).
        # It is copied beside the repo once, so the next run needs no pCloud.
        if (-not $EnvFile) {
            $shared = 'P:\MTB-sync'
            $serverEnv = Join-Path $Repo 'server\.env'
            if (Test-Path $serverEnv) {
                $dirLine = Get-Content -LiteralPath $serverEnv -Encoding UTF8 | Where-Object { $_ -match '^\s*SYNC_DIR\s*=' } | Select-Object -First 1
                if ($dirLine) { $shared = ($dirLine -replace '^\s*SYNC_DIR\s*=\s*', '').Trim().Trim('"') }
            }
            $left = Join-Path $shared 'MTB-cloude.env'
            if (Test-Path -LiteralPath $left) {
                $EnvFile = Join-Path (Split-Path -Parent $Repo) 'MTB-cloude.env'
                Copy-Item -LiteralPath $left -Destination $EnvFile
                Write-Host "  (адресата на облакот е преземена од $left)" -ForegroundColor Yellow
            }
        }
        if (-not $EnvFile) { $EnvFile = Join-Path $Repo 'cloud.env' }
    }
    if ((Split-Path -Parent $EnvFile) -eq $Repo) {
        Push-Location $Repo
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & git check-ignore -q -- (Split-Path -Leaf $EnvFile) 2>$null
        $ignored = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $previous
        Pop-Location
        if (-not $ignored) { throw "$EnvFile НЕ е во .gitignore — со лозинката би отишол на GitHub. Прво git pull (новиот .gitignore)." }
    }
    return $EnvFile
}

# The address, checked to be the cloud and nothing else, and the tools.
function Get-MtbCloud {
    param([string]$Repo, [string]$EnvFile = '')

    $EnvFile = Get-MtbCloudEnvFile -Repo $Repo -EnvFile $EnvFile
    if (-not (Test-Path $EnvFile)) { throw "Ја нема $EnvFile — направете ја со еден ред: DATABASE_URL=postgresql://... (Supabase → Connect → Session pooler)." }
    $line = Get-Content -LiteralPath $EnvFile -Encoding UTF8 | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
    if (-not $line) { throw "Во $EnvFile нема DATABASE_URL=..." }
    $url = ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"')
    if ($url -notmatch '^(postgres(?:ql)?://[^@/]+@)(.+)$') { throw 'DATABASE_URL не изгледа како postgresql://корисник:лозинка@хост:порта/база.' }
    $userPart = $Matches[1]
    $hostPart = $Matches[2]
    # Датотеката на двете машини е пресечена по „aws-0-eu-central" (26 Sep).
    # Дополни ја со познатиот session pooler, наместо да падне.
    if ($hostPart -eq 'aws-0-eu-central') {
        $hostPart = 'aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
        Write-Host "  (адресата во $EnvFile е пресечена — дополнета со session pooler aws-0-eu-central-1:5432)" -ForegroundColor Yellow
    }
    if ($hostPart -notmatch '^[^/]+\.[^/]+(:\d+)?/\w+') { throw "Хостот во DATABASE_URL е нецелосен: $hostPart" }
    if ($hostPart -notmatch 'supabase\.(com|co)') { throw "Ова не е базата во облакот (Supabase): $hostPart. Локалната база се ажурира со кратенката MTB - Azuriraj." }
    $url = $userPart + $hostPart
    if ($url -notmatch 'sslmode=') { $url += $(if ($url.Contains('?')) { '&' } else { '?' }) + 'sslmode=require' }

    $bin = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending | Select-Object -First 1
    if (-not $bin) { throw 'Не најдов pg_dump.exe под C:\Program Files\PostgreSQL.' }
    $env:PGCLIENTENCODING = 'UTF8'
    $env:PGCONNECT_TIMEOUT = '20'

    return [pscustomobject]@{
        Url       = $url
        Host      = ($hostPart -replace '/.*$', '')
        EnvFile   = $EnvFile
        PgDump    = $bin.FullName
        Psql      = Join-Path $bin.DirectoryName 'psql.exe'
        PgRestore = Join-Path $bin.DirectoryName 'pg_restore.exe'
    }
}
