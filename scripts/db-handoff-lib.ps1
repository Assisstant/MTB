# Shared helpers for the full PostgreSQL handoff between ZenPC and ZenPC1.
# This file has no top-level side effects so the decision logic can be tested.

Set-StrictMode -Version 2.0

function Get-HandoffEnvValue {
    param([string]$EnvFile, [string]$Name)

    if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
    if (-not $line) { return $null }
    return $line.Substring($Name.Length + 1).Trim()
}

function Get-DatabaseSettings {
    param([string]$RepoRoot)

    $envFile = Join-Path $RepoRoot 'server\.env'
    $databaseUrl = $env:DATABASE_URL
    if (-not $databaseUrl) { $databaseUrl = Get-HandoffEnvValue -EnvFile $envFile -Name 'DATABASE_URL' }
    if (-not $databaseUrl) { throw 'DATABASE_URL is missing from server\.env.' }

    try { $uri = [Uri]$databaseUrl }
    catch { throw 'DATABASE_URL is not a valid PostgreSQL URL.' }

    $userInfo = $uri.UserInfo.Split(':', 2)
    if ($userInfo.Count -lt 2) { throw 'DATABASE_URL must include a user and password.' }

    $port = $uri.Port
    if ($port -lt 1) { $port = 5432 }
    $database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    if (-not $database) { throw 'DATABASE_URL does not name a database.' }

    return [pscustomobject]@{
        User     = [Uri]::UnescapeDataString($userInfo[0])
        Password = [Uri]::UnescapeDataString($userInfo[1])
        Host     = $uri.Host
        Port     = $port
        Database = $database
    }
}

function Find-PostgresTool {
    param([string]$Name)

    $tool = Get-ChildItem ("C:\Program Files\PostgreSQL\*\bin\{0}.exe" -f $Name) -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $tool) {
        $command = Get-Command ($Name + '.exe') -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Command $Name -ErrorAction SilentlyContinue }
        if ($command) { $tool = $command.Source }
    }
    if (-not $tool) { throw ("{0}.exe was not found." -f $Name) }
    return $tool
}

function New-HandoffContext {
    param([string]$RepoRoot, [string]$StateDir)

    if (-not $StateDir) { $StateDir = Join-Path $RepoRoot 'backups\handoff' }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

    return [pscustomobject]@{
        RepoRoot  = $RepoRoot
        StateDir  = $StateDir
        StateFile = Join-Path $StateDir 'state.json'
        LogFile   = Join-Path (Split-Path $StateDir -Parent) 'db-handoff.log'
        Db        = Get-DatabaseSettings -RepoRoot $RepoRoot
        Psql      = Find-PostgresTool -Name 'psql'
        PgDump    = Find-PostgresTool -Name 'pg_dump'
        PgRestore = Find-PostgresTool -Name 'pg_restore'
    }
}

function Write-HandoffLog {
    param($Context, [string]$Level, [string]$Message, [switch]$Quiet)

    $line = '{0}  {1,-7} {2}' -f (Get-Date -Format 's'), $Level.ToUpperInvariant(), $Message
    New-Item -ItemType Directory -Force -Path (Split-Path $Context.LogFile -Parent) | Out-Null
    Add-Content -LiteralPath $Context.LogFile -Value $line
    if (-not $Quiet -or $Level -notin @('ok', 'info')) { Write-Host $line }
}

function Invoke-PostgresTool {
    param($Context, [string]$Tool, [string[]]$Arguments, [switch]$Capture)

    $oldPassword = $env:PGPASSWORD
    try {
        $env:PGPASSWORD = $Context.Db.Password
        if ($Capture) {
            $output = & $Tool @Arguments 2>&1
            $code = $LASTEXITCODE
            if ($code -ne 0) { throw (($output | Out-String).Trim()) }
            return @($output | ForEach-Object { [string]$_ })
        }
        & $Tool @Arguments
        if ($LASTEXITCODE -ne 0) { throw ("{0} failed with exit code {1}." -f (Split-Path $Tool -Leaf), $LASTEXITCODE) }
    } finally {
        if ($null -eq $oldPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
        else { $env:PGPASSWORD = $oldPassword }
    }
}

function Invoke-HandoffPsql {
    param($Context, [string]$Sql)

    $args = @(
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', $Context.Db.User, '-h', $Context.Db.Host, '-p', [string]$Context.Db.Port,
        '-d', $Context.Db.Database, '-c', $Sql
    )
    return @(Invoke-PostgresTool -Context $Context -Tool $Context.Psql -Arguments $args -Capture)
}

function Get-TextSha256 {
    param([string]$Text)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Quote-PgIdentifier {
    param([string]$Value)
    return '"' + $Value.Replace('"', '""') + '"'
}

function Get-DatabaseFingerprint {
    param($Context)

    # sync_watermark belongs to the retired document transport, not to the
    # clinical database. Including it would make two identical databases look
    # different merely because one acknowledged an old peer first.
    $tables = Invoke-HandoffPsql -Context $Context -Sql @"
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> 'sync_watermark'
ORDER BY table_name;
"@

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($table in $tables) {
        if (-not $table) { continue }
        $quoted = Quote-PgIdentifier $table
        $sql = "SELECT count(*)::text || ':' || coalesce(md5(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text), md5('[]')) FROM public.$quoted AS t;"
        $value = (Invoke-HandoffPsql -Context $Context -Sql $sql | Select-Object -First 1)
        $parts.Add(('table:{0}:{1}' -f $table, $value))
    }

    $sequences = Invoke-HandoffPsql -Context $Context -Sql @"
SELECT sequence_name
FROM information_schema.sequences
WHERE sequence_schema = 'public'
ORDER BY sequence_name;
"@
    foreach ($sequence in $sequences) {
        if (-not $sequence) { continue }
        $quoted = Quote-PgIdentifier $sequence
        $value = (Invoke-HandoffPsql -Context $Context -Sql "SELECT last_value::text || ':' || is_called::text FROM public.$quoted;" | Select-Object -First 1)
        $parts.Add(('sequence:{0}:{1}' -f $sequence, $value))
    }

    return Get-TextSha256 -Text ($parts -join "`n")
}

function Get-DatabaseTableSummary {
    param($Context)

    $tables = Invoke-HandoffPsql -Context $Context -Sql @"
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> 'sync_watermark'
ORDER BY table_name;
"@

    $summary = @()
    foreach ($table in $tables) {
        if (-not $table) { continue }
        $quoted = Quote-PgIdentifier $table
        $sql = "SELECT count(*)::text || '|' || coalesce(md5(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text), md5('[]')) FROM public.$quoted AS t;"
        $value = [string](Invoke-HandoffPsql -Context $Context -Sql $sql | Select-Object -First 1)
        $pieces = $value.Split('|', 2)
        $summary += [pscustomobject]@{
            table = [string]$table
            rows  = [int64]$pieces[0]
            hash  = [string]$pieces[1]
        }
    }
    return @($summary)
}

function Get-DatabaseContentFingerprint {
    param([object[]]$TableSummary)

    $parts = @($TableSummary | Sort-Object table | ForEach-Object {
        '{0}:{1}:{2}' -f $_.table, $_.rows, $_.hash
    })
    return Get-TextSha256 -Text ($parts -join "`n")
}

function Get-DatabaseMigrations {
    param($Context)

    try {
        return @(Invoke-HandoffPsql -Context $Context -Sql 'SELECT filename FROM schema_migrations ORDER BY filename;')
    } catch {
        throw 'The database has no readable schema_migrations table.'
    }
}

function Get-RepositoryMigrations {
    param([string]$RepoRoot)
    return @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'database\migrations') -Filter '*.sql' -File |
        Sort-Object Name | Select-Object -ExpandProperty Name)
}

function Test-ExactStringList {
    param([object[]]$Left, [object[]]$Right)
    return (($Left -join "`n") -ceq ($Right -join "`n"))
}

function Read-HandoffJson {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
    catch { throw ("Unreadable handoff JSON: {0}" -f $Path) }
}

function Write-HandoffJsonAtomic {
    param([string]$Path, $Value)

    $parent = Split-Path $Path -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $part = $Path + '.part'
    $json = $Value | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($part, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $part -Destination $Path -Force
}

function Get-HandoffBootId {
    try {
        $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
        return ([DateTime]$boot).ToUniversalTime().ToString('o')
    } catch {
        # Fallback is intentionally coarse. It is only a guard against the
        # publisher racing ahead of this boot's startup pull.
        return ('fallback-' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))
    }
}

function Get-HandoffState {
    param($Context)
    return Read-HandoffJson -Path $Context.StateFile
}

function Save-HandoffState {
    param($Context, [string]$Machine, [string]$Lineage, [int64]$Generation, [string]$DatabaseHash, [switch]$StartupComplete)

    $old = Get-HandoffState -Context $Context
    $bootId = if ($StartupComplete) { Get-HandoffBootId } elseif ($old) { $old.startupBootId } else { $null }
    $state = [ordered]@{
        format          = 'mtb-db-handoff-state-v1'
        machine         = $Machine
        lineage         = $Lineage
        generation      = $Generation
        databaseHash    = $DatabaseHash
        updatedAt       = (Get-Date).ToUniversalTime().ToString('o')
        startupBootId   = $bootId
    }
    Write-HandoffJsonAtomic -Path $Context.StateFile -Value $state
    return [pscustomobject]$state
}

function Test-HandoffStartupComplete {
    param($Context)
    $state = Get-HandoffState -Context $Context
    return ($state -and $state.startupBootId -eq (Get-HandoffBootId))
}

function Start-PcloudIfNeeded {
    param([string]$Directory)

    $root = [IO.Path]::GetPathRoot($Directory)
    if ($root -and (Test-Path -LiteralPath $root)) { return }
    try {
        $key = Get-ItemProperty -Path 'HKCU:\Software\pCloud' -ErrorAction Stop
        if ($key.AppPath -and (Test-Path -LiteralPath $key.AppPath)) {
            Start-Process -FilePath $key.AppPath -WindowStyle Hidden
        }
    } catch { }
}

function Wait-HandoffDirectory {
    param([string]$Directory, [int]$WaitSeconds, [switch]$CreateIfMissing)

    Start-PcloudIfNeeded -Directory $Directory
    $deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
    do {
        if (Test-Path -LiteralPath $Directory) { return $true }
        $root = [IO.Path]::GetPathRoot($Directory)
        if ($CreateIfMissing -and $root -and (Test-Path -LiteralPath $root)) {
            New-Item -ItemType Directory -Force -Path $Directory | Out-Null
            return $true
        }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ($true)
    return $false
}

function Get-HandoffPaths {
    param([string]$Directory, [string]$Machine, [string]$PeerName)

    $root = Join-Path $Directory 'db-handoff'
    return [pscustomobject]@{
        Root         = $root
        Lineage      = Join-Path $root 'lineage.json'
        MachineDir   = Join-Path $root $Machine
        MachineState = Join-Path (Join-Path $root $Machine) 'current.json'
        PeerDir      = Join-Path $root $PeerName
        PeerState    = Join-Path (Join-Path $root $PeerName) 'current.json'
    }
}

function Test-HandoffManifest {
    param($Manifest, [string]$ExpectedMachine, [string]$Lineage, [string]$Directory)

    if (-not $Manifest) { return $false }
    if ($Manifest.format -ne 'mtb-db-handoff-v1') { throw "Unsupported handoff manifest for $ExpectedMachine." }
    if ($Manifest.machine -ne $ExpectedMachine) { throw "Manifest in $ExpectedMachine folder names another machine." }
    if ($Manifest.lineage -ne $Lineage) { return $false }
    if ([int64]$Manifest.generation -lt 1) { throw "Invalid generation in $ExpectedMachine manifest." }
    if (-not $Manifest.dumpFile -or [IO.Path]::GetFileName([string]$Manifest.dumpFile) -ne [string]$Manifest.dumpFile) {
        throw "Unsafe dump filename in $ExpectedMachine manifest."
    }
    $dumpPath = Join-Path $Directory ([string]$Manifest.dumpFile)
    if (-not (Test-Path -LiteralPath $dumpPath)) { throw "Dump listed by $ExpectedMachine is not available yet: $dumpPath" }
    if ((Get-FileSha256 -Path $dumpPath) -ne [string]$Manifest.dumpSha256) {
        throw "Dump checksum does not match for $ExpectedMachine."
    }
    return $true
}

function Get-CurrentHandoffManifest {
    param($Paths, $Lineage)

    $items = @()
    $mine = Read-HandoffJson -Path $Paths.MachineState
    if (Test-HandoffManifest -Manifest $mine -ExpectedMachine (Split-Path $Paths.MachineDir -Leaf) -Lineage $Lineage.id -Directory $Paths.MachineDir) {
        $items += [pscustomobject]@{ Manifest = $mine; Directory = $Paths.MachineDir }
    }
    $peer = Read-HandoffJson -Path $Paths.PeerState
    if (Test-HandoffManifest -Manifest $peer -ExpectedMachine (Split-Path $Paths.PeerDir -Leaf) -Lineage $Lineage.id -Directory $Paths.PeerDir) {
        $items += [pscustomobject]@{ Manifest = $peer; Directory = $Paths.PeerDir }
    }
    if (-not $items.Count) { return $null }

    $maxGeneration = ($items | ForEach-Object { [int64]$_.Manifest.generation } | Measure-Object -Maximum).Maximum
    $top = @($items | Where-Object { [int64]$_.Manifest.generation -eq [int64]$maxGeneration })
    $hashes = @($top | ForEach-Object { [string]$_.Manifest.databaseHash } | Sort-Object -Unique)
    if ($hashes.Count -gt 1) {
        throw "DIVERGENCE: generation $maxGeneration exists with different database hashes. Nothing was changed."
    }
    return $top[0]
}

function New-VerifiedDatabaseDump {
    param($Context, [string]$Path, [int]$Attempts = 2)

    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $before = Get-DatabaseFingerprint -Context $Context
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        $args = @(
            '-U', $Context.Db.User, '-h', $Context.Db.Host, '-p', [string]$Context.Db.Port,
            '-d', $Context.Db.Database, '-Fc', '--no-owner', '--no-privileges', '-f', $Path
        )
        Invoke-PostgresTool -Context $Context -Tool $Context.PgDump -Arguments $args
        Invoke-PostgresTool -Context $Context -Tool $Context.PgRestore -Arguments @('--list', $Path) -Capture | Out-Null
        $after = Get-DatabaseFingerprint -Context $Context
        if ($before -eq $after) {
            return [pscustomobject]@{
                DatabaseHash = $after
                DumpSha256   = Get-FileSha256 -Path $Path
                DumpBytes    = (Get-Item -LiteralPath $Path).Length
            }
        }
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds 3 }
    }
    throw 'The database changed while the dump was being made. It was not published; retry when edits are quiet.'
}

function Restore-DatabaseDump {
    param($Context, [string]$DumpPath)

    $args = @(
        '--exit-on-error', '--single-transaction', '--clean', '--if-exists',
        '--no-owner', '--no-privileges',
        '-U', $Context.Db.User, '-h', $Context.Db.Host, '-p', [string]$Context.Db.Port,
        '-d', $Context.Db.Database, $DumpPath
    )
    Invoke-PostgresTool -Context $Context -Tool $Context.PgRestore -Arguments $args
}

function New-PublishedSnapshot {
    param(
        $Context, $Paths, [string]$Machine, [string]$Lineage, [int64]$Generation,
        [string]$SourceLabel, [int]$KeepSnapshots = 20
    )

    $stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
    $fileName = ('{0:D8}-{1}-{2}.dump' -f $Generation, $Machine, $stamp)
    $localPart = Join-Path (Join-Path $Context.StateDir 'outgoing') ($fileName + '.part')
    $proof = New-VerifiedDatabaseDump -Context $Context -Path $localPart

    New-Item -ItemType Directory -Force -Path $Paths.MachineDir | Out-Null
    $sharedPart = Join-Path $Paths.MachineDir ($fileName + '.part')
    $sharedFinal = Join-Path $Paths.MachineDir $fileName
    Copy-Item -LiteralPath $localPart -Destination $sharedPart -Force
    if ((Get-FileSha256 -Path $sharedPart) -ne $proof.DumpSha256) {
        Remove-Item -LiteralPath $sharedPart -Force -ErrorAction SilentlyContinue
        throw 'The pCloud copy did not match the verified local dump.'
    }
    Move-Item -LiteralPath $sharedPart -Destination $sharedFinal -Force

    $manifest = [ordered]@{
        format           = 'mtb-db-handoff-v1'
        lineage          = $Lineage
        generation       = $Generation
        machine          = $Machine
        source           = $SourceLabel
        createdAt        = (Get-Date).ToUniversalTime().ToString('o')
        database         = $Context.Db.Database
        databaseHash     = $proof.DatabaseHash
        dumpFile         = $fileName
        dumpSha256       = $proof.DumpSha256
        dumpBytes        = $proof.DumpBytes
        schemaMigrations = @(Get-DatabaseMigrations -Context $Context)
        gitCommit        = (& git -C $Context.RepoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    }
    Write-HandoffJsonAtomic -Path $Paths.MachineState -Value $manifest
    Save-HandoffState -Context $Context -Machine $Machine -Lineage $Lineage -Generation $Generation -DatabaseHash $proof.DatabaseHash | Out-Null

    Remove-Item -LiteralPath $localPart -Force -ErrorAction SilentlyContinue
    $old = @(Get-ChildItem -LiteralPath $Paths.MachineDir -Filter '*.dump' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepSnapshots)
    foreach ($item in $old) { Remove-Item -LiteralPath $item.FullName -Force }
    return [pscustomobject]$manifest
}

function Copy-HandoffAcknowledgement {
    param($Context, $Paths, $Current, [string]$Machine)

    $sourcePath = Join-Path $Current.Directory ([string]$Current.Manifest.dumpFile)
    New-Item -ItemType Directory -Force -Path $Paths.MachineDir | Out-Null
    $targetPath = Join-Path $Paths.MachineDir ([string]$Current.Manifest.dumpFile)
    if ((Resolve-Path -LiteralPath $sourcePath).Path -ne (Resolve-Path -LiteralPath $Paths.MachineDir).Path) {
        Copy-Item -LiteralPath $sourcePath -Destination ($targetPath + '.part') -Force
        if ((Get-FileSha256 -Path ($targetPath + '.part')) -ne [string]$Current.Manifest.dumpSha256) {
            Remove-Item -LiteralPath ($targetPath + '.part') -Force -ErrorAction SilentlyContinue
            throw 'The acknowledgement copy failed checksum verification.'
        }
        Move-Item -LiteralPath ($targetPath + '.part') -Destination $targetPath -Force
    }
    $copy = [ordered]@{}
    foreach ($property in $Current.Manifest.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    $copy.machine = $Machine
    $copy.source = 'acknowledged restore'
    $copy.createdAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-HandoffJsonAtomic -Path $Paths.MachineState -Value $copy
}

function Backup-AndRestoreHandoff {
    param($Context, $Paths, $Current, [string]$Machine, [switch]$StartupComplete)

    $repoMigrations = @(Get-RepositoryMigrations -RepoRoot $Context.RepoRoot)
    $sourceMigrations = @($Current.Manifest.schemaMigrations)
    if (-not (Test-ExactStringList -Left $repoMigrations -Right $sourceMigrations)) {
        throw 'Repository migrations do not match the incoming database. Run git pull before restoring.'
    }

    $stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
    $backupPath = Join-Path (Join-Path $Context.StateDir 'pre-restore') ("$($Context.Db.Database)-$Machine-$stamp.dump")
    $oldHash = Get-DatabaseFingerprint -Context $Context
    $backup = New-VerifiedDatabaseDump -Context $Context -Path $backupPath
    $sourcePath = Join-Path $Current.Directory ([string]$Current.Manifest.dumpFile)

    try {
        Restore-DatabaseDump -Context $Context -DumpPath $sourcePath
        $restoredHash = Get-DatabaseFingerprint -Context $Context
        if ($restoredHash -ne [string]$Current.Manifest.databaseHash) {
            throw 'The restored database fingerprint does not match the manifest.'
        }
    } catch {
        $restoreError = $_.Exception.Message
        try {
            Restore-DatabaseDump -Context $Context -DumpPath $backupPath
            if ((Get-DatabaseFingerprint -Context $Context) -ne $oldHash) {
                throw 'The emergency rollback fingerprint did not match.'
            }
        } catch {
            throw ("Incoming restore failed ({0}); restoring the local safety dump also failed ({1}). Safety dump: {2}" -f $restoreError, $_.Exception.Message, $backupPath)
        }
        throw ("Incoming restore failed and the original local database was restored: {0}" -f $restoreError)
    }

    Copy-HandoffAcknowledgement -Context $Context -Paths $Paths -Current $Current -Machine $Machine
    Save-HandoffState -Context $Context -Machine $Machine -Lineage ([string]$Current.Manifest.lineage) `
        -Generation ([int64]$Current.Manifest.generation) -DatabaseHash ([string]$Current.Manifest.databaseHash) `
        -StartupComplete:$StartupComplete | Out-Null
    return $backupPath
}

function Get-HandoffDecision {
    param(
        $LocalState, [string]$LocalHash, $CurrentManifest,
        [string]$Lineage, [string]$Machine, [string]$Primary
    )

    if (-not $CurrentManifest) { return [pscustomobject]@{ Action = 'refuse'; Reason = 'No valid pCloud snapshot exists.' } }

    if (-not $LocalState -or $LocalState.lineage -ne $Lineage) {
        if ($Machine -eq $Primary) {
            return [pscustomobject]@{ Action = 'refuse'; Reason = 'The primary machine must initialize this lineage explicitly.' }
        }
        if ($CurrentManifest.machine -ne $Primary) {
            return [pscustomobject]@{ Action = 'refuse'; Reason = 'An uninitialized replica only accepts the initial snapshot from the primary machine.' }
        }
        return [pscustomobject]@{ Action = 'restore'; Reason = 'Initial seed from the primary machine.' }
    }

    $localGeneration = [int64]$LocalState.generation
    $remoteGeneration = [int64]$CurrentManifest.generation
    $agreedHash = [string]$LocalState.databaseHash
    $remoteHash = [string]$CurrentManifest.databaseHash

    if ($remoteGeneration -lt $localGeneration) {
        return [pscustomobject]@{ Action = 'refuse'; Reason = 'pCloud is older than this machine; wait for it to finish syncing.' }
    }
    if ($remoteGeneration -gt $localGeneration) {
        if ($LocalHash -ne $agreedHash) {
            return [pscustomobject]@{ Action = 'diverged'; Reason = 'Both this database and the pCloud generation changed.' }
        }
        return [pscustomobject]@{ Action = 'restore'; Reason = 'Only pCloud has a newer generation.' }
    }
    if ($remoteHash -ne $agreedHash) {
        return [pscustomobject]@{ Action = 'diverged'; Reason = 'The same generation has a different database hash.' }
    }
    if ($LocalHash -ne $agreedHash) {
        return [pscustomobject]@{ Action = 'publish'; Reason = 'Only this database changed.' }
    }
    return [pscustomobject]@{ Action = 'none'; Reason = 'This database and pCloud already agree.' }
}
