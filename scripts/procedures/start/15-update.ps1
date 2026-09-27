# Every procedure in this folder takes the same context and returns one result.
# It writes nothing to the host: the runner prints one line per procedure so the
# report reads the same whoever wrote the step.
#
#   param([hashtable] $Ctx)
#   [pscustomobject]@{ Status = 'OK' | 'WARN' | 'FAIL'; Message = '...'; Fix = '...' }
#
# Order comes from the filename. Adding a step is a new numbered file; nothing
# in mtb.ps1 changes.

# What a pull leaves undone (owner, 28 Sep 2026: "auto update … pulls and
# migrations"). 10-repo brings the code; this makes the installation match it:
#
#   1. packages, when package-lock.json is newer than what is installed;
#   2. migrations the database has not had — but ONLY after a fresh database
#      backup. No backup, no migration: a FAIL here stops the day before the
#      apps open on a half-upgraded database, and says why;
#   3. a restart of a server that is already running, when the code or the
#      schema changed — `server-control start` leaves a running server alone,
#      so without this the old code would keep answering after a pull.
#
# Output of the child commands goes to backups\update.log, never to the
# console: a nested powershell.exe writing to a console it does not have is
# the trap CLAUDE.md records (git-sync.ps1 → manual-db-sync.ps1).

param([hashtable] $Ctx)

$server  = Join-Path $Ctx.RepoRoot 'server'
$envFile = Join-Path $server '.env'
$log     = Join-Path $Ctx.RepoRoot 'backups\update.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Add-Content -Path $log -Value ("`r`n==== " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ====') -Encoding UTF8

$line = if (Test-Path $envFile) { Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1 }
if (-not $line) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'нема DATABASE_URL во server\.env — миграциите не се проверени' }
}
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
    return [pscustomobject]@{ Status = 'WARN'; Message = 'npm не е најден — пакетите и миграциите не се проверени' }
}

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'          # native stderr must not throw (CLAUDE.md)
$env:DATABASE_URL = $line.Substring('DATABASE_URL='.Length)
$env:PGCLIENTENCODING = 'UTF8'
$done = @()
try {
    Push-Location $server

    # 1. packages
    $lock = Join-Path $server 'package-lock.json'
    $installed = Join-Path $server 'node_modules\.package-lock.json'
    if (-not (Test-Path $installed) -or (Get-Item $lock).LastWriteTime -gt (Get-Item $installed).LastWriteTime) {
        & $npm install --no-audit --no-fund *>> $log
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Status = 'FAIL'; Message = 'пакетите не се инсталираа (npm install)'; Fix = 'backups\update.log' }
        }
        $done += 'пакетите освежени'
    }

    # 2. migrations, backup first
    $answer = @(& $npm run -s migrate:pending 2>> $log) | Where-Object { $_ -match '^\{"pending"' } | Select-Object -Last 1
    if (-not $answer) {
        return [pscustomobject]@{ Status = 'FAIL'; Message = 'не можам да прочитам кои миграции чекаат — базата не одговара?'; Fix = 'backups\update.log' }
    }
    $pending = @(($answer | ConvertFrom-Json).pending)
    $applied = $false
    if ($pending.Count) {
        $backup = Join-Path $Ctx.Scripts 'backup-db.ps1'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $backup -SkipJson *>> $log
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                Status  = 'FAIL'
                Message = "бекапот не успеа — $($pending.Count) миграции НЕ се применети"
                Fix     = 'backups\update.log; бекап рачно: scripts\backup-db.ps1'
            }
        }
        & $npm run -s migrate *>> $log
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                Status  = 'FAIL'
                Message = 'миграцијата не успеа — базата е како пред неа (секоја миграција е една трансакција)'
                Fix     = 'backups\update.log; бекапот од пред тоа е во backups\db'
            }
        }
        $applied = $true
        $done += "применети $($pending.Count) миграции ($($pending[-1] -replace '\.sql$','')), бекап пред тоа"
    }

    # 3. a running server gets the new code
    if ($Ctx.CodeChanged -or $applied) {
        $running = $false
        try { $running = [bool](Invoke-RestMethod -Uri "$($Ctx.BaseUrl)/api/health" -TimeoutSec 3).ok } catch { }
        if ($running) {
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Ctx.Scripts 'server-control.ps1') restart -Port $Ctx.Port *>> $log
            $done += 'серверот рестартиран на новиот код'
        }
    }
} finally {
    Pop-Location
    $ErrorActionPreference = $previous
}

if (-not $done.Count) { return [pscustomobject]@{ Status = 'OK'; Message = 'базата е во тек — нема миграции што чекаат' } }
return [pscustomobject]@{ Status = 'OK'; Message = ($done -join '; ') }
