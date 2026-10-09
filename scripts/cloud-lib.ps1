# cloud-lib.ps1 — where the cloud database is, for the scripts that go there.
#
# Dot-sourced by cloud-migrate.ps1, cloud-cleanup.ps1 and cloud-backup.ps1. Finding the address
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

function Get-MtbPostgresTools {
    $bin = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending | Select-Object -First 1
    if (-not $bin) { throw 'Не најдов pg_dump.exe под C:\Program Files\PostgreSQL.' }
    $env:PGCLIENTENCODING = 'UTF8'
    $env:PGCONNECT_TIMEOUT = '20'
    return [pscustomobject]@{
        PgDump    = $bin.FullName
        Psql      = Join-Path $bin.DirectoryName 'psql.exe'
        PgRestore = Join-Path $bin.DirectoryName 'pg_restore.exe'
    }
}

# What this computer last SAW in the cloud, for the Контролна табла's reminders:
# backups\cloud\state.json (gitignored with the rest of backups\). Numbers and
# dates only. The panel never asks the cloud itself — opening a window must not
# wait for the Internet — so the scripts that are there anyway leave a note.
# A note that cannot be written is not a reason for a backup or a cleanup to fail.
function Get-MtbCloudStateFile {
    param([string]$Repo)
    return (Join-Path $Repo 'backups\cloud\state.json')
}

function Set-MtbCloudState {
    param([string]$Repo, [hashtable]$Values)
    try {
        $file = Get-MtbCloudStateFile -Repo $Repo
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
        $state = @{}
        if (Test-Path -LiteralPath $file) {
            try {
                $before = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($p in $before.PSObject.Properties) { $state[$p.Name] = $p.Value }
            } catch { }
        }
        foreach ($k in $Values.Keys) { $state[$k] = $Values[$k] }
        Set-Content -LiteralPath $file -Value ($state | ConvertTo-Json) -Encoding UTF8
    } catch {
        Write-Host "  (белешката за контролната табла не е запишана: $($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

# This machine's own database, from server\.env — where an archive is restored to be checked.
function Get-MtbLocalUrl {
    param([string]$Repo)
    $serverEnv = Join-Path $Repo 'server\.env'
    if (-not (Test-Path $serverEnv)) { throw "Ја нема $serverEnv." }
    $line = Get-Content -LiteralPath $serverEnv -Encoding UTF8 | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
    if (-not $line) { throw "Во $serverEnv нема DATABASE_URL=..." }
    return ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"')
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
    # verify-full / verify-ca need Supabase's root certificate where libpq looks
    # for it. Without the file psql answers in English about root.crt, which
    # reads like a broken shortcut. The mode is NOT lowered here: whoever wrote
    # it into the file asked for the check, so the answer is the certificate.
    if ($url -match 'sslmode=verify-(full|ca)' -and $url -notmatch 'sslrootcert=') {
        $rootCert = Join-Path $env:APPDATA 'postgresql\root.crt'
        if (-not (Test-Path -LiteralPath $rootCert)) {
            throw ('Адресата во ' + $EnvFile + ' бара проверка на сертификатот на облакот (sslmode=verify-full), а сертификатот го нема на овој компјутер. ' +
                'Преземете го од Supabase: Project Settings, Database, SSL Configuration, Download certificate. ' +
                'Зачувајте го како ' + $rootCert + ' и пуштете ја кратенката пак. Ништо не е сменето.')
        }
    }

    $tools = Get-MtbPostgresTools
    return [pscustomobject]@{
        Url       = $url
        Host      = ($hostPart -replace '/.*$', '')
        EnvFile   = $EnvFile
        PgDump    = $tools.PgDump
        Psql      = $tools.Psql
        PgRestore = $tools.PgRestore
    }
}
