# Full PostgreSQL handoff through pCloud for machines that are used one at a time.
# Dry-run/report is the default. Scheduled tasks pass -Apply.

[CmdletBinding()]
param(
    [ValidateSet('Status', 'Initialize', 'Startup', 'Publish')]
    [string]$Mode = 'Status',
    [string]$Dir,
    [string]$Me,
    [string]$PeerName,
    [string]$Primary = 'work',
    [string]$StateDir,
    [int]$WaitSeconds = 180,
    [int]$SettleSeconds = 15,
    [switch]$Apply,
    [switch]$ResetLineage,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'db-handoff-lib.ps1')

$context = $null
$lock = $null
try {
    $envFile = Join-Path $repoRoot 'server\.env'
    if (-not $Dir) { $Dir = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_DIR' }
    if (-not $Dir) { $Dir = Get-HandoffEnvValue -EnvFile $envFile -Name 'SYNC_DIR' }
    if (-not $Me) { $Me = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_NAME' }
    if (-not $Me) { $Me = Get-HandoffEnvValue -EnvFile $envFile -Name 'SYNC_NAME' }
    if (-not $PeerName) { $PeerName = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_PEER_NAME' }
    if (-not $Primary) { $Primary = Get-HandoffEnvValue -EnvFile $envFile -Name 'HANDOFF_PRIMARY' }
    if (-not $Primary) { $Primary = 'work' }
    if (-not $Dir) { throw 'Handoff directory is missing. Pass -Dir or set HANDOFF_DIR in server\.env.' }
    if (-not $Me) { throw 'Machine name is missing. Pass -Me or set HANDOFF_NAME in server\.env.' }
    if (-not $PeerName) { $PeerName = if ($Me -eq 'work') { 'home' } else { 'work' } }
    if ($Me -eq $PeerName) { throw 'This machine and its peer must have different names.' }

    $context = New-HandoffContext -RepoRoot $repoRoot -StateDir $StateDir
    $lockPath = Join-Path $context.StateDir 'db-handoff.lock'
    try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch {
        Write-HandoffLog -Context $context -Level 'info' -Message 'Another handoff process is already running; skipped.' -Quiet:$Quiet
        exit 0
    }

    if (-not (Wait-HandoffDirectory -Directory $Dir -WaitSeconds $WaitSeconds -CreateIfMissing:($Mode -eq 'Initialize'))) {
        Write-HandoffLog -Context $context -Level 'blocked' -Message "pCloud directory is unavailable: $Dir" -Quiet:$Quiet
        exit 3
    }
    if ($Mode -eq 'Startup' -and $SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }

    $paths = Get-HandoffPaths -Directory $Dir -Machine $Me -PeerName $PeerName
    New-Item -ItemType Directory -Force -Path $paths.Root | Out-Null

    if ($Mode -eq 'Initialize') {
        $existing = Read-HandoffJson -Path $paths.Lineage
        if ($existing -and -not $ResetLineage) {
            throw 'A handoff lineage already exists. Use -ResetLineage only after choosing a new authoritative database.'
        }
        if (-not $Apply) {
            Write-HandoffLog -Context $context -Level 'plan' -Message "Would initialize a new lineage from $Me and publish generation 1." -Quiet:$Quiet
            exit 0
        }
        if ($Me -ne $Primary) { throw "Only the primary machine '$Primary' may initialize a lineage." }

        $lineage = [ordered]@{
            format        = 'mtb-db-handoff-lineage-v1'
            id            = [guid]::NewGuid().ToString()
            initializedBy = $Me
            initializedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        $manifest = New-PublishedSnapshot -Context $context -Paths $paths -Machine $Me `
            -Lineage $lineage.id -Generation 1 -SourceLabel 'authoritative initialization'
        Write-HandoffJsonAtomic -Path $paths.Lineage -Value $lineage
        Save-HandoffState -Context $context -Machine $Me -Lineage $lineage.id -Generation 1 `
            -DatabaseHash $manifest.databaseHash -StartupComplete | Out-Null
        Write-HandoffLog -Context $context -Level 'ok' -Message "Initialized lineage $($lineage.id); generation 1 is in pCloud." -Quiet:$Quiet
        exit 0
    }

    $lineage = Read-HandoffJson -Path $paths.Lineage
    if (-not $lineage -or $lineage.format -ne 'mtb-db-handoff-lineage-v1') {
        Write-HandoffLog -Context $context -Level 'blocked' -Message "No initialized full-database lineage exists. Run Initialize on $Primary." -Quiet:$Quiet
        exit 3
    }

    $current = Get-CurrentHandoffManifest -Paths $paths -Lineage $lineage
    if (-not $current) {
        Write-HandoffLog -Context $context -Level 'blocked' -Message 'No complete snapshot for the active lineage is available yet.' -Quiet:$Quiet
        exit 3
    }
    if ($current.Manifest.database -ne $context.Db.Database) {
        throw "Incoming snapshot is for database '$($current.Manifest.database)', not '$($context.Db.Database)'."
    }

    if ($Mode -eq 'Publish' -and -not (Test-HandoffStartupComplete -Context $context)) {
        Write-HandoffLog -Context $context -Level 'info' -Message 'Publish skipped until this boot completes its startup pull.' -Quiet:$Quiet
        exit 0
    }

    $localState = Get-HandoffState -Context $context
    $localHash = Get-DatabaseFingerprint -Context $context
    $decision = Get-HandoffDecision -LocalState $localState -LocalHash $localHash `
        -CurrentManifest $current.Manifest -Lineage $lineage.id -Machine $Me -Primary $Primary

    Write-HandoffLog -Context $context -Level 'info' -Message ("{0}: {1}" -f $decision.Action, $decision.Reason) -Quiet:$Quiet
    if ($Mode -eq 'Status' -or -not $Apply) { exit 0 }

    switch ($decision.Action) {
        'none' {
            if ($Mode -eq 'Startup') {
                Save-HandoffState -Context $context -Machine $Me -Lineage $lineage.id `
                    -Generation ([int64]$current.Manifest.generation) -DatabaseHash $localHash -StartupComplete | Out-Null
            }
            Write-HandoffLog -Context $context -Level 'ok' -Message "Generation $($current.Manifest.generation) is current." -Quiet:$Quiet
            exit 0
        }
        'publish' {
            $next = [int64]$current.Manifest.generation + 1
            $manifest = New-PublishedSnapshot -Context $context -Paths $paths -Machine $Me `
                -Lineage $lineage.id -Generation $next -SourceLabel "$Mode publish"
            if ($Mode -eq 'Startup') {
                Save-HandoffState -Context $context -Machine $Me -Lineage $lineage.id `
                    -Generation $next -DatabaseHash $manifest.databaseHash -StartupComplete | Out-Null
            }
            Write-HandoffLog -Context $context -Level 'ok' -Message "Published generation $next from $Me." -Quiet:$Quiet
            exit 0
        }
        'restore' {
            if ($Mode -eq 'Publish') {
                Write-HandoffLog -Context $context -Level 'blocked' -Message 'A newer pCloud generation is waiting; restart before editing.' -Quiet:$Quiet
                exit 3
            }
            $backup = Backup-AndRestoreHandoff -Context $context -Paths $paths -Current $current -Machine $Me -StartupComplete
            Write-HandoffLog -Context $context -Level 'ok' -Message "Restored generation $($current.Manifest.generation); previous DB saved at $backup" -Quiet:$Quiet
            exit 0
        }
        'diverged' {
            Write-HandoffLog -Context $context -Level 'blocked' -Message ("DIVERGENCE: {0} Nothing was changed." -f $decision.Reason) -Quiet:$Quiet
            exit 2
        }
        default {
            Write-HandoffLog -Context $context -Level 'blocked' -Message $decision.Reason -Quiet:$Quiet
            exit 3
        }
    }
} catch {
    if ($context) { Write-HandoffLog -Context $context -Level 'failed' -Message $_.Exception.Message -Quiet:$Quiet }
    else { Write-Error $_.Exception.Message }
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
