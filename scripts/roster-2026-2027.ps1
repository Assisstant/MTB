<#
  roster-2026-2027.ps1
  Applies locally prepared corrections for the 2026/2027 roster through the
  row-level API. The corrections live in an ignored .local.json file because
  names and enrolment decisions must never enter this public repository.

  WHY A SCRIPT AND NOT TYPING IT TWICE.  The same corrections have to land in
  two databases, home and work, and typing them twice is how the two drift.
  Run this against each server and both end up saying the same thing.

  WHY THROUGH THE API AND NOT psql.  `POST /api/students` computes public_id
  from the name exactly as the app does, refuses to re-enrol an archived child,
  and `PATCH` refuses a rename if somebody already changed that name elsewhere.
  Writing the rows by hand would skip all three.

  WRITTEN WITH A UTF-8 BOM.  Windows PowerShell 5.1 reads a .ps1 as ANSI without
  one, and every Cyrillic name in here turns to mojibake before the parser even
  starts.  Every other script in this folder carries the BOM for the same reason.

  SAFE BY DEFAULT.  With no -Apply it changes nothing and only reports.

    powershell -ExecutionPolicy Bypass -File scripts\roster-2026-2027.ps1
    powershell -ExecutionPolicy Bypass -File scripts\roster-2026-2027.ps1 -Apply

  Copy roster-2026-2027.example.json to roster-2026-2027.local.json and fill
  the private copy locally. The example is never used automatically.
#>
param(
    [string]$Server = 'http://localhost:3000',
    [string]$DataFile = (Join-Path $PSScriptRoot 'roster-2026-2027.local.json'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

function Get-Roster {
    Invoke-RestMethod -Uri "$Server/api/students" -Method Get
}

function Why-Failed($err) {
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
    return $err.Exception.Message
}

function Send-Json($method, $path, $obj) {
    $json  = $obj | ConvertTo-Json -Depth 5 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "$Server$path" -Method $method -Body $bytes `
        -ContentType 'application/json; charset=utf-8'
}

# ── matching ────────────────────────────────────────────────────────────────
# Some older database names carry a hand-typed marker from before `kind`
# existed as a field. Compare without that marker and preserve it on rename;
# the correction changes the name, not a separate status fact.
function Bare($n) {
    $t = $n -replace '\s*\([^)]*\)\s*$', ''
    return ($t -replace '\s+', ' ').Trim()
}
function Key($n)    { return (Bare $n).ToLower() }
function Marker($n) {
    if ($n -match '(\s*\([^)]*\))\s*$') { return $Matches[1] }
    return ''
}

# When a name is nowhere, say what IS there rather than just "not found" --
# a near miss is almost always a spelling nobody has seen written down twice.
function Near($wanted, $roster) {
    $w = Bare $wanted
    $parts = $w.Split(' ')
    $head = $parts[0]; $tail = $parts[-1]
    $hit = @()
    foreach ($r in $roster) {
        $b = Bare $r.name
        $p = $b.Split(' ')
        $ok = $false
        if ($p[0].Length -ge 3 -and $head.Length -ge 3 -and $p[0].Substring(0,3) -eq $head.Substring(0,3)) { $ok = $true }
        if ($p[-1].Length -ge 3 -and $tail.Length -ge 3 -and $p[-1].Substring(0,3) -eq $tail.Substring(0,3)) { $ok = $true }
        if ($ok) { $hit += $r.name }
    }
    return $hit
}

# ── private decisions ───────────────────────────────────────────────────────
# This file contains the names and the meeting's decisions. It is deliberately
# ignored by Git. `-Encoding UTF8` is explicit so Windows PowerShell 5.1 does
# not interpret Cyrillic through the machine's ANSI code page.
if (-not (Test-Path -LiteralPath $DataFile -PathType Leaf)) {
    throw "Private roster data file not found: $DataFile. Copy scripts\roster-2026-2027.example.json to scripts\roster-2026-2027.local.json and fill the local copy."
}
try {
    $private = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "Private roster data file is not valid UTF-8 JSON: $DataFile. $($_.Exception.Message)"
}

$EXTERNAL_MARK = if ($null -ne $private.externalMark) { [string]$private.externalMark } else { ' (над.)' }
$renames = @($private.renames)
$regrades = @($private.regrades)
$additions = @($private.additions)
$removals = @($private.removals)
$decide = @($private.decide)

if ([int]$private.schemaVersion -ne 1) {
    throw 'Private roster data must declare schemaVersion 1.'
}
if ([string]$private.schoolYear -ne '2026/2027') {
    throw 'This script accepts only a private plan for school year 2026/2027.'
}
foreach ($r in $renames) {
    if ([string]::IsNullOrWhiteSpace($r.from) -or [string]::IsNullOrWhiteSpace($r.to)) {
        throw 'Every rename needs nonblank from and to values.'
    }
}
foreach ($g in $regrades) {
    if ([string]::IsNullOrWhiteSpace($g.name) -or [string]::IsNullOrWhiteSpace($g.grade)) {
        throw 'Every regrade needs nonblank name and grade values.'
    }
}
foreach ($a in $additions) {
    if ([string]::IsNullOrWhiteSpace($a.name) -or $a.kind -notin @('internal', 'external')) {
        throw 'Every addition needs a name and kind internal or external.'
    }
}
foreach ($x in $removals) {
    if ([string]::IsNullOrWhiteSpace($x.name)) { throw 'Every removal needs a nonblank name.' }
}

# All validation and the year check happen before the first possible write.
$serverRoster = Invoke-RestMethod -Uri "$Server/api/roster" -Method Get
$year = [string]$serverRoster.year
if ($year -ne [string]$private.schoolYear) {
    throw "Server current year is '$year', but the private roster plan is for '$($private.schoolYear)'. Nothing was changed."
}

# ── run ─────────────────────────────────────────────────────────────────────
Write-Host "Server: $Server" -ForegroundColor Cyan
if (-not $Apply) { Write-Host "DRY RUN -- nothing will be changed. Add -Apply to write." -ForegroundColor Yellow }
Write-Host ""

$roster = Get-Roster
$byName = @{}
foreach ($s in $roster) { $byName[(Key $s.name)] = $s }

Write-Host "── renames ──" -ForegroundColor White
foreach ($r in $renames) {
    $cur = $byName[(Key $r.from)]
    if (-not $cur) {
        if ($byName[(Key $r.to)]) { Write-Host "  done already: $($r.to)" -ForegroundColor DarkGray }
        else {
            Write-Host "  NOT FOUND: '$($r.from)' -- neither name is in this database" -ForegroundColor Red
            $near = @(Near $r.from $roster)
            if ($near.Count) { Write-Host "             nearest in the database: $($near -join ' | ')" -ForegroundColor Yellow }
        }
        continue
    }
    $newName = $r.to + (Marker $cur.name)
    Write-Host "  $($cur.name)  ->  $newName   ($($r.why))"
    if ($Apply) {
        try {
            Send-Json PATCH "/api/students/$([uri]::EscapeDataString($cur.public_id))" `
                @{ name = $newName; expected = $cur.name } | Out-Null
            Write-Host "    renamed" -ForegroundColor Green
        } catch { Write-Host "    REFUSED: $(Why-Failed $_)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "── grades ──" -ForegroundColor White
foreach ($g in $regrades) {
    $cur = $byName[(Key $g.name)]
    if (-not $cur) { Write-Host "  NOT FOUND: $($g.name)" -ForegroundColor Red; continue }
    if ($cur.grade -eq $g.grade) { Write-Host "  done already: $($g.name) · $($g.grade)" -ForegroundColor DarkGray; continue }
    Write-Host "  $($g.name): $($cur.grade)  ->  $($g.grade)   ($($g.why))"
    if ($Apply) {
        try {
            Send-Json PATCH "/api/students/$([uri]::EscapeDataString($cur.public_id))" `
                @{ grade = $g.grade } | Out-Null
            Write-Host "    changed" -ForegroundColor Green
        } catch { Write-Host "    REFUSED: $(Why-Failed $_)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "── additions ──" -ForegroundColor White
foreach ($a in $additions) {
    $have = $byName[(Key $a.name)]
    if ($have) {
        # Added before this script learned the convention -- or by hand. Finish
        # the job rather than reporting done on something that is not.
        if ($a.kind -eq 'external' -and (Marker $have.name) -eq '') {
            $fixed = $have.name + $EXTERNAL_MARK
            Write-Host "  $($have.name)  ->  $fixed   (external, marker missing)"
            if ($Apply) {
                try {
                    Send-Json PATCH "/api/students/$([uri]::EscapeDataString($have.public_id))" `
                        @{ name = $fixed; expected = $have.name } | Out-Null
                    Write-Host "    marked" -ForegroundColor Green
                } catch { Write-Host "    REFUSED: $(Why-Failed $_)" -ForegroundColor Red }
            }
        } else {
            Write-Host "  done already: $($have.name)" -ForegroundColor DarkGray
        }
        continue
    }
    $shown = $a.kind
    if ($a.grade) { $shown = $shown + ' · ' + $a.grade }
    $addName = $a.name
    if ($a.kind -eq 'external') { $addName = $a.name + $EXTERNAL_MARK }
    Write-Host "  + $addName  ($shown)   ($($a.why))"
    if ($Apply) {
        try {
            $body = @{ name = $addName; kind = $a.kind }
            if ($a.grade) { $body.grade = $a.grade }
            Send-Json POST '/api/students' $body | Out-Null
            Write-Host "    added" -ForegroundColor Green
        } catch { Write-Host "    REFUSED: $(Why-Failed $_)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "── off this year's list (reversible) ──" -ForegroundColor White
$roster2 = Get-Roster
foreach ($x in $removals) {
    $cur = $null
    foreach ($s2 in $roster2) { if ((Key $s2.name) -eq (Key $x.name)) { $cur = $s2 } }
    if (-not $cur) {
        Write-Host "  done already / not here: $($x.name)" -ForegroundColor DarkGray
        $near = @(Near $x.name $roster2)
        if ($near.Count) { Write-Host "             nearest in the database: $($near -join ' | ')" -ForegroundColor Yellow }
        continue
    }
    Write-Host "  - $($cur.name) off $year   ($($x.why))"
    if ($Apply) {
        try {
            Send-Json PUT '/api/roster/memberships' `
                @{ year = $year; entity = 'student'; active = $false; members = @(@{ id = $cur.public_id }) } | Out-Null
            Write-Host "    taken off $year -- still in the directory, send true to put back" -ForegroundColor Green
        } catch { Write-Host "    REFUSED: $(Why-Failed $_)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "── needs a decision, not a script ──" -ForegroundColor Magenta
foreach ($d in $decide) { Write-Host "  * $d" }
Write-Host ""
if (-not $Apply) { Write-Host "Nothing was changed. Re-run with -Apply when the list above reads right." -ForegroundColor Yellow }
