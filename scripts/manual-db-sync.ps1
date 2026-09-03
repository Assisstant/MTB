[CmdletBinding()]
param(
    [ValidateSet('Export', 'Compare', 'LegacyPreview', 'LegacyImport', 'Accept')]
    [string] $Mode = 'Compare',
    [string] $Dir,
    [string] $Me,
    [string] $PeerName,
    [ValidateSet('All', 'Rasporedi', 'SDnevnik')]
    [string] $Area = 'All',
    [string] $Snapshot,
    [int] $WaitSeconds = 30,
    [switch] $Apply,
    [switch] $SkipServerControl
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'db-handoff-lib.ps1')

function Resolve-ManualSettings {
    $envFile = Join-Path $repoRoot 'server\.env'
    if (-not $script:Dir) { $script:Dir = Get-HandoffEnvValue -EnvFile $envFile -Name 'MANUAL_SYNC_DIR' }
    if (-not $script:Dir) { $script:Dir = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_DIR' }
    if (-not $script:Dir) { $script:Dir = Get-HandoffEnvValue -EnvFile $envFile -Name 'SYNC_DIR' }
    if (-not $script:Me) { $script:Me = Get-HandoffEnvValue -EnvFile $envFile -Name 'MANUAL_SYNC_NAME' }
    if (-not $script:Me) { $script:Me = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_NAME' }
    if (-not $script:Me) { $script:Me = Get-HandoffEnvValue -EnvFile $envFile -Name 'SYNC_NAME' }
    if (-not $script:PeerName) { $script:PeerName = Get-HandoffEnvValue -EnvFile $envFile -Name 'MANUAL_SYNC_PEER' }
    if (-not $script:PeerName) { $script:PeerName = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_PEER_NAME' }
    if (-not $script:PeerName -and $script:Me) { $script:PeerName = if ($script:Me -eq 'work') { 'home' } else { 'work' } }

    if (-not $script:Dir) { throw 'Missing sync directory. Pass -Dir or set MANUAL_SYNC_DIR/SYNC_DIR in server\.env.' }
    if (-not $script:Me) { throw 'Missing machine name. Pass -Me or set MANUAL_SYNC_NAME/SYNC_NAME in server\.env.' }
    if (-not $script:PeerName) { throw 'Missing peer machine name. Pass -PeerName.' }
    if ($script:Me -eq $script:PeerName) { throw 'This machine and its peer must have different names.' }
    if ($script:Me -notmatch '^[A-Za-z0-9_-]+$' -or $script:PeerName -notmatch '^[A-Za-z0-9_-]+$') {
        throw 'Machine names may contain only letters, numbers, underscore and hyphen.'
    }
}

function Get-ManualPaths {
    param([string]$Machine)

    $root = Join-Path $Dir 'manual-db-sync'
    $machineDir = Join-Path $root $Machine
    return [pscustomobject]@{
        Root        = $root
        MachineDir  = $machineDir
        Snapshots   = Join-Path $machineDir 'snapshots'
        Current     = Join-Path $machineDir 'current.json'
    }
}

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)

    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childFull = [IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe snapshot path outside $Parent"
    }
    return $childFull
}

function Get-ManualSnapshot {
    param([string]$Machine)

    $paths = Get-ManualPaths -Machine $Machine
    $manifest = Read-HandoffJson -Path $paths.Current
    if (-not $manifest) { throw "No exported snapshot is available for '$Machine'." }
    if ($manifest.format -ne 'mtb-manual-db-sync-v1') { throw "Unsupported manual snapshot for '$Machine'." }
    if ($manifest.machine -ne $Machine) { throw "The '$Machine' manifest names another machine." }
    if ([string]$manifest.snapshotId -notmatch '^[A-Za-z0-9_.-]+$') { throw "Unsafe snapshot id for '$Machine'." }

    $snapshotDir = Assert-ChildPath -Parent $paths.Snapshots -Child (Join-Path $paths.Snapshots ([string]$manifest.snapshotId))
    $dumpName = [string]$manifest.dumpFile
    if ([IO.Path]::GetFileName($dumpName) -ne $dumpName) { throw "Unsafe dump filename for '$Machine'." }
    $dumpPath = Assert-ChildPath -Parent $snapshotDir -Child (Join-Path $snapshotDir $dumpName)
    if (-not (Test-Path -LiteralPath $dumpPath)) { throw "The '$Machine' dump has not arrived yet: $dumpPath" }
    if ((Get-FileSha256 -Path $dumpPath) -ne [string]$manifest.dumpSha256) { throw "The '$Machine' dump checksum does not match." }

    $json = @{}
    foreach ($entry in @($manifest.jsonFiles)) {
        $name = [string]$entry.file
        if ([IO.Path]::GetFileName($name) -ne $name) { throw "Unsafe JSON filename for '$Machine'." }
        $path = Assert-ChildPath -Parent $snapshotDir -Child (Join-Path $snapshotDir $name)
        if (-not (Test-Path -LiteralPath $path)) { throw "A JSON file has not arrived yet: $path" }
        if ((Get-FileSha256 -Path $path) -ne [string]$entry.sha256) { throw "JSON checksum does not match: $name" }
        $json[[string]$entry.kind] = $path
    }

    return [pscustomobject]@{
        Manifest    = $manifest
        Directory   = $snapshotDir
        DumpPath    = $dumpPath
        Json         = $json
        CurrentPath  = $paths.Current
    }
}

function Find-Npm {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm -and (Test-Path 'C:\Program Files\nodejs\npm.cmd')) { $npm = 'C:\Program Files\nodejs\npm.cmd' }
    if (-not $npm) { throw 'npm.cmd was not found.' }
    return $npm
}

function Invoke-LegacyExport {
    param([string]$OutputDirectory)

    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $npm = Find-Npm
    Push-Location (Join-Path $repoRoot 'server')
    try {
        & $npm run export --silent -- $OutputDirectory | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "Legacy JSON export failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }

    $rasporedi = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter 'UnifiedSync-from-postgres-*.json' -File)
    $sdnevnik = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter 'SDnevnik-from-postgres-*.json' -File)
    if ($rasporedi.Count -ne 1 -or $sdnevnik.Count -ne 1) { throw 'Legacy export did not produce exactly two JSON files.' }
    return [pscustomobject]@{ Rasporedi = $rasporedi[0].FullName; SDnevnik = $sdnevnik[0].FullName }
}

function Invoke-LegacyImport {
    param($Peer, [string]$SelectedArea, [switch]$Write)

    if (-not $Peer.Json.ContainsKey('Rasporedi') -or -not $Peer.Json.ContainsKey('SDnevnik')) {
        throw 'The peer snapshot does not contain both legacy JSON exports.'
    }

    $tempDir = $null
    $files = @()
    if ($SelectedArea -eq 'All') {
        $files = @($Peer.Json.Rasporedi, $Peer.Json.SDnevnik)
    } elseif ($SelectedArea -eq 'Rasporedi') {
        $files = @($Peer.Json.Rasporedi)
    } else {
        $tempDir = Join-Path $context.StateDir ('local-json-' + [guid]::NewGuid().ToString('N'))
        $localJson = Invoke-LegacyExport -OutputDirectory $tempDir
        $files = @($localJson.Rasporedi, $Peer.Json.SDnevnik)
    }

    try {
        $npm = Find-Npm
        $args = @('run', 'import', '--silent', '--') + $files
        if ($Write) { $args += '--apply' }
        Push-Location (Join-Path $repoRoot 'server')
        try {
            & $npm @args
            if ($LASTEXITCODE -ne 0) { throw "Legacy JSON import failed with exit code $LASTEXITCODE." }
        } finally { Pop-Location }
    } finally {
        if ($tempDir -and (Test-Path -LiteralPath $tempDir)) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    }
}

function Show-Comparison {
    param($Peer)

    $beforeHash = Get-DatabaseFingerprint -Context $context
    $localTables = @(Get-DatabaseTableSummary -Context $context)
    $localContentHash = Get-DatabaseContentFingerprint -TableSummary $localTables
    $localDatabaseHash = Get-DatabaseFingerprint -Context $context
    if ($beforeHash -ne $localDatabaseHash) {
        throw 'The local database changed during comparison. Nothing was changed; run Compare again.'
    }
    $peerTables = @($Peer.Manifest.tables)

    Write-Host ''
    Write-Host '=== MANUAL DATABASE COMPARISON ===' -ForegroundColor Cyan
    Write-Host ("local: {0}  live database {1}" -f $Me, $context.Db.Database)
    Write-Host ("peer:  {0}  snapshot {1}  {2}" -f $PeerName, $Peer.Manifest.snapshotId, $Peer.Manifest.createdAt)
    Write-Host ''

    $repoMigrations = @(Get-RepositoryMigrations -RepoRoot $repoRoot)
    $peerMigrations = @($Peer.Manifest.schemaMigrations)
    if (Test-ExactStringList -Left $repoMigrations -Right $peerMigrations) {
        Write-Host 'schema: identical' -ForegroundColor Green
    } else {
        Write-Host 'schema: DIFFERENT - git pull is required before any import' -ForegroundColor Red
    }

    $localByName = @{}
    foreach ($row in $localTables) { $localByName[[string]$row.table] = $row }
    $peerByName = @{}
    foreach ($row in $peerTables) { $peerByName[[string]$row.table] = $row }
    $names = @($localByName.Keys + $peerByName.Keys | Sort-Object -Unique)
    $different = @()
    foreach ($name in $names) {
        $local = $localByName[$name]
        $remote = $peerByName[$name]
        if (-not $local -or -not $remote -or [string]$local.hash -ne [string]$remote.hash) {
            $different += [pscustomobject]@{
                Table = $name
                Local = if ($local) { [int64]$local.rows } else { '-' }
                Peer  = if ($remote) { [int64]$remote.rows } else { '-' }
            }
        }
    }

    if (-not $different.Count -and $localContentHash -eq [string]$Peer.Manifest.contentHash) {
        Write-Host 'data: identical' -ForegroundColor Green
        if ($localDatabaseHash -ne [string]$Peer.Manifest.databaseHash) {
            Write-Host 'note: only internal sequence counters differ; table data is identical.' -ForegroundColor DarkGray
        }
    } else {
        Write-Host ("data: {0} table(s) differ" -f $different.Count) -ForegroundColor Yellow
        $different | Format-Table -AutoSize
    }

    Write-Host ("peer dump:       {0}" -f $Peer.DumpPath)
    Write-Host ("peer Rasporedi:  {0}" -f $Peer.Json.Rasporedi)
    Write-Host ("peer S-Dnevnik:  {0}" -f $Peer.Json.SDnevnik)
    Write-Host ''
    Write-Host 'Nothing was changed.' -ForegroundColor Green
}

function Export-Snapshot {
    $paths = Get-ManualPaths -Machine $Me
    New-Item -ItemType Directory -Force -Path $paths.Snapshots | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
    $snapshotId = '{0}-{1}-{2}' -f $Me, $stamp, ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $localTemp = Join-Path $context.StateDir ('outgoing-' + $snapshotId)
    $sharedPart = Join-Path $paths.Snapshots ($snapshotId + '.part')
    $sharedFinal = Join-Path $paths.Snapshots $snapshotId

    try {
        New-Item -ItemType Directory -Force -Path $localTemp | Out-Null
        $dumpPath = Join-Path $localTemp ($context.Db.Database + '.dump')
        $proof = New-VerifiedDatabaseDump -Context $context -Path $dumpPath
        $legacy = Invoke-LegacyExport -OutputDirectory $localTemp
        $tables = @(Get-DatabaseTableSummary -Context $context)
        if ((Get-DatabaseFingerprint -Context $context) -ne $proof.DatabaseHash) {
            throw 'The database changed during JSON export. No snapshot was published; try again after edits are quiet.'
        }

        $jsonFiles = @(
            [ordered]@{ kind = 'Rasporedi'; file = [IO.Path]::GetFileName($legacy.Rasporedi); sha256 = Get-FileSha256 -Path $legacy.Rasporedi },
            [ordered]@{ kind = 'SDnevnik'; file = [IO.Path]::GetFileName($legacy.SDnevnik); sha256 = Get-FileSha256 -Path $legacy.SDnevnik }
        )
        $manifest = [ordered]@{
            format           = 'mtb-manual-db-sync-v1'
            snapshotId       = $snapshotId
            machine          = $Me
            createdAt        = (Get-Date).ToUniversalTime().ToString('o')
            database         = $context.Db.Database
            databaseHash     = $proof.DatabaseHash
            contentHash      = Get-DatabaseContentFingerprint -TableSummary $tables
            dumpFile         = [IO.Path]::GetFileName($dumpPath)
            dumpSha256       = $proof.DumpSha256
            dumpBytes        = $proof.DumpBytes
            jsonFiles        = $jsonFiles
            tables           = @($tables)
            schemaMigrations = @(Get-DatabaseMigrations -Context $context)
            gitCommit        = (& git -C $repoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
        }

        if (Test-Path -LiteralPath $sharedPart) { Remove-Item -LiteralPath $sharedPart -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $sharedPart | Out-Null
        Copy-Item -LiteralPath $dumpPath -Destination (Join-Path $sharedPart $manifest.dumpFile) -Force
        foreach ($entry in $jsonFiles) {
            Copy-Item -LiteralPath (Join-Path $localTemp $entry.file) -Destination (Join-Path $sharedPart $entry.file) -Force
        }
        if ((Get-FileSha256 -Path (Join-Path $sharedPart $manifest.dumpFile)) -ne $manifest.dumpSha256) {
            throw 'The pCloud dump copy failed checksum verification.'
        }
        foreach ($entry in $jsonFiles) {
            if ((Get-FileSha256 -Path (Join-Path $sharedPart $entry.file)) -ne $entry.sha256) {
                throw "The pCloud JSON copy failed checksum verification: $($entry.file)"
            }
        }
        Write-HandoffJsonAtomic -Path (Join-Path $sharedPart 'manifest.json') -Value $manifest
        Move-Item -LiteralPath $sharedPart -Destination $sharedFinal
        Write-HandoffJsonAtomic -Path $paths.Current -Value $manifest

        Write-Host ''
        Write-Host 'Snapshot exported.' -ForegroundColor Green
        Write-Host "  machine:  $Me"
        Write-Host "  snapshot: $snapshotId"
        Write-Host "  folder:   $sharedFinal"
        Write-Host 'The other database was not contacted or changed.'
    } finally {
        if (Test-Path -LiteralPath $localTemp) { Remove-Item -LiteralPath $localTemp -Recurse -Force }
        if (Test-Path -LiteralPath $sharedPart) { Remove-Item -LiteralPath $sharedPart -Recurse -Force }
    }
}

Resolve-ManualSettings
if (-not (Wait-HandoffDirectory -Directory $Dir -WaitSeconds $WaitSeconds -CreateIfMissing:($Mode -eq 'Export'))) {
    throw "pCloud directory is unavailable: $Dir"
}

$context = New-HandoffContext -RepoRoot $repoRoot -StateDir (Join-Path $repoRoot 'backups\manual-sync')
$lockPath = Join-Path $context.StateDir 'manual-db-sync.lock'
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'Another manual database sync operation is already running.' }

try {
    if ($Mode -eq 'Export') {
        Export-Snapshot
        exit 0
    }

    $peer = Get-ManualSnapshot -Machine $PeerName
    if ($peer.Manifest.database -ne $context.Db.Database) {
        throw "Peer snapshot is for database '$($peer.Manifest.database)', not '$($context.Db.Database)'."
    }

    if ($Mode -eq 'Compare') {
        Show-Comparison -Peer $peer
        exit 0
    }

    if ($Mode -eq 'LegacyPreview') {
        Write-Host "Previewing $Area from $PeerName snapshot $($peer.Manifest.snapshotId)." -ForegroundColor Cyan
        Invoke-LegacyImport -Peer $peer -SelectedArea $Area
        exit 0
    }

    if (-not $Snapshot) {
        Write-Host "Peer snapshot: $($peer.Manifest.snapshotId)  $($peer.Manifest.createdAt)" -ForegroundColor Yellow
        $Snapshot = Read-Host 'Type the exact snapshot id to continue'
    }
    if ($Snapshot -cne [string]$peer.Manifest.snapshotId) {
        throw 'Snapshot id does not match the current peer snapshot. Nothing was changed.'
    }
    if (-not $Apply) {
        Write-Host 'Dry run only. Add -Apply after reviewing Compare/LegacyPreview.' -ForegroundColor Yellow
        exit 0
    }

    $repoMigrations = @(Get-RepositoryMigrations -RepoRoot $repoRoot)
    if (-not (Test-ExactStringList -Left $repoMigrations -Right @($peer.Manifest.schemaMigrations))) {
        throw 'Repository migrations do not match the peer snapshot. Run git pull before importing.'
    }

    $wasRunning = $false
    if (-not $SkipServerControl) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 3
            $wasRunning = [bool]$health.ok
        } catch { $wasRunning = $false }
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'server-control.ps1') stop
    }

    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
        $safetyPath = Join-Path (Join-Path $context.StateDir 'pre-import') ("$($context.Db.Database)-$Me-$stamp.dump")
        $localHash = Get-DatabaseFingerprint -Context $context
        $safety = New-VerifiedDatabaseDump -Context $context -Path $safetyPath

        if ($Mode -eq 'LegacyImport') {
            Invoke-LegacyImport -Peer $peer -SelectedArea $Area -Write
        } elseif ($Mode -eq 'Accept') {
            try {
                Restore-DatabaseDump -Context $context -DumpPath $peer.DumpPath
                $restoredHash = Get-DatabaseFingerprint -Context $context
                if ($restoredHash -ne [string]$peer.Manifest.databaseHash) { throw 'Restored database fingerprint does not match the peer snapshot.' }
            } catch {
                $restoreError = $_.Exception.Message
                try {
                    Restore-DatabaseDump -Context $context -DumpPath $safetyPath
                    if ((Get-DatabaseFingerprint -Context $context) -ne $localHash) { throw 'Safety rollback fingerprint does not match.' }
                } catch {
                    throw "Peer restore failed ($restoreError); safety rollback also failed ($($_.Exception.Message)). Backup: $safetyPath"
                }
                throw "Peer restore failed and the local database was restored: $restoreError"
            }
        } else {
            throw "Unsupported mode: $Mode"
        }
    } finally {
        if ($wasRunning -and -not $SkipServerControl) {
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'server-control.ps1') start
        }
    }

    Write-Host ''
    if ($Mode -eq 'LegacyImport') {
        Write-Host "Legacy JSON area '$Area' imported from $Snapshot." -ForegroundColor Green
        Write-Host "Safety backup: $safetyPath"
    } else {
        Write-Host "Accepted complete snapshot $Snapshot from $PeerName." -ForegroundColor Green
        Write-Host "Previous local database: $safetyPath"
    }
} finally {
    if ($lock) { $lock.Dispose() }
}
