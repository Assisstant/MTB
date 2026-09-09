# Read-only installation audit, also runnable as one file copied to another PC.
# No setup, pulls, migrations, imports, service changes or remote execution.
# The only optional write is the explicitly requested names-free JSON report.
#
# powershell -NoProfile -ExecutionPolicy Bypass -File audit-installation.ps1
# powershell -NoProfile -ExecutionPolicy Bypass -File audit-installation.ps1 `
#   -RepoRoot C:\MTB -OutputPath P:\MTB-installation-audit.json
[CmdletBinding()]
param(
    [string] $RepoRoot,
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'

function Invoke-AuditProcess {
    param([string] $FilePath, [string[]] $Arguments, [string] $InputText, [int] $TimeoutSeconds = 12)
    $process = New-Object System.Diagnostics.Process
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $FilePath
        # Windows argument quoting; the JavaScript program itself goes over stdin.
        $start.Arguments = (@($Arguments | ForEach-Object {
            '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
        }) -join ' ')
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.RedirectStandardInput = $true
        # An inherited preload/debug option must not execute unrelated Node code.
        [void] $start.EnvironmentVariables.Remove('NODE_OPTIONS')
        $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
        $process.StartInfo = $start
        [void] $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputText) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject]@{ Ok = $false; Reason = 'timeout'; Text = '' }
        }
        # Never return stderr: tools may put connection strings or identities there.
        $ignoredError = $stderr.Result
        return [pscustomobject]@{ Ok = ($process.ExitCode -eq 0); Reason = 'process_exit'; Text = $stdout.Result }
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = 'process_unavailable'; Text = '' }
    } finally { $process.Dispose() }
}

function Find-AuditTool {
    param([string] $Name, [string] $Fallback)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($Fallback -and (Test-Path -LiteralPath $Fallback -PathType Leaf)) { return $Fallback }
    return $null
}

function Test-AuditRepo {
    param([string] $Path)
    return ($Path -and (Test-Path -LiteralPath (Join-Path $Path 'server\package.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path 'RasporediFusion.html') -PathType Leaf))
}

function Read-AuditConfig {
    param([string] $Path)
    $settings = @{}
    if ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
        foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
            if ($line -match '^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
                $key = $Matches[1]
                $value = $Matches[2]
                if ($value -match '^(["''])(.*)\1\s*(?:#.*)?$') { $value = $Matches[2] }
                else { $value = ($value -replace '\s+#.*$', '').Trim() }
                $settings[$key] = $value
            }
        }
    }
    return $settings
}

function Get-AuditSnapshot {
    param([string] $Directory, [ValidateSet('home', 'work')] [string] $Role)
    $summary = [ordered]@{ role = $Role; state = 'unavailable'; checksumsVerified = $false }
    try {
        if (-not $Directory -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return $summary }
        $machineDir = Join-Path $Directory ('manual-db-sync\' + $Role)
        $pointer = Join-Path $machineDir 'current.json'
        if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { $summary.state = 'missing'; return $summary }
        $manifest = Get-Content -LiteralPath $pointer -Raw -Encoding UTF8 | ConvertFrom-Json
        $id = [string] $manifest.snapshotId
        if ($manifest.format -ne 'mtb-manual-db-sync-v1' -or $manifest.machine -cne $Role -or
            $id -cnotmatch ('^' + $Role + '-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$')) {
            $summary.state = 'invalid_manifest'; return $summary
        }
        $summary.snapshotId = $id
        $created = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string] $manifest.createdAt, [ref] $created)) {
            $summary.createdAt = $created.ToUniversalTime().ToString('o')
        }
        foreach ($key in @('databaseHash', 'dumpSha256', 'contentHash')) {
            if ([string] $manifest.$key -match '^[a-fA-F0-9]{64}$') { $summary[$key] = [string] $manifest.$key }
        }
        $summary.migrationCount = @($manifest.schemaMigrations | Where-Object { $_ }).Count
        $snapshotDir = Join-Path (Join-Path $machineDir 'snapshots') $id
        $storedPath = Join-Path $snapshotDir 'manifest.json'
        if (-not (Test-Path -LiteralPath $storedPath -PathType Leaf)) { $summary.state = 'incomplete'; return $summary }
        $stored = Get-Content -LiteralPath $storedPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($stored.snapshotId -cne $id -or $stored.machine -cne $Role -or
            $stored.dumpSha256 -cne $manifest.dumpSha256) { $summary.state = 'manifest_mismatch'; return $summary }
        $files = @([pscustomobject]@{ kind = 'PostgreSQL'; file = [string] $manifest.dumpFile })
        foreach ($entry in @($manifest.jsonFiles)) {
            if ($entry.kind -notin @('Rasporedi', 'SDnevnik')) { $summary.state = 'invalid_manifest'; return $summary }
            $files += [pscustomobject]@{ kind = [string] $entry.kind; file = [string] $entry.file }
        }
        if (@($files | Where-Object kind -eq 'Rasporedi').Count -ne 1 -or
            @($files | Where-Object kind -eq 'SDnevnik').Count -ne 1) { $summary.state = 'incomplete'; return $summary }
        $fileStatus = @()
        foreach ($file in $files) {
            if ($file.file -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { $summary.state = 'invalid_manifest'; return $summary }
            $path = Join-Path $snapshotDir $file.file
            $exists = Test-Path -LiteralPath $path -PathType Leaf
            $bytes = if ($exists) { (Get-Item -LiteralPath $path).Length } else { 0 }
            $fileStatus += [pscustomobject]@{ kind = $file.kind; present = $exists; bytes = $bytes }
        }
        $summary.files = $fileStatus
        $summary.state = if (@($fileStatus | Where-Object { -not $_.present -or $_.bytes -le 0 }).Count) { 'incomplete' } else { 'files_present_unverified' }
        # Only manifests and file metadata are read, never the dump or pupil JSON.
        if ($manifest.dumpBytes -and $fileStatus[0].bytes -ne [int64] $manifest.dumpBytes) { $summary.state = 'size_mismatch' }
    } catch { $summary.state = 'unreadable' }
    return $summary
}

$report = [ordered]@{
    format = 'mtb-installation-audit-v1'
    capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
    computer = $env:COMPUTERNAME
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    readOnly = $true
    scriptSha256 = if ($PSCommandPath) { (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
}

try {
    $candidates = @()
    if ($RepoRoot) {
        $candidates = @([IO.Path]::GetFullPath($RepoRoot))
    } else {
        if ($PSScriptRoot) { $candidates += Split-Path $PSScriptRoot -Parent }
        $documents = [Environment]::GetFolderPath('MyDocuments')
        if ($documents) { $candidates += Join-Path $documents 'GitHub\MTB' }
        $candidates += @('C:\MTB', 'E:\MTB')
    }
    $found = @($candidates | Select-Object -Unique | Where-Object { Test-AuditRepo $_ })
    $resolvedRepo = if ($found.Count -eq 1) { [IO.Path]::GetFullPath($found[0]) } else { $null }
    $report.repository = [ordered]@{
        state = if ($found.Count -gt 1) { 'multiple_candidates_pass_RepoRoot' } elseif ($resolvedRepo) { 'found' } else { 'not_found_pass_RepoRoot' }
        path = $resolvedRepo
        candidateCount = $found.Count
    }

    $node = Find-AuditTool 'node.exe' 'C:\Program Files\nodejs\node.exe'
    $git = Find-AuditTool 'git.exe' 'C:\Program Files\Git\cmd\git.exe'
    $nodeVersion = $null
    if ($node) {
        $result = Invoke-AuditProcess $node @('--version')
        if ($result.Ok -and $result.Text.Trim() -match '^v\d+\.\d+\.\d+$') { $nodeVersion = $result.Text.Trim() }
    }
    $postgresTools = @(Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue)
    $report.tools = [ordered]@{ nodePresent = [bool] $node; nodeVersion = $nodeVersion; gitPresent = [bool] $git; postgresClientPresent = ($postgresTools.Count -gt 0) }
    try {
        $report.services = @((Get-Service -Name '*postgres*', 'Tailscale' -ErrorAction SilentlyContinue) | ForEach-Object {
            [pscustomobject]@{ kind = if ($_.Name -eq 'Tailscale') { 'tailscale' } else { 'postgresql' }; status = [string] $_.Status }
        })
    } catch { $report.services = [ordered]@{ state = 'unavailable' } }

    $config = @{}
    if ($resolvedRepo) {
        $envFile = Join-Path $resolvedRepo 'server\.env'
        $config = Read-AuditConfig $envFile
        $role = if ($config.SYNC_NAME -in @('home', 'work')) { $config.SYNC_NAME } elseif ($config.SYNC_NAME) { 'invalid' } else { 'missing' }
        $report.configuration = [ordered]@{
            envPresent = (Test-Path -LiteralPath $envFile -PathType Leaf)
            syncName = $role
            databaseUrlPresent = [bool] ($config.DATABASE_URL -or $env:DATABASE_URL)
            signinRequired = ($config.MTB_REQUIRE_SIGNIN -eq '1')
            adminConfigured = [bool] $config.MTB_ADMIN
            serviceKeyConfigured = [bool] $config.MTB_SERVICE_KEY
            serviceKeyAtLeast32 = (([string] $config.MTB_SERVICE_KEY).Length -ge 32)
            dependenciesPresent = (Test-Path -LiteralPath (Join-Path $resolvedRepo 'server\node_modules') -PathType Container)
        }
        if ($git) {
            $gitInfo = [ordered]@{ state = 'unavailable' }
            $head = Invoke-AuditProcess $git @('--no-optional-locks', '-C', $resolvedRepo, 'rev-parse', 'HEAD')
            $branch = Invoke-AuditProcess $git @('--no-optional-locks', '-C', $resolvedRepo, 'branch', '--show-current')
            $status = Invoke-AuditProcess $git @('--no-optional-locks', '-C', $resolvedRepo, 'status', '--porcelain=v1', '--untracked-files=normal')
            if ($head.Ok -and $head.Text.Trim() -match '^[a-f0-9]{40,64}$') { $gitInfo.head = $head.Text.Trim(); $gitInfo.state = 'readable' }
            if ($branch.Ok -and $branch.Text.Trim() -match '^[A-Za-z0-9_./-]*$') { $gitInfo.branch = $branch.Text.Trim() }
            if ($status.Ok) { $gitInfo.dirty = [bool] $status.Text.Trim(); $gitInfo.changedPathCount = @($status.Text -split '\r?\n' | Where-Object { $_ }).Count }
            $report.repository.git = $gitInfo
        }
    }

    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
        $report.localApi = [ordered]@{
            state = 'responding'; ok = ($health.ok -eq $true)
            role = if ($health.server.role -in @('home', 'work')) { $health.server.role } else { 'unconfigured' }
            signinRequired = ($health.signinRequired -eq $true)
        }
    } catch { $report.localApi = [ordered]@{ state = 'unavailable' } }

    try {
        $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -in @(
            'TherapyServer', 'TherapyBackup', 'TherapyBackupWeekly', 'TherapySyncPeer',
            'TherapySyncMailbox', 'TherapyDbPublish', 'TherapyDbSnapshotWeekly'
        ) })
        $report.scheduledTasks = [ordered]@{ state = 'readable'; tasks = @($tasks | ForEach-Object {
            $task = $_
            $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
            $actions = @($task.Actions | ForEach-Object {
                $arguments = [string] $_.Arguments
                $scriptName = 'unrecognized'
                foreach ($known in @('startup.ps1', 'run-server.ps1', 'backup-db.ps1', 'sync-peer.ps1', 'db-handoff.ps1', 'manual-db-sync.ps1')) {
                    if ($arguments -match ('(?i)[\\/]' + [regex]::Escape($known) + '(?:"|\s|$)')) { $scriptName = $known; break }
                }
                $roleArg = [regex]::Match($arguments, '(?i)(?:^|\s)-Me\s+["'']?(home|work)(?:["'']|\s|$)').Groups[1].Value
                [pscustomobject]@{
                    script = $scriptName
                    apply = [bool] ($arguments -match '(?i)(?:^|\s)-Apply(?:\s|$)')
                    force = [bool] ($arguments -match '(?i)(?:^|\s)-Force(?:\s|$)')
                    independent = [bool] ($arguments -match '(?i)(?:^|\s)-Independent(?:\s|$)')
                    modeExport = [bool] ($arguments -match '(?i)(?:^|\s)-Mode\s+Export(?:\s|$)')
                    modeAccept = [bool] ($arguments -match '(?i)(?:^|\s)-Mode\s+Accept(?:\s|$)')
                    role = if ($roleArg) { $roleArg.ToLowerInvariant() } else { $null }
                    workingDirectoryMatchesRepo = if ($resolvedRepo) { ([string] $_.WorkingDirectory).TrimEnd('\') -ieq $resolvedRepo.TrimEnd('\') } else { $null }
                }
            })
            [pscustomobject]@{ name = $task.TaskName; state = [string] $task.State; enabled = $task.Settings.Enabled; lastResult = $info.LastTaskResult; actions = $actions }
        }) }
    } catch { $report.scheduledTasks = [ordered]@{ state = 'unavailable_or_permission_denied' } }

    $tailscale = Find-AuditTool 'tailscale.exe' 'C:\Program Files\Tailscale\tailscale.exe'
    $report.tailscale = [ordered]@{ state = 'unavailable' }
    if ($tailscale) {
        $result = Invoke-AuditProcess $tailscale @('status', '--json')
        if ($result.Ok) {
            try {
                $ts = $result.Text | ConvertFrom-Json
                $report.tailscale = [ordered]@{
                    state = if ($ts.BackendState -in @('Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState')) { $ts.BackendState } else { 'unknown' }
                    selfOnline = ($ts.Self.Online -eq $true)
                    peerCount = @($ts.Peer.PSObject.Properties | Where-Object { $_ }).Count
                    onlinePeerCount = @($ts.Peer.PSObject.Properties.Value | Where-Object { $_.Online -eq $true }).Count
                }
            } catch { $report.tailscale.state = 'invalid_status' }
        }
        $result = Invoke-AuditProcess $tailscale @('serve', 'status', '--json')
        if ($result.Ok) {
            try {
                $serve = $result.Text | ConvertFrom-Json
                $handlers = @($serve.Web.PSObject.Properties.Value | ForEach-Object { $_.Handlers.PSObject.Properties.Value })
                $report.tailscale.serve = [ordered]@{
                    state = 'readable'
                    webHostCount = @($serve.Web.PSObject.Properties | Where-Object { $_ }).Count
                    proxiesToLocalApi = (@($handlers | Where-Object { $_.Proxy -match '^https?://(?:127\.0\.0\.1|localhost):3000/?$' }).Count -gt 0)
                    hasFileServing = (@($handlers | Where-Object { $_.Path }).Count -gt 0)
                    funnelEnabled = ($serve.AllowFunnel.PSObject.Properties.Value -contains $true)
                }
            } catch { $report.tailscale.serve = [ordered]@{ state = 'invalid_status' } }
        } else { $report.tailscale.serve = [ordered]@{ state = $result.Reason } }
    }

    $syncDirectory = $null
    foreach ($key in @('MANUAL_SYNC_DIR', 'HANDOFF_DIR', 'SYNC_DIR')) { if (-not $syncDirectory -and $config[$key]) { $syncDirectory = $config[$key] } }
    if (-not $syncDirectory) { $syncDirectory = 'P:\MTB-sync' }
    $report.snapshots = @('home', 'work') | ForEach-Object { Get-AuditSnapshot $syncDirectory $_ }

    $report.database = [ordered]@{ state = 'unavailable_without_repo_node_and_dependencies' }
    if ($resolvedRepo -and $node -and $report.configuration.dependenciesPresent) {
        # No application code is imported: pg/dotenv plus fixed read-only SQL only.
        # The child accepts a repository path, never a database URL on its command line.
        $databaseScript = @'
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const repo = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value));
const knownTables = ['app_state','assessments','attendance','audiograms','bell_period_overrides','bell_periods','class_years','diary_schedule','diary_schedule_history','evidence_contacts','evidence_examiner_roles','evidence_examiners','evidence_groups','evidence_items','evidence_logins','evidence_panels','evidence_periods','evidence_scores','evidence_sections','evidence_sessions','evidence_sheet_sections','evidence_sheets','lessons','plan_activities','plans','resource_links','scale_templates','schedule_slots','schema_migrations','school_classes','school_years','specialist_categories','student_enrollments','student_plan_progress','student_records','students','teacher_classes','teacher_years','teachers','therapist_students','therapist_years','therapists','triage_tests'];
(async () => {
  let pool, client;
  try {
    const localRequire = createRequire(path.join(repo, 'server', 'package.json'));
    const pg = localRequire('pg');
    const dotenv = localRequire('dotenv');
    const envPath = path.join(repo, 'server', '.env');
    const config = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
    const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
    if (!connectionString) return emit({state:'database_url_missing'});
    let url;
    try { url = new URL(connectionString); } catch { return emit({state:'database_url_invalid'}); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase())) return emit({state:'skipped_nonlocal_database'});
    pool = new pg.Pool({connectionString,connectionTimeoutMillis:5000,query_timeout:7000,statement_timeout:7000,max:1});
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = {state:'readable',transactionReadOnly:true};
    result.postgresVersion = (await client.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    result.cyrillicLowercaseWorks = (await client.query('SELECT lower(chr(1027))=chr(1107) AS ok')).rows[0].ok;
    const actualTables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sync_watermark' ORDER BY table_name")).rows.map(r=>r.table_name);
    result.unknownTableCount = actualTables.filter(t=>!knownTables.includes(t)).length;
    result.missingKnownTables = knownTables.filter(t=>!actualTables.includes(t));
    const tables = actualTables.filter(t=>knownTables.includes(t));
    result.tables = [];
    const parts = [];
    for (const table of tables) {
      const row = (await client.query('SELECT count(*)::int AS rows, coalesce(md5(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text), md5(\'[]\')) AS hash FROM public."'+table+'" AS t')).rows[0];
      result.tables.push({table,...row});
      parts.push(`table:${table}:${row.rows}:${row.hash}`);
    }
    const sequences = (await client.query("SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name")).rows.map(r=>r.sequence_name);
    for (const sequence of sequences) {
      const row = (await client.query('SELECT last_value::text AS value,is_called::text AS called FROM public."'+sequence.replaceAll('"','""')+'"')).rows[0];
      parts.push(`sequence:${sequence}:${row.value}:${row.called}`);
    }
    result.databaseHash = result.unknownTableCount ? null : createHash('sha256').update(parts.join('\n')).digest('hex');
    result.fingerprintIncludesSequences = true;
    result.fingerprintExcludes = ['sync_watermark'];
    if (tables.includes('schema_migrations')) {
      const migrations = (await client.query('SELECT filename FROM public.schema_migrations ORDER BY filename')).rows.map(r=>r.filename);
      result.migrations = migrations.filter(n=>/^\d{3}_[a-z0-9_]+\.sql$/.test(n));
      result.unrecognizedMigrationCount = migrations.length-result.migrations.length;
    }
    if (tables.includes('school_years')) result.years = (await client.query("SELECT id, CASE WHEN label ~ '^[0-9]{4}/[0-9]{4}$' THEN label ELSE '[unrecognized]' END AS label,is_current FROM public.school_years ORDER BY id")).rows;
    if (tables.includes('schedule_slots')) result.scheduleByYear = (await client.query('SELECT school_year_id,count(*)::int AS rows FROM public.schedule_slots GROUP BY 1 ORDER BY 1')).rows;
    await client.query('ROLLBACK');
    emit(result);
  } catch(error) {
    emit({state:'unavailable',errorCode:/^[A-Z0-9_]{2,30}$/.test(error.code||'') ? error.code : 'READ_FAILED'});
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
})();
'@
        $result = Invoke-AuditProcess -FilePath $node -Arguments @('-', $resolvedRepo) -InputText $databaseScript -TimeoutSeconds 60
        if ($result.Ok) {
            try { $report.database = $result.Text | ConvertFrom-Json }
            catch { $report.database = [ordered]@{ state = 'invalid_diagnostic_output' } }
        } else { $report.database = [ordered]@{ state = $result.Reason } }
    }
} catch {
    # Do not serialize exception text, arbitrary configuration or tool output.
    $report.auditError = 'A check could not finish; completed sections remain available.'
}

$json = $report | ConvertTo-Json -Depth 12
if ($OutputPath) {
    try {
        $destination = [IO.Path]::GetFullPath($OutputPath)
        if ([IO.Path]::GetExtension($destination) -ine '.json') { throw 'Report must be JSON.' }
        $parent = Split-Path $destination -Parent
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Report directory must exist.' }
        # Refuse replacement: an audit must never overwrite a snapshot or user file.
        $stream = New-Object System.IO.FileStream($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json + [Environment]::NewLine)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
        Write-Host 'Audit report written. No application data or settings were changed.'
        Write-Host ('Repository: {0}; local API: {1}; database: {2}.' -f $report.repository.state, $report.localApi.state, $report.database.state)
        Write-Host ('Report: ' + $destination)
        return
    } catch {
        Write-Warning 'The report could not be written (the parent must exist and the JSON file must be new). Report follows.'
    }
}
Write-Output $json
