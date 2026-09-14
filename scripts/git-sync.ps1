# Carry BOTH the code and the database between HOME and WORK through GitHub.
#
#   The public repository (Assisstant/MTB) carries code, migrations and tests.
#   A second, PRIVATE repository carries the PostgreSQL snapshots. It must stay
#   private: it holds the live database, with the children's real names in it.
#   Never make it public and never enable GitHub Pages on it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1
#       report only - both repositories, both snapshots. Changes nothing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Push
#       finishing work here: push committed code, export this database,
#       push the snapshot.
#
#   powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull
#       starting work here: pull both repositories, then report what the other
#       machine is offering. Writes nothing to the database.
#
#   powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull -Apply
#       the same, and then replace this database with the other machine's.
#
# This script is transport only. Every safety decision still belongs to
# manual-db-sync.ps1: the dump checksum, the database fingerprint, the exact
# migration list and the local pre-import dump taken before anything is
# replaced. Nothing here guesses which side is newer, and nothing here merges.
#
# The private clone's location comes from GIT_SYNC_DIR in server\.env, or
# defaults to a folder named MTB-data beside this repository. Set up once:
#
#   1. Create a PRIVATE repository on GitHub, e.g. Assisstant/MTB-data.
#   2. On each machine:  git clone https://github.com/Assisstant/MTB-data.git
#      next to the MTB folder (C:\Users\Admin\Documents\GitHub\MTB-data).
#   3. Nothing else. SYNC_NAME in server\.env already says home or work.
#
# See docs\GIT-DB-SYNC.md.

[CmdletBinding()]
param(
    [ValidateSet('Status', 'Push', 'Pull')]
    [string] $Mode = 'Status',
    [string] $DataDir,
    [string] $Me,
    [string] $PeerName,
    [switch] $Apply,
    [switch] $Force,
    [int]    $Keep = 2
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

function Get-EnvValue {
    param([string] $Name)

    $envFile = Join-Path $repoRoot 'server\.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $envFile)) {
        if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)$')) {
            return $Matches[1].Trim().Trim('"')
        }
    }
    return $null
}

# Always pass git arguments as an explicit array. PowerShell would otherwise try
# to bind a leading --word to a parameter of this function instead of to git.
#
# git writes routine progress to STDERR even on success ("Everything up-to-date",
# the "To https://..." push summary). Under the script's own $ErrorActionPreference
# = 'Stop', a bare `2>&1` on a native command turns each of those lines into a
# terminating ErrorRecord and throws before $LASTEXITCODE is ever read - the exact
# trap CLAUDE.md documents elsewhere in this project. Continue locally and judge
# success from the exit code, not from whether anything was written to stderr.
function Invoke-Git {
    param([string] $Root, [string[]] $GitArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $Root @GitArgs 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{
        Code   = $LASTEXITCODE
        Output = ($output | Out-String).Trim()
    }
}

function Assert-Git {
    param([object] $Result, [string] $What)

    if ($Result.Code -ne 0) {
        throw ("{0} failed:`n{1}" -f $What, $Result.Output)
    }
    return $Result.Output
}

function Get-CurrentSnapshot {
    param([string] $Machine)

    $path = Join-Path $script:dataFull ('manual-db-sync\' + $Machine + '\current.json')
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Show-Snapshot {
    param([string] $Label, [string] $Machine)

    $snap = Get-CurrentSnapshot -Machine $Machine
    if (-not $snap) {
        Write-Host ("  {0,-6} no snapshot published yet" -f $Label)
        return
    }
    Write-Host ("  {0,-6} {1}" -f $Label, $snap.snapshotId)
    Write-Host ("         created {0}   code {1}" -f $snap.createdAt, $snap.gitCommit)
}

# The snapshot folders are named <machine>-yyyy-MM-dd-HH-mm-ss-<hex>, so sorting
# by name is sorting by time. Old ones are dropped from the working tree to stop
# the private repository growing without bound; they stay in its git history,
# and the real backups are the local ones under backups\.
function Remove-OldSnapshots {
    param([string] $Machine, [int] $KeepCount)

    $dir = Join-Path $script:dataFull ('manual-db-sync\' + $Machine + '\snapshots')
    if (-not (Test-Path -LiteralPath $dir)) { return @() }

    $current = Get-CurrentSnapshot -Machine $Machine
    $keepSet = New-Object 'System.Collections.Generic.HashSet[string]'
    if ($current) { [void] $keepSet.Add([string] $current.snapshotId) }

    $all = @(Get-ChildItem -LiteralPath $dir -Directory | Sort-Object Name -Descending)
    foreach ($dirInfo in ($all | Select-Object -First $KeepCount)) {
        [void] $keepSet.Add($dirInfo.Name)
    }

    $removed = @()
    foreach ($dirInfo in $all) {
        if ($keepSet.Contains($dirInfo.Name)) { continue }
        Remove-Item -LiteralPath $dirInfo.FullName -Recurse -Force
        $removed += $dirInfo.Name
    }
    return $removed
}

# Safe to call anywhere: it only touches this clone's local git config. The
# `* -text` rule below is what actually protects the checksums, but a machine
# that has only ever pulled has never run Initialize-DataRepoFiles, so set this
# on both paths.
function Set-DataRepoConfig {
    Invoke-Git -Root $script:dataFull -GitArgs @('config', 'core.autocrlf', 'false') | Out-Null
}

# Written before the first `git add`, never after: a line-ending rewrite would
# change the bytes that manifest.json already recorded a SHA-256 for, and the
# other machine would report a corrupted snapshot instead of a converted one.
# Push only - creating untracked files before a pull invites a checkout clash.
function Initialize-DataRepoFiles {
    $attributes = Join-Path $script:dataFull '.gitattributes'
    if (-not (Test-Path -LiteralPath $attributes)) {
        $text = @(
            '# Every file here is verified against a SHA-256 recorded in manifest.json.',
            '# Git must return the exact bytes it was given: a line-ending conversion',
            '# would fail that checksum on the other machine and look like corruption.',
            '* -text'
        ) -join "`r`n"
        Set-Content -LiteralPath $attributes -Value $text -Encoding ASCII
    }

    $readme = Join-Path $script:dataFull 'README.md'
    if (-not (Test-Path -LiteralPath $readme)) {
        $text = @(
            '# MTB-data - PRIVATE',
            '',
            'PostgreSQL snapshots carried between the HOME and WORK machines by',
            '`scripts\git-sync.ps1` in the MTB repository.',
            '',
            'This repository holds the live database, including the children''s real',
            'names. It must stay private. Never make it public and never enable',
            'GitHub Pages on it.',
            '',
            'Nothing here is edited by hand.'
        ) -join "`r`n"
        Set-Content -LiteralPath $readme -Value $text -Encoding UTF8
    }
}

# "Create it as private" was written in this file's own header and in the data
# repository's README, and nothing ever checked it. On 14 Sep 2026 the repository
# was created PUBLIC and a full dump of the school's database - 178 pupils, their
# attendance, dossiers and assessments - was pushed to the open internet, where it
# stayed for four hours. A rule with nothing enforcing it is a wish; this project
# has now paid for that twice.
#
# Anonymous ON PURPOSE. The question is not "can I see it?" - the owner always
# can - but "can ANYONE see it?", and an authenticated request cannot tell those
# two apart. 200 means the world can read it. 404 means private, or absent, and
# a push to something absent fails on its own terms a moment later.
function Get-DataRepoVisibility {
    param([string] $RemoteUrl)

    if (-not ($RemoteUrl -match 'github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$')) {
        return [pscustomobject]@{ State = 'n/a'; Slug = $null }
    }
    $slug = '{0}/{1}' -f $Matches[1], $Matches[2]

    $status = 0
    try {
        $response = Invoke-WebRequest -Uri ('https://api.github.com/repos/' + $slug) `
            -Headers @{ 'User-Agent' = 'mtb-git-sync' } -UseBasicParsing -ErrorAction Stop
        $status = [int] $response.StatusCode
    } catch {
        if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
    }

    $state = switch ($status) {
        200     { 'public' }
        404     { 'private' }
        default { 'unknown' }
    }
    return [pscustomobject]@{ State = $state; Slug = $slug; Status = $status }
}

function Invoke-ManualSync {
    param([string[]] $Arguments)

    $script = Join-Path $PSScriptRoot 'manual-db-sync.ps1'

    # Do not let the nested `powershell.exe -File` child write straight to the
    # console. Measured: under a host that has no real console of its own -
    # any automation tool that starts this script with redirected/piped
    # stdio, which is how it is normally run - a grandchild process can fail
    # silently and immediately, before printing even its first line, the
    # moment it (or PowerShell itself) queries the console to write to it.
    # The parent process's own Write-Host calls work throughout this script
    # because the parent is one process closer to a real console; the
    # grandchild is not guaranteed to be. Redirecting the child's streams to
    # a file needs no console at all, so the parent reads the file back and
    # relays it with its own, working Write-Host.
    $logFile = [IO.Path]::Combine($env:TEMP, "mtb-git-sync-$([Guid]::NewGuid().ToString('N')).log")
    try {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script @Arguments *> $logFile
        $code = $LASTEXITCODE
        if (Test-Path -LiteralPath $logFile) {
            Get-Content -LiteralPath $logFile | ForEach-Object { Write-Host $_ }
        }
        return $code
    } finally {
        Remove-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
    }
}

# --------------------------------------------------------------------------
# resolve settings
# --------------------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git was not found on PATH.'
}

if (-not $Me) { $Me = Get-EnvValue 'MANUAL_SYNC_NAME' }
if (-not $Me) { $Me = Get-EnvValue 'SYNC_NAME' }
if (-not $Me) { throw 'This machine has no name. Pass -Me home or -Me work, or set SYNC_NAME in server\.env.' }
if (-not $PeerName) { $PeerName = if ($Me -eq 'work') { 'home' } else { 'work' } }
if ($Me -eq $PeerName) { throw 'This machine and its peer must have different names.' }

if (-not $DataDir) { $DataDir = Get-EnvValue 'GIT_SYNC_DIR' }
if (-not $DataDir) { $DataDir = Join-Path (Split-Path $repoRoot -Parent) 'MTB-data' }

if (-not (Test-Path -LiteralPath $DataDir)) {
    throw ("The private data clone is missing: {0}`nClone your PRIVATE data repository there first - see docs\GIT-DB-SYNC.md." -f $DataDir)
}
$dataFull = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')

# A dump written inside the public repository would be pushed to a public
# website. Refuse before anything is exported, not after.
$repoPrefix = [IO.Path]::GetFullPath($repoRoot).TrimEnd('\') + '\'
if ($dataFull.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    ($dataFull + '\') -eq $repoPrefix) {
    throw ("The data folder must not be inside the public MTB repository: {0}" -f $dataFull)
}
if (-not (Test-Path -LiteralPath (Join-Path $dataFull '.git'))) {
    throw ("{0} is not a git clone. Clone your PRIVATE data repository there - see docs\GIT-DB-SYNC.md." -f $dataFull)
}

$codeRemote = (Invoke-Git -Root $repoRoot -GitArgs @('remote', 'get-url', 'origin')).Output
$dataRemote = (Invoke-Git -Root $dataFull -GitArgs @('remote', 'get-url', 'origin')).Output
if ($dataRemote -and $codeRemote -and $dataRemote -eq $codeRemote) {
    throw 'The data clone points at the public code repository. It needs its own private repository.'
}

Write-Host ''
Write-Host '=== MTB GIT SYNC ===' -ForegroundColor Cyan
Write-Host ("  this machine: {0}      other machine: {1}" -f $Me, $PeerName)
Write-Host ("  code:         {0}" -f $repoRoot)
Write-Host ("  data (private): {0}" -f $dataFull)

$visibility = Get-DataRepoVisibility -RemoteUrl $dataRemote
switch ($visibility.State) {
    'private' { Write-Host ("  visibility:     {0} is private" -f $visibility.Slug) -ForegroundColor Green }
    'public'  { Write-Host ("  visibility:     {0} is PUBLIC" -f $visibility.Slug) -ForegroundColor Red }
    'unknown' { Write-Host ("  visibility:     could not be established for {0} (HTTP {1})" -f $visibility.Slug, $visibility.Status) -ForegroundColor Yellow }
    'n/a'     { Write-Host '  visibility:     not a github.com remote - not checked' -ForegroundColor Yellow }
}
Write-Host ''

# Reading is not what exposes anything - the data is already out there by the
# time this can tell - so Status and Pull say it loudly and carry on. Push is
# the one that would ADD to it, and it refuses. There is deliberately no switch
# to override a PUBLIC answer: the one place this script knows the most is not
# the place to offer a way past it.
if ($visibility.State -ne 'private') {
    Write-Host 'The repository that carries the database is not confirmed private.' -ForegroundColor Yellow
    if ($visibility.Slug) {
        Write-Host ("  https://github.com/{0}/settings  ->  Danger Zone  ->  Change visibility" -f $visibility.Slug) -ForegroundColor Yellow
    }
    Write-Host ''
}

# --------------------------------------------------------------------------
# Status
# --------------------------------------------------------------------------

if ($Mode -eq 'Status') {
    Invoke-Git -Root $repoRoot -GitArgs @('fetch', '--quiet', 'origin') | Out-Null
    Invoke-Git -Root $dataFull -GitArgs @('fetch', '--quiet', 'origin') | Out-Null

    $branch = (Invoke-Git -Root $repoRoot -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Output
    Write-Host ("code branch: {0}" -f $branch)

    $upstream = Invoke-Git -Root $repoRoot -GitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if ($upstream.Code -eq 0) {
        $counts = (Invoke-Git -Root $repoRoot -GitArgs @('rev-list', '--left-right', '--count', 'HEAD...@{u}')).Output
        $parts = @($counts -split '\s+')
        if ($parts.Count -ge 2) {
            Write-Host ("  {0} commit(s) to push, {1} to pull" -f $parts[0], $parts[1])
        }
    } else {
        Write-Host '  no upstream branch configured'
    }

    $dirty = (Invoke-Git -Root $repoRoot -GitArgs @('status', '--porcelain')).Output
    $trackedDirty = @($dirty -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith('??') })
    if ($trackedDirty.Count) {
        Write-Host ("  {0} uncommitted change(s) in tracked files" -f $trackedDirty.Count) -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host 'snapshots in the private repository:'
    Show-Snapshot -Label $Me -Machine $Me
    Show-Snapshot -Label $PeerName -Machine $PeerName
    Write-Host ''
    Write-Host 'Nothing was changed.' -ForegroundColor Green
    exit 0
}

# --------------------------------------------------------------------------
# Push - finishing work on this machine
# --------------------------------------------------------------------------

if ($Mode -eq 'Push') {
    # Before the dirty-tree check and long before the export, for the same reason
    # the inside-the-public-repo check sits where it does: the failure mode has to
    # be "refuses to start", never "published it and then complained".
    if ($visibility.State -eq 'public') {
        throw ("{0} is a PUBLIC repository, and this push would put the live database in it." -f $visibility.Slug)
    }
    if ($visibility.State -eq 'unknown') {
        throw ("Could not establish whether {0} is private (HTTP {1}), so nothing was exported or pushed.`nA push needs GitHub reachable anyway - check the connection and rerun." -f $visibility.Slug, $visibility.Status)
    }
    if ($visibility.State -eq 'n/a') {
        throw ("{0} is not a github.com remote, so this script cannot check whether it is readable by anyone.`nNothing was exported or pushed. Verify it by hand, or point the data clone at a private GitHub repository." -f $dataRemote)
    }

    $dirty = (Invoke-Git -Root $repoRoot -GitArgs @('status', '--porcelain')).Output
    $trackedDirty = @($dirty -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith('??') })
    if ($trackedDirty.Count -and -not $Force) {
        Write-Host 'Uncommitted changes in the code repository:' -ForegroundColor Yellow
        $trackedDirty | ForEach-Object { Write-Host ("  {0}" -f $_) }
        Write-Host ''
        Write-Host 'Commit them first, so the other machine gets the code that made this' -ForegroundColor Yellow
        Write-Host 'database. Rerun with -Force to push the database alone anyway.' -ForegroundColor Yellow
        exit 2
    }

    $branch = Assert-Git (Invoke-Git -Root $repoRoot -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')) 'Reading the code branch'
    Write-Host ("Pushing code ({0})..." -f $branch)
    Assert-Git (Invoke-Git -Root $repoRoot -GitArgs @('push', 'origin', $branch)) 'Pushing the code repository' | Out-Null

    # Take the other machine's snapshot first. Exporting on top of a stale clone
    # and then pushing is how one machine's published work gets stranded.
    # Check the exit code, not just the output: an unreachable remote also prints
    # something, and treating that as "there is a branch" would hide being offline.
    $lsRemote = Invoke-Git -Root $dataFull -GitArgs @('ls-remote', '--heads', 'origin', 'main')
    if ($lsRemote.Code -ne 0) {
        throw ("The private data repository could not be reached:`n{0}" -f $lsRemote.Output)
    }
    if ($lsRemote.Output) {
        Write-Host 'Pulling the private data repository...'
        Assert-Git (Invoke-Git -Root $dataFull -GitArgs @('pull', '--ff-only')) 'Pulling the private data repository' | Out-Null
    } else {
        Write-Host 'The private data repository is still empty; this push creates it.'
    }

    Set-DataRepoConfig
    Initialize-DataRepoFiles

    Write-Host ''
    Write-Host 'Exporting this database...' -ForegroundColor Cyan
    $code = Invoke-ManualSync -Arguments @('-Mode', 'Export', '-Dir', $dataFull, '-Me', $Me, '-PeerName', $PeerName)
    if ($code -ne 0) {
        throw 'The database export failed. Nothing was committed or pushed.'
    }

    $removed = Remove-OldSnapshots -Machine $Me -KeepCount $Keep
    if ($removed.Count) {
        Write-Host ("Dropped {0} older snapshot folder(s) from the working tree." -f $removed.Count)
    }

    Assert-Git (Invoke-Git -Root $dataFull -GitArgs @('add', '-A')) 'Staging the snapshot' | Out-Null
    $staged = (Invoke-Git -Root $dataFull -GitArgs @('diff', '--cached', '--name-only')).Output
    if (-not $staged) {
        Write-Host ''
        Write-Host 'The database is unchanged since the last push; nothing to send.' -ForegroundColor Green
        exit 0
    }

    $snapshot = Get-CurrentSnapshot -Machine $Me
    $codeSha = (Invoke-Git -Root $repoRoot -GitArgs @('rev-parse', '--short', 'HEAD')).Output
    $message = "db: $Me snapshot $($snapshot.snapshotId) (code $codeSha)"

    Assert-Git (Invoke-Git -Root $dataFull -GitArgs @('commit', '-m', $message)) 'Committing the snapshot' | Out-Null
    Write-Host 'Pushing the snapshot...'
    Assert-Git (Invoke-Git -Root $dataFull -GitArgs @('push', '-u', 'origin', 'HEAD:main')) 'Pushing the private data repository' | Out-Null

    Write-Host ''
    Write-Host 'Pushed.' -ForegroundColor Green
    Write-Host ("  code:     {0} at {1}" -f $branch, $codeSha)
    Write-Host ("  snapshot: {0}" -f $snapshot.snapshotId)
    Write-Host ''
    Write-Host ("On {0}, run:  powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull" -f $PeerName)
    exit 0
}

# --------------------------------------------------------------------------
# Pull - starting work on this machine
# --------------------------------------------------------------------------

if ($Mode -eq 'Pull') {
    # Code first, always. manual-db-sync.ps1 refuses to accept a snapshot whose
    # migration list does not match this working tree, and it is right to.
    Write-Host 'Pulling code...'
    $codePull = Invoke-Git -Root $repoRoot -GitArgs @('pull', '--ff-only')
    if ($codePull.Code -ne 0) {
        Write-Host $codePull.Output
        throw 'Pulling the code repository failed. Resolve that first; the database was not touched.'
    }
    Write-Host $codePull.Output

    Write-Host ''
    Write-Host 'Pulling the private data repository...'
    Set-DataRepoConfig
    $dataPull = Invoke-Git -Root $dataFull -GitArgs @('pull', '--ff-only')
    if ($dataPull.Code -ne 0) {
        Write-Host $dataPull.Output
        throw 'Pulling the private data repository failed. The database was not touched.'
    }

    $peer = Get-CurrentSnapshot -Machine $PeerName
    if (-not $peer) {
        Write-Host ''
        Write-Host ("The {0} machine has not published a snapshot yet. Code is up to date; the database was not touched." -f $PeerName) -ForegroundColor Yellow
        exit 0
    }

    Write-Host ''
    $code = Invoke-ManualSync -Arguments @('-Mode', 'Compare', '-Dir', $dataFull, '-Me', $Me, '-PeerName', $PeerName)
    if ($code -ne 0) {
        throw 'Compare failed. The database was not touched.'
    }

    if (-not $Apply) {
        Write-Host ''
        Write-Host 'Report only - the database was not touched.' -ForegroundColor Green
        Write-Host 'To replace this database with the one above, rerun with -Apply:'
        Write-Host ''
        Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull -Apply'
        exit 0
    }

    Write-Host ''
    Write-Host ("Accepting snapshot {0} from {1}..." -f $peer.snapshotId, $PeerName) -ForegroundColor Cyan
    $code = Invoke-ManualSync -Arguments @(
        '-Mode', 'Accept', '-Apply', '-Snapshot', [string] $peer.snapshotId,
        '-Dir', $dataFull, '-Me', $Me, '-PeerName', $PeerName
    )
    if ($code -ne 0) {
        throw 'Accepting the snapshot failed. Read the message above; the pre-import dump under backups\manual-sync\pre-import\ is the state before this ran.'
    }

    Write-Host ''
    Write-Host 'This machine now holds the other machine''s database.' -ForegroundColor Green
    Write-Host 'Open the apps through start.html and confirm the bar before editing.'
    exit 0
}
