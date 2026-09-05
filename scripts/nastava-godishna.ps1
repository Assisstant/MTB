# Bring the teaching staff for one school year in line with the annual programme.
#
#   powershell -ExecutionPolicy Bypass -File scripts\nastava-godishna.ps1
#   ... -Apply            писмено, откако ќе го прочиташ извештајот
#   ... -Year '2025/2026' -Data <пат>
#
# THIS FILE HOLDS NO NAMES. The programme's list lives in
# scripts\roster-nastava-<година>.local.json, which .gitignore covers and
# .githooks\pre-commit refuses — same arrangement as the pupil roster, and for
# the same reason: this repository is public.
#
# WHAT IT WILL AND WILL NOT DO
#
# The annual programme says who does настава. Everyone else in it is a стручен
# соработник and belongs in Кабинети, not in the timetable. So the comparison is
# straightforward — but one direction of it is not safe to automate.
#
# Adding a teacher, and correcting a kind or a subject, are reversible and
# affect nothing else. Those apply.
#
# Taking somebody OFF this year's teaching list is not the same size of act.
# `PUT /api/roster/memberships` with active=false removes them from the year
# only and deletes no person and no lesson — but the lessons they hold stay in
# the timetable pointing at somebody no longer on the list. So this retires only
# those holding ZERO lessons this year. Anyone with hours is reported, with the
# count, and left alone: their hours have to go somewhere first, and deciding
# where is not a script's judgement.
#
# The programme is a snapshot with a date on it. Somebody hired after it is not
# an error, they are simply not in it — which is why the report separates "the
# programme says they are not a teacher" from "the programme has never heard of
# them", and prints the nearest spellings for the second, because Ѓеоргиевска
# and Георгиевска are one keystroke apart and not the same key.

param(
    [string] $Year = '2026/2027',
    [string] $BaseUrl = 'http://127.0.0.1:3000',
    [string] $Data,
    [switch] $Apply,
    [switch] $Categories
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Data) {
    $slug = ($Year -replace '/', '-')
    $Data = Join-Path $repoRoot ("scripts\roster-nastava-$slug.local.json")
}
if (-not (Test-Path $Data)) {
    Write-Host "Не ја наоѓам локалната датотека: $Data" -ForegroundColor Red
    Write-Host 'Таа ги носи имињата од годишната програма и намерно не е во Git.'
    exit 1
}

# The report names people, so it goes to backups\ — gitignored, like every
# other place real data is allowed to land. It is also how the report can be
# read back later instead of being scrolled past once.
try {
    $logDir = Join-Path $repoRoot 'backups'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Transcript -Path (Join-Path $logDir 'nastava-godishna.log') -Force | Out-Null
} catch { }

function Key([string] $name) {
    # One key per person, whichever screen typed it. Dots and double spaces are
    # typography, not identity.
    return ((($name -replace '\.', ' ') -replace '\s+', ' ').Trim()).ToLower([Globalization.CultureInfo]::GetCultureInfo('mk-MK'))
}

function Distance([string] $a, [string] $b) {
    $n = $a.Length; $m = $b.Length
    if ($n -eq 0) { return $m }; if ($m -eq 0) { return $n }
    $d = New-Object 'int[,]' ($n + 1), ($m + 1)
    for ($i = 0; $i -le $n; $i++) { $d[$i, 0] = $i }
    for ($j = 0; $j -le $m; $j++) { $d[0, $j] = $j }
    for ($i = 1; $i -le $n; $i++) {
        for ($j = 1; $j -le $m; $j++) {
            # Each index in its own brackets: in `$d[$i - 1, $j]` the comma binds
            # tighter than the minus, so PowerShell reads it as $i minus the
            # ARRAY (1, $j) and fails with op_Subtraction on Object[].
            $cost = if ($a[($i - 1)] -eq $b[($j - 1)]) { 0 } else { 1 }
            $d[$i, $j] = [Math]::Min(
                [Math]::Min($d[($i - 1), $j] + 1, $d[$i, ($j - 1)] + 1),
                $d[($i - 1), ($j - 1)] + $cost)
        }
    }
    return $d[$n, $m]
}

function Near([string] $name, $pool) {
    $k = Key $name
    return @($pool | ForEach-Object {
        [pscustomobject]@{ Name = $_; D = (Distance $k (Key $_)) }
    } | Where-Object { $_.D -le 4 } | Sort-Object D | Select-Object -First 2)
}

$doc = Get-Content $Data -Raw -Encoding UTF8 | ConvertFrom-Json
$programme = @($doc.staff)
$wanted = @($programme | Where-Object { $_.kind })          # само оние во настава

Write-Host ''
Write-Host "Годишна програма → база     $Year" -ForegroundColor Cyan
Write-Host "  извор: $($doc.source)"
Write-Host "  во програмата: $($programme.Count) вработени, од нив $($wanted.Count) во настава"
if (-not $Apply) { Write-Host '  ПРОБНО ПУШТАЊЕ — ништо не се запишува. Додај -Apply.' -ForegroundColor Yellow }
Write-Host ''

$plan = Invoke-RestMethod -Uri "$BaseUrl/api/teaching/timetable?year=$([uri]::EscapeDataString($Year))" -TimeoutSec 20
$inDb = @($plan.teachers)
$lessonsBy = @{}
foreach ($l in $plan.lessons) {
    if ($null -ne $l.teacher_id) { $lessonsBy[[int]$l.teacher_id] = 1 + ($lessonsBy[[int]$l.teacher_id]) }
}
$holders = Invoke-RestMethod -Uri "$BaseUrl/api/categories/holders?year=$([uri]::EscapeDataString($Year))" -TimeoutSec 20
$specialists = @($holders.therapists | Where-Object { $_.active })
$categories  = @(Invoke-RestMethod -Uri "$BaseUrl/api/categories" -TimeoutSec 20)

Write-Host "  во базата за оваа година: $($inDb.Count) наставници, $(@($plan.lessons).Count) часа, $($specialists.Count) во стручна служба"
Write-Host ''

$byKey = @{}
foreach ($t in $inDb) { $byKey[(Key $t.name)] = $t }
$programmeKeys = @{}
foreach ($p in $programme) { $programmeKeys[(Key $p.name)] = $p }

$same = @(); $fix = @(); $add = @(); $notTeaching = @(); $unknown = @()

foreach ($p in $wanted) {
    $t = $byKey[(Key $p.name)]
    if (-not $t) { $add += $p; continue }
    $wantSubject = if ($p.subject) { [string]$p.subject } else { $null }
    $haveSubject = if ($t.subject) { [string]$t.subject } else { $null }
    if ($t.kind -ne $p.kind -or $haveSubject -ne $wantSubject) {
        $fix += [pscustomobject]@{ Teacher = $t; Want = $p }
    } else { $same += $p }
}

foreach ($t in $inDb) {
    $p = $programmeKeys[(Key $t.name)]
    $hours = [int]$lessonsBy[[int]$t.id]
    if ($p -and $p.kind) { continue }                      # во настава е, покриено погоре
    $row = [pscustomobject]@{ Teacher = $t; Hours = $hours; Role = $(if ($p) { $p.role } else { $null }) }
    if ($p) { $notTeaching += $row } else { $unknown += $row }
}

Write-Host "СОВПАЃААТ                                   $($same.Count)" -ForegroundColor Green
Write-Host ''

if ($fix.Count) {
    Write-Host "ВИД ИЛИ ПРЕДМЕТ ТРЕБА ИЗМЕНА                $($fix.Count)" -ForegroundColor Yellow
    foreach ($f in $fix) {
        $from = "$($f.Teacher.kind)$(if ($f.Teacher.subject) { " · $($f.Teacher.subject)" })"
        $to   = "$($f.Want.kind)$(if ($f.Want.subject) { " · $($f.Want.subject)" })"
        Write-Host ("    {0,-32} {1}  →  {2}" -f $f.Teacher.name, $from, $to)
    }
    Write-Host ''
}

if ($add.Count) {
    Write-Host "ВО ПРОГРАМАТА СЕ, ВО БАЗАТА ГИ НЕМА         $($add.Count)" -ForegroundColor Yellow
    foreach ($a in $add) {
        Write-Host ("    {0,-32} {1}{2}" -f $a.name, $a.kind, $(if ($a.subject) { " · $($a.subject)" }))
        foreach ($n in (Near $a.name ($inDb | ForEach-Object { $_.name }))) {
            Write-Host ("        личи на: {0}  (разлика {1})" -f $n.Name, $n.D) -ForegroundColor DarkGray
        }
    }
    Write-Host ''
}

$retire = @($notTeaching | Where-Object { $_.Hours -eq 0 })
$keep   = @($notTeaching | Where-Object { $_.Hours -gt 0 })

if ($retire.Count) {
    Write-Host "ПРОГРАМАТА ВЕЛИ ДЕКА НЕ СЕ ВО НАСТАВА, БЕЗ ЧАСОВИ   $($retire.Count)" -ForegroundColor Yellow
    foreach ($r in $retire) { Write-Host ("    {0,-32} {1}" -f $r.Teacher.name, $r.Role) }
    Write-Host '    → се вадат од листата за оваа година; лицето и минатите години остануваат' -ForegroundColor DarkGray
    Write-Host ''
}
if ($keep.Count) {
    Write-Host "ПРОГРАМАТА ВЕЛИ ДЕКА НЕ СЕ ВО НАСТАВА, НО ИМААТ ЧАСОВИ   $($keep.Count)" -ForegroundColor Red
    foreach ($k in $keep) { Write-Host ("    {0,-32} {1} часа   {2}" -f $k.Teacher.name, $k.Hours, $k.Role) }
    Write-Host '    → НЕ ги вадам. Прво часовите мора да одат кај некој друг.' -ForegroundColor DarkGray
    Write-Host ''
}
if ($unknown.Count) {
    Write-Host "ВО БАЗАТА СЕ, ВО ПРОГРАМАТА ВООПШТО ГИ НЕМА   $($unknown.Count)" -ForegroundColor Red
    foreach ($u in $unknown) {
        Write-Host ("    {0,-32} {1} часа" -f $u.Teacher.name, $u.Hours)
        foreach ($n in (Near $u.Teacher.name ($programme | ForEach-Object { $_.name }))) {
            Write-Host ("        во програмата личи на: {0}  (разлика {1})" -f $n.Name, $n.D) -ForegroundColor DarkGray
        }
    }
    Write-Host '    → или се вработени по 04.08.2026, или името се пишува поинаку. Прашање, не грешка.' -ForegroundColor DarkGray
    Write-Host ''
}

# ── стручна служба ──────────────────────────────────────────────────────────
#
# `therapists` is not "somebody with a room" — migration 024 says the concept is
# the KIND of specialist, and a teacher may hold one without a room at all. So a
# педагог with no schedule slots is an ordinary row here: they never appear in
# Распоред because they have no slots, not because they are missing.
#
# Entering them is not tidiness. `check:names` builds its blocklist from
# students, teachers and therapists, so a specialist in none of the three is a
# real name the pre-commit hook cannot protect.

$wantedSpec = @($programme | Where-Object { -not $_.kind })
$specByKey = @{}
foreach ($t in $specialists) { $specByKey[(Key $t.name)] = $t }

$specSame = @(); $specAdd = @(); $specExtra = @()
foreach ($p in $wantedSpec) {
    if ($specByKey[(Key $p.name)]) { $specSame += $p } else { $specAdd += $p }
}
foreach ($t in $specialists) {
    $p = $programmeKeys[(Key $t.name)]
    if ($p -and -not $p.kind) { continue }
    $specExtra += [pscustomobject]@{ Person = $t; Programme = $p }
}

Write-Host 'СТРУЧНА СЛУЖБА' -ForegroundColor Cyan
Write-Host "  веќе ги има                               $($specSame.Count)" -ForegroundColor Green
if ($specAdd.Count) {
    Write-Host "  ВО ПРОГРАМАТА СЕ, ВО БАЗАТА ГИ НЕМА       $($specAdd.Count)" -ForegroundColor Yellow
    foreach ($a in $specAdd) {
        Write-Host ("    {0,-32} {1}" -f $a.name, $a.role)
        foreach ($n in (Near $a.name ($specialists | ForEach-Object { $_.name }))) {
            Write-Host ("        личи на: {0}  (разлика {1})" -f $n.Name, $n.D) -ForegroundColor DarkGray
        }
    }
}
if ($specExtra.Count) {
    Write-Host "  ВО БАЗАТА СЕ, ВО ПРОГРАМАТА НЕ СЕ СТРУЧНА СЛУЖБА   $($specExtra.Count)" -ForegroundColor Yellow
    foreach ($e in $specExtra) {
        $why = if ($e.Programme) { "програмата вели: $($e.Programme.role)" } else { 'воопшто го нема во програмата' }
        Write-Host ("    {0,-32} {1}" -f $e.Person.name, $why)
    }
    Write-Host '    → некој може да е и наставник и да држи категорија. Прашање, не грешка.' -ForegroundColor DarkGray
}
Write-Host ''

# Предложена категорија: последниот дел од работното место („…-психолог"),
# спарен со вистинската листа на категории од серверот. Само предлог — да се
# запише бара -Categories, зашто категоријата решава што смее човекот да пишува
# во евидентниот лист, а тоа е потешко од ред во именик.
function SuggestCategory([string] $role) {
    if (-not $role) { return $null }
    # The bracket comes off FIRST. „Стручен соработник-дефектолог
    # (наставник-ментор)" has a hyphen inside the bracket too, so splitting
    # before stripping leaves „ментор)" as the profession.
    $clean = ($role -replace '\(.*?\)', '').Trim()
    $tail = ($clean -split '-')[-1].Trim()
    if (-not $tail) { return $null }
    return @($categories | Where-Object {
        $_.name -and ((Key $_.name) -eq (Key $tail) -or (Key $_.name).Contains((Key $tail)))
    } | Select-Object -First 1)
}

$catPlan = @()
foreach ($t in $specialists) {
    if ($t.categoryId) { continue }
    $p = $programmeKeys[(Key $t.name)]
    if (-not $p) { continue }
    $c = SuggestCategory $p.role
    if ($c) { $catPlan += [pscustomobject]@{ Person = $t; Category = $c; Role = $p.role } }
}
if ($catPlan.Count) {
    Write-Host "БЕЗ КАТЕГОРИЈА, А ПРОГРАМАТА ЈА КАЖУВА     $($catPlan.Count)" -ForegroundColor Yellow
    foreach ($c in $catPlan) { Write-Host ("    {0,-32} → {1}" -f $c.Person.name, $c.Category.name) }
    Write-Host '    → се запишува само со -Categories; категоријата решава што смее да пишува' -ForegroundColor DarkGray
    Write-Host ''
}

if (-not $Apply) {
    Write-Host 'Ништо не е запишано. Прочитај го горното, па додај -Apply.' -ForegroundColor Cyan
    Write-Host ''
    try { Stop-Transcript | Out-Null } catch { }
    exit 0
}

$done = 0
foreach ($f in $fix) {
    $body = @{ kind = $f.Want.kind; subject = $f.Want.subject } | ConvertTo-Json
    Invoke-RestMethod -Uri "$BaseUrl/api/teaching/teacher/$($f.Teacher.id)" -Method Put -Body $body -ContentType 'application/json; charset=utf-8' | Out-Null
    Write-Host ("  поправено  {0}" -f $f.Teacher.name) -ForegroundColor Green; $done++
}
foreach ($a in $add) {
    $body = @{ name = $a.name; kind = $a.kind; subject = $a.subject; year = $Year } | ConvertTo-Json
    Invoke-RestMethod -Uri "$BaseUrl/api/teaching/teacher" -Method Post -Body $body -ContentType 'application/json; charset=utf-8' | Out-Null
    Write-Host ("  додадено   {0}" -f $a.name) -ForegroundColor Green; $done++
}
if ($retire.Count) {
    $body = @{
        year = $Year; entity = 'teacher'; active = $false
        members = @($retire | ForEach-Object { @{ id = [int]$_.Teacher.id } })
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "$BaseUrl/api/roster/memberships" -Method Put -Body $body -ContentType 'application/json; charset=utf-8' | Out-Null
    foreach ($r in $retire) { Write-Host ("  извадено   {0}" -f $r.Teacher.name) -ForegroundColor Green; $done++ }
}

foreach ($a in $specAdd) {
    $body = @{ name = $a.name; year = $Year } | ConvertTo-Json
    Invoke-RestMethod -Uri "$BaseUrl/api/therapists" -Method Post -Body $body -ContentType 'application/json; charset=utf-8' | Out-Null
    Write-Host ("  внесен     {0}   (стручна служба)" -f $a.name) -ForegroundColor Green; $done++
}
if ($Categories -and $catPlan.Count) {
    foreach ($c in $catPlan) {
        $body = @{ year = $Year; kind = 'therapist'; personId = [int]$c.Person.personId; categoryId = [int]$c.Category.id } | ConvertTo-Json
        Invoke-RestMethod -Uri "$BaseUrl/api/categories/holder" -Method Put -Body $body -ContentType 'application/json; charset=utf-8' | Out-Null
        Write-Host ("  категорија {0} → {1}" -f $c.Person.name, $c.Category.name) -ForegroundColor Green; $done++
    }
} elseif ($catPlan.Count) {
    Write-Host "  ($($catPlan.Count) категории се прескокнати — додај -Categories)" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "$done промени запишани. Освежи ги страниците Настава и Податоци." -ForegroundColor Cyan
if ($keep.Count -or $unknown.Count) {
    Write-Host "Останаа $($keep.Count + $unknown.Count) за одлука — види погоре." -ForegroundColor Yellow
}
Write-Host ''
try { Stop-Transcript | Out-Null } catch { }
