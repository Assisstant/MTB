# Pure decision-table checks for db-handoff.ps1. No database or pCloud access.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'db-handoff-lib.ps1')

$failed = 0
function Check([string]$name, [string]$want, $state, [string]$localHash, $manifest, [string]$machine = 'work') {
    $actual = (Get-HandoffDecision -LocalState $state -LocalHash $localHash -CurrentManifest $manifest `
        -Lineage 'lineage-a' -Machine $machine -Primary 'work').Action
    if ($actual -ne $want) {
        Write-Host "FAIL  ${name}: wanted $want, got $actual" -ForegroundColor Red
        $script:failed++
    } else { Write-Host "ok    $name" }
}

function Check-Value([string]$name, [string]$want, [string]$actual) {
    if ($actual -cne $want) {
        Write-Host "FAIL  ${name}: values differ" -ForegroundColor Red
        $script:failed++
    } else { Write-Host "ok    $name" }
}

$state = [pscustomobject]@{ lineage = 'lineage-a'; generation = 4; databaseHash = 'agreed' }
$same = [pscustomobject]@{ lineage = 'lineage-a'; generation = 4; databaseHash = 'agreed'; machine = 'home' }
$new = [pscustomobject]@{ lineage = 'lineage-a'; generation = 5; databaseHash = 'peer-new'; machine = 'home' }
$sameGenDifferent = [pscustomobject]@{ lineage = 'lineage-a'; generation = 4; databaseHash = 'other'; machine = 'home' }

Check 'nothing changed' 'none' $state 'agreed' $same
Check 'only local changed' 'publish' $state 'local-new' $same
Check 'only peer changed' 'restore' $state 'agreed' $new
Check 'both changed' 'diverged' $state 'local-new' $new
Check 'same generation, different hash' 'diverged' $state 'agreed' $sameGenDifferent
Check 'pCloud older' 'refuse' $state 'agreed' ([pscustomobject]@{ lineage='lineage-a'; generation=3; databaseHash='old'; machine='home' })
Check 'new home accepts primary seed' 'restore' $null 'anything' ([pscustomobject]@{ lineage='lineage-a'; generation=1; databaseHash='seed'; machine='work' }) 'home'
Check 'new primary refuses implicit seed' 'refuse' $null 'anything' ([pscustomobject]@{ lineage='lineage-a'; generation=1; databaseHash='seed'; machine='home' }) 'work'
Check 'new replica refuses non-primary seed' 'refuse' $null 'anything' ([pscustomobject]@{ lineage='lineage-a'; generation=1; databaseHash='seed'; machine='other' }) 'home'

$tablesOne = @(
    [pscustomobject]@{ table = 'students'; rows = 2; hash = 'student-hash' },
    [pscustomobject]@{ table = 'attendance'; rows = 5; hash = 'attendance-hash' }
)
$tablesReordered = @($tablesOne[1], $tablesOne[0])
$tablesChanged = @(
    [pscustomobject]@{ table = 'students'; rows = 2; hash = 'student-hash' },
    [pscustomobject]@{ table = 'attendance'; rows = 6; hash = 'changed-hash' }
)
$contentHash = Get-DatabaseContentFingerprint -TableSummary $tablesOne
Check-Value 'content hash ignores table query order' $contentHash (Get-DatabaseContentFingerprint -TableSummary $tablesReordered)
if ($contentHash -eq (Get-DatabaseContentFingerprint -TableSummary $tablesChanged)) {
    Write-Host 'FAIL  content hash notices row changes' -ForegroundColor Red
    $failed++
} else { Write-Host 'ok    content hash notices row changes' }

if ($failed) { Write-Host "$failed handoff test(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All database handoff decision tests passed.' -ForegroundColor Green
exit 0
