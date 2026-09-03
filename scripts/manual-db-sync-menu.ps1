[CmdletBinding()]
param(
    [string] $Dir,
    [string] $Me,
    [string] $PeerName,
    [switch] $StatusOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$syncScript = Join-Path $PSScriptRoot 'manual-db-sync.ps1'
$envFile = Join-Path $repoRoot 'server\.env'

function Get-EnvValue {
    param([string] $Name)

    if (-not (Test-Path -LiteralPath $envFile)) { return $null }
    $prefix = $Name + '='
    $line = Get-Content -LiteralPath $envFile |
        Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if (-not $line) { return $null }
    return $line.Substring($prefix.Length).Trim().Trim([char]34).Trim([char]39)
}

function Resolve-MenuSettings {
    $resolvedDir = $Dir
    foreach ($name in @('MANUAL_SYNC_DIR', 'HANDOFF_DIR', 'SYNC_DIR')) {
        if (-not $resolvedDir) { $resolvedDir = Get-EnvValue -Name $name }
    }
    if (-not $resolvedDir) { $resolvedDir = 'P:\MTB-sync' }

    $resolvedMe = $Me
    foreach ($name in @('MANUAL_SYNC_NAME', 'HANDOFF_NAME', 'SYNC_NAME')) {
        if (-not $resolvedMe) { $resolvedMe = Get-EnvValue -Name $name }
    }

    $hostName = [string]$env:COMPUTERNAME
    if (-not $resolvedMe) {
        throw 'Не можам да утврдам дали ова е WORK или HOME. Hostname не е доволен; постави SYNC_NAME=work/home во server\.env.'
    }

    $resolvedMe = $resolvedMe.ToLowerInvariant()
    if ($resolvedMe -notin @('work', 'home')) {
        throw "Непознато SYNC_NAME '$resolvedMe'. Дозволено е само work или home."
    }
    $resolvedPeer = $PeerName
    foreach ($name in @('MANUAL_SYNC_PEER', 'HANDOFF_PEER_NAME')) {
        if (-not $resolvedPeer) { $resolvedPeer = Get-EnvValue -Name $name }
    }
    if (-not $resolvedPeer) {
        $resolvedPeer = if ($resolvedMe -eq 'work') { 'home' } else { 'work' }
    }
    $resolvedPeer = $resolvedPeer.ToLowerInvariant()
    $expectedPeer = if ($resolvedMe -eq 'work') { 'home' } else { 'work' }
    if ($resolvedPeer -cne $expectedPeer) {
        throw "Заштитно стопирање: за '$resolvedMe' другиот компјутер мора да биде '$expectedPeer', не '$resolvedPeer'."
    }

    return [pscustomobject]@{
        Dir       = [IO.Path]::GetFullPath($resolvedDir)
        Me        = $resolvedMe
        PeerName  = $resolvedPeer
        HostName  = $hostName
    }
}

function Get-MachineLabel {
    param([string] $Machine)

    if ($Machine -eq 'work') { return 'РАБОТА' }
    if ($Machine -eq 'home') { return 'ДОМА' }
    return $Machine.ToUpperInvariant()
}

function New-SnapshotStatus {
    param(
        [string] $Machine,
        [string] $State,
        [string] $Message,
        $Manifest = $null,
        [string] $SnapshotDirectory = '',
        [int64] $Bytes = 0
    )

    return [pscustomobject]@{
        Machine           = $Machine
        State             = $State
        Ready             = ($State -eq 'ready')
        Message           = $Message
        Manifest          = $Manifest
        SnapshotDirectory = $SnapshotDirectory
        Bytes             = $Bytes
    }
}

function Get-SnapshotStatus {
    param([string] $Machine)

    if (-not (Test-Path -LiteralPath $Dir)) {
        return New-SnapshotStatus -Machine $Machine -State 'unavailable' -Message 'pCloud папката не е достапна.'
    }

    $machineDir = Join-Path (Join-Path $Dir 'manual-db-sync') $Machine
    $currentPath = Join-Path $machineDir 'current.json'
    if (-not (Test-Path -LiteralPath $currentPath)) {
        return New-SnapshotStatus -Machine $Machine -State 'missing' -Message 'нема објавен snapshot.'
    }

    try {
        $manifest = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
        if ($manifest.format -ne 'mtb-manual-db-sync-v1') { throw 'непознат manifest формат' }
        if ([string]$manifest.machine -cne $Machine) { throw 'manifest-от е од друга машина' }

        $snapshotId = [string]$manifest.snapshotId
        if ($snapshotId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'небезбеден snapshot ID' }
        $snapshotRoot = Join-Path $machineDir 'snapshots'
        $snapshotDirectory = Join-Path $snapshotRoot $snapshotId
        if (-not (Test-Path -LiteralPath $snapshotDirectory -PathType Container)) {
            throw 'snapshot папката сè уште не е преземена'
        }

        $storedManifestPath = Join-Path $snapshotDirectory 'manifest.json'
        if (-not (Test-Path -LiteralPath $storedManifestPath -PathType Leaf)) {
            throw 'manifest.json сè уште не е преземен'
        }
        $storedManifest = Get-Content -LiteralPath $storedManifestPath -Raw | ConvertFrom-Json
        if ([string]$storedManifest.snapshotId -cne $snapshotId -or [string]$storedManifest.machine -cne $Machine) {
            throw 'current.json и manifest.json не се совпаѓаат'
        }

        $dumpName = [string]$manifest.dumpFile
        if ([IO.Path]::GetFileName($dumpName) -cne $dumpName) { throw 'небезбедно име на dump датотека' }
        $files = @(
            [pscustomobject]@{ Name = $dumpName; Hash = [string]$manifest.dumpSha256; Kind = 'PostgreSQL' }
        )

        $jsonEntries = @($manifest.jsonFiles)
        $kinds = @($jsonEntries | ForEach-Object { [string]$_.kind })
        if ('Rasporedi' -notin $kinds -or 'SDnevnik' -notin $kinds) {
            throw 'недостига Rasporedi или S-Dnevnik JSON'
        }
        foreach ($entry in $jsonEntries) {
            $name = [string]$entry.file
            if ([IO.Path]::GetFileName($name) -cne $name) { throw 'небезбедно име на JSON датотека' }
            $files += [pscustomobject]@{ Name = $name; Hash = [string]$entry.sha256; Kind = [string]$entry.kind }
        }

        [int64]$totalBytes = 0
        foreach ($file in $files) {
            $path = Join-Path $snapshotDirectory $file.Name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "$($file.Kind) датотеката сè уште не е преземена"
            }
            $item = Get-Item -LiteralPath $path
            $totalBytes += [int64]$item.Length
            $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -cne $file.Hash.ToLowerInvariant()) {
                throw "$($file.Kind) checksum не се совпаѓа"
            }
        }

        if ($manifest.dumpBytes -and [int64]$manifest.dumpBytes -ne (Get-Item -LiteralPath (Join-Path $snapshotDirectory $dumpName)).Length) {
            throw 'големината на PostgreSQL dump-от не се совпаѓа'
        }

        return New-SnapshotStatus -Machine $Machine -State 'ready' -Message 'snapshot-от е целосен и checksum-ите се точни.' `
            -Manifest $manifest -SnapshotDirectory $snapshotDirectory -Bytes $totalBytes
    } catch {
        return New-SnapshotStatus -Machine $Machine -State 'invalid' -Message $_.Exception.Message
    }
}

function Show-SnapshotStatus {
    param($Status)

    $label = Get-MachineLabel -Machine $Status.Machine
    if ($Status.Ready) {
        $created = [string]$Status.Manifest.createdAt
        try { $created = [DateTimeOffset]::Parse($created).ToLocalTime().ToString('dd.MM.yyyy HH:mm:ss') } catch { }
        Write-Host ("[{0}] {1}: ПОДГОТВЕН" -f $label, $Status.Machine) -ForegroundColor Green
        Write-Host ("  ID:       {0}" -f $Status.Manifest.snapshotId)
        Write-Host ("  Создаден: {0}" -f $created)
        Write-Host ("  Проверка: {0:N1} KB, PostgreSQL + 2 JSON датотеки" -f ($Status.Bytes / 1KB)) -ForegroundColor DarkGray
        return
    }

    $color = if ($Status.State -eq 'missing') { 'Yellow' } else { 'Red' }
    $stateText = if ($Status.State -eq 'missing') { 'НЕМА SNAPSHOT' } elseif ($Status.State -eq 'unavailable') { 'НЕДОСТАПЕН' } else { 'НЕЦЕЛОСЕН' }
    Write-Host ("[{0}] {1}: {2}" -f $label, $Status.Machine, $stateText) -ForegroundColor $color
    Write-Host ("  {0}" -f $Status.Message) -ForegroundColor DarkGray
}

function Show-Dashboard {
    $local = Get-SnapshotStatus -Machine $Me
    $peer = Get-SnapshotStatus -Machine $PeerName
    $directoryAvailable = Test-Path -LiteralPath $Dir

    Write-Host 'MTB - ВОДЕНА СИНХРОНИЗАЦИЈА НА БАЗА' -ForegroundColor Cyan
    Write-Host ('=' * 55) -ForegroundColor DarkGray
    Write-Host ("Овој компјутер: {0} ({1}) · {2}" -f (Get-MachineLabel -Machine $Me), $Me, $settings.HostName)
    Write-Host ("Друг компјутер: {0} ({1})" -f (Get-MachineLabel -Machine $PeerName), $PeerName)
    if ($directoryAvailable) {
        Write-Host ("pCloud:          {0} · ДОСТАПЕН" -f $Dir) -ForegroundColor Green
    } else {
        Write-Host ("pCloud:          {0} · НЕДОСТАПЕН" -f $Dir) -ForegroundColor Red
    }
    Write-Host ''
    Show-SnapshotStatus -Status $local
    Write-Host ''
    Show-SnapshotStatus -Status $peer
    Write-Host ''
    Write-Host 'pCloud ги пренесува датотеките. Базата се заменува само со воден Accept.' -ForegroundColor DarkCyan

    return [pscustomobject]@{
        Local              = $local
        Peer               = $peer
        DirectoryAvailable = $directoryAvailable
    }
}

function Invoke-ManualSync {
    param(
        [ValidateSet('Export', 'Compare', 'LegacyPreview', 'LegacyImport', 'Accept')]
        [string] $Mode,
        [string] $Area,
        [string] $Snapshot,
        [switch] $Apply
    )

    $commandArgs = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $syncScript,
        '-Mode', $Mode,
        '-Dir', $Dir,
        '-Me', $Me,
        '-PeerName', $PeerName
    )
    if ($Area) { $commandArgs += @('-Area', $Area) }
    if ($Snapshot) { $commandArgs += @('-Snapshot', $Snapshot) }
    if ($Apply) { $commandArgs += '-Apply' }

    & powershell.exe @commandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Операцијата '$Mode' не заврши успешно (exit code $LASTEXITCODE)."
    }
}

function Read-Area {
    while ($true) {
        Write-Host ''
        Write-Host '1  Само Rasporedi'
        Write-Host '2  Само S-Dnevnik'
        Write-Host '3  Двете legacy JSON области'
        Write-Host '0  Откажи'
        $choice = (Read-Host 'Избери област').Trim()
        switch ($choice) {
            '1' { return 'Rasporedi' }
            '2' { return 'SDnevnik' }
            '3' { return 'All' }
            '0' { return $null }
            default { Write-Host 'Невалиден избор.' -ForegroundColor Yellow }
        }
    }
}

function Assert-PeerReady {
    $status = Get-SnapshotStatus -Machine $PeerName
    if (-not $status.Ready) {
        throw "Snapshot-от од $PeerName не е подготвен: $($status.Message)"
    }
    return $status
}

function Confirm-ExactSnapshot {
    param($PeerStatus)

    Write-Host ''
    Write-Host 'За потврда внеси го ТОЧНО овој snapshot ID:' -ForegroundColor Yellow
    Write-Host ("  {0}" -f $PeerStatus.Manifest.snapshotId) -ForegroundColor White
    $typed = (Read-Host 'Snapshot ID').Trim()
    if ($typed -cne [string]$PeerStatus.Manifest.snapshotId) {
        Write-Host 'ID-то не се совпаѓа. Ништо не е променето.' -ForegroundColor Yellow
        return $false
    }
    return $true
}

function Invoke-GuidedAccept {
    $peerStatus = Assert-PeerReady

    Write-Host ''
    Write-Host 'Чекор 1/2: read-only споредба со peer snapshot...' -ForegroundColor Cyan
    Invoke-ManualSync -Mode Compare

    Write-Host ''
    Write-Host 'Чекор 2/2: ЦЕЛАТА локална PostgreSQL база ќе биде заменета.' -ForegroundColor Red
    Write-Host ("Извор: {0}  {1}" -f $PeerName, $peerStatus.Manifest.snapshotId)
    Write-Host 'Пред замената автоматски се прави локален safety backup.' -ForegroundColor Yellow
    if (-not (Confirm-ExactSnapshot -PeerStatus $peerStatus)) { return }

    Invoke-ManualSync -Mode Accept -Snapshot ([string]$peerStatus.Manifest.snapshotId) -Apply
}

function Invoke-GuidedLegacyImport {
    $peerStatus = Assert-PeerReady
    $area = Read-Area
    if (-not $area) { return }

    Write-Host ''
    Write-Host 'Прво се извршува preview без промени...' -ForegroundColor Cyan
    Invoke-ManualSync -Mode LegacyPreview -Area $area

    Write-Host ''
    Write-Host "Ќе се внесат само legacy JSON податоците за '$area'." -ForegroundColor Yellow
    Write-Host 'Ова НЕ е целосна копија на сите релациони табели.' -ForegroundColor Yellow
    if (-not (Confirm-ExactSnapshot -PeerStatus $peerStatus)) { return }

    Invoke-ManualSync -Mode LegacyImport -Area $area -Snapshot ([string]$peerStatus.Manifest.snapshotId) -Apply
}

function Pause-Menu {
    Write-Host ''
    Read-Host 'Притисни Enter за враќање во менито' | Out-Null
}

try {
    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) {
        throw "Не е пронајдена главната sync скрипта: $syncScript"
    }

    $settings = Resolve-MenuSettings
    $Dir = $settings.Dir
    $Me = $settings.Me
    $PeerName = $settings.PeerName

    if ($StatusOnly) {
        $dashboard = Show-Dashboard
        if (-not $dashboard.DirectoryAvailable) { exit 1 }
        exit 0
    }

    while ($true) {
        Clear-Host
        $dashboard = Show-Dashboard
        Write-Host ''
        Write-Host '1  EXPORT: објави нов snapshot од ОВОЈ компјутер' -ForegroundColor Green
        Write-Host '2  COMPARE: спореди со ДРУГИОТ компјутер (без промени)' -ForegroundColor Cyan
        Write-Host '3  ACCEPT: спореди и преземи ЦЕЛА peer база (водено)' -ForegroundColor Yellow
        Write-Host '4  LEGACY PREVIEW: провери стар JSON import (без промени)'
        Write-Host '5  LEGACY IMPORT: preview и селективен import (водено)'
        Write-Host 'R  Освежи ја состојбата'
        Write-Host '0  Затвори'
        Write-Host ''
        $choice = (Read-Host 'Избери').Trim().ToUpperInvariant()

        try {
            switch ($choice) {
                '1' { Invoke-ManualSync -Mode Export }
                '2' { Assert-PeerReady | Out-Null; Invoke-ManualSync -Mode Compare }
                '3' { Invoke-GuidedAccept }
                '4' {
                    Assert-PeerReady | Out-Null
                    $area = Read-Area
                    if ($area) { Invoke-ManualSync -Mode LegacyPreview -Area $area }
                }
                '5' { Invoke-GuidedLegacyImport }
                'R' { continue }
                '0' { exit 0 }
                default { Write-Host 'Невалиден избор.' -ForegroundColor Yellow }
            }
        } catch {
            Write-Host ''
            Write-Host ('СТОП: ' + $_.Exception.Message) -ForegroundColor Red
            Write-Host 'Ништо дополнително нема да биде извршено од ова мени.' -ForegroundColor Yellow
        }
        Pause-Menu
    }
} catch {
    Write-Host ''
    Write-Host ('MTB sync не може да продолжи: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
