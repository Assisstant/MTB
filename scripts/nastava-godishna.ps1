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
    if ($n -eq 0) { return $m }
    if ($m -eq 0) { return $n }

    # Two rolling one-dimensional rows, not one two-dimensional array.
    #
    # `$d[$i - 1, $j]` reads as $i minus the ARRAY (1, $j) — the comma binds
    # tighter than the minus. Parenthesising each index repairs that in pwsh 7
    # and is a parse error in Windows PowerShell 5.1. And even plain variables,
    # `$d[$p, $j]`, fail to parse in 5.1 when they sit inside a method call,
    # where that comma reads as an argument separator. 5.1 is what
    # `powershell -File` runs, so the array with a comma in it simply goes.
    $prev = New-Object 'int[]' ($m + 1)
    $cur  = New-Object 'int[]' ($m + 1)
    for ($j = 0; $j -le $m; $j++) { $prev[$j] = $j }

    for ($i = 1; $i -le $n; $i++) {
        $cur[0] = $i
        $ai = $a[($i - 1)]
        for ($j = 1; $j -le $m; $j++) {
            $q = $j - 1
            $cost = 1
            if ($ai -eq $b[$q]) { $cost = 0 }
            $best = $prev[$j] + 1
            $left = $cur[$q] + 1
            if ($left -lt $best) { $best = $left }
            $diag = $prev[$q] + $cost
            if ($diag -lt $best) { $best = $diag }
            $cur[$j] = $best
        }
        for ($j = 0; $j -le $m; $j++) { $prev[$j] = $cur[$j] }
    }
    return $prev[$m]
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
# NOT $categories: PowerShell variable names are case-insensitive, so that
# would be the -Categories switch, and assigning an array to a SwitchParameter
# throws. The parser cannot see it; only running it can.
$catalogue   = @(Invoke-RestMethod -Uri "$BaseUrl/api/categories" -TimeoutSec 20)

# Somebody who worked here before but is not on this year's list is neither
# missing nor new: they are a candidate, with an id. Creating them again is
# refused — rightly — so they are brought back through the membership endpoint
# instead, which is the one whose whole job is which year somebody belongs to.
$roster = Invoke-RestMethod -Uri "$BaseUrl/api/roster?year=$([uri]::EscapeDataString($Year))" -TimeoutSec 20
$candTeacher = @{}
foreach ($c in $roster.candidates.teachers)   { $candTeacher[(Key $c.name)] = $c }
$candSpecial = @{}
foreach ($c in $roster.candidates.therapists) { $candSpecial[(Key $c.name)] = $c }

Write-Host "  во базата за оваа година: $($inDb.Count) наставници, $(@($plan.lessons).Count) часа, $($specialists.Count) во стручна служба"
Write-Host ''

# ── исто лице, друг правопис ────────────────────────────────────────────────
#
# Half of what looks like "missing from the database" is one letter. Adding
# those would make a duplicate of a person who is already there, and the
# duplicate would hold none of their hours — which is exactly the mistake the
# pupil roster made the first time.
#
# So the pairs are confirmed by hand in the local file, never guessed here, and
# everything below compares as if they had already been applied. The report
# then describes the state you are heading for instead of the mess you are in.
$renames = @($doc.renames)
$renameTo = @{}
foreach ($r in $renames) { if ($r.from -and $r.to) { $renameTo[(Key $r.from)] = [string]$r.to } }
function Effective([string] $name) {
    $to = $renameTo[(Key $name)]
    if ($to) { return $to }
    return $name
}

$byKey = @{}
foreach ($t in $inDb) { $byKey[(Key (Effective $t.name))] = $t }
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
    $p = $programmeKeys[(Key (Effective $t.name))]
    $hours = [int]$lessonsBy[[int]$t.id]
    if ($p -and $p.kind) { continue }                      # во настава е, покриено погоре
    $row = [pscustomobject]@{ Teacher = $t; Hours = $hours; Role = $(if ($p) { $p.role } else { $null }) }
    if ($p) { $notTeaching += $row } else { $unknown += $row }
}

$renamePlan = @()
foreach ($r in $renames) {
    $asTeacher   = @($inDb        | Where-Object { (Key $_.name) -eq (Key $r.from) })
    $asSpecialist= @($specialists | Where-Object { (Key $_.name) -eq (Key $r.from) })
    # A clash is only a clash inside the same directory. The same person can be
    # a teacher and hold a specialist profile; renaming their teacher row to a
    # name a THERAPIST already carries is not a merge, it is the two halves of
    # one person finally agreeing.
    $clashT = @($inDb        | Where-Object { (Key $_.name) -eq (Key $r.to) })
    $clashS = @($specialists | Where-Object { (Key $_.name) -eq (Key $r.to) })
    $renamePlan += [pscustomobject]@{
        From = $r.from; To = $r.to; Note = $r.note
        Teacher = $asTeacher[0]; Specialist = $asSpecialist[0]
        ClashTeacher = ($clashT.Count -gt 0); ClashSpecialist = ($clashS.Count -gt 0)
    }
}
if ($renamePlan.Count) {
    Write-Host "ИСТО ЛИЦЕ, ДРУГ ПРАВОПИС                    $($renamePlan.Count)" -ForegroundColor Cyan
    foreach ($r in $renamePlan) {
        $where = @()
        if ($r.Teacher)    { $where += 'наставник' }
        if ($r.Specialist) { $where += 'стручна служба' }
        if (-not $where.Count) { $where += 'НЕ Е НАЈДЕН' }
        Write-Host ("    {0,-28} → {1,-30} [{2}]" -f $r.From, $r.To, ($where -join ' + '))
        if ($r.Note) { Write-Host ("        $($r.Note)") -ForegroundColor DarkGray }
        if ($r.Teacher -and $r.ClashTeacher) {
            Write-Host ('        ВЕЌЕ ПОСТОИ наставник со новото име — нема да преименувам, тоа би било спојување') -ForegroundColor Red
        }
        if ($r.Specialist -and $r.ClashSpecialist) {
            Write-Host ('        ВЕЌЕ ПОСТОИ во стручна служба со новото име — нема да преименувам') -ForegroundColor Red
        }
    }
    Write-Host '    → сето долу е пресметано КАКО ДА се веќе направени' -ForegroundColor DarkGray
    Write-Host ''
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
    # These are the only names with nothing to check them against: everyone else
    # is confirmed by an existing row. A misread letter here becomes a person.
    Write-Host '    ⚠ овие ќе се СОЗДАДАТ со точно овој правопис — прочитај ги пред -Apply' -ForegroundColor Yellow
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
foreach ($t in $specialists) { $specByKey[(Key (Effective $t.name))] = $t }

$specSame = @(); $specAdd = @(); $specExtra = @()
foreach ($p in $wantedSpec) {
    if ($specByKey[(Key $p.name)]) { $specSame += $p } else { $specAdd += $p }
}
foreach ($t in $specialists) {
    $p = $programmeKeys[(Key (Effective $t.name))]
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
    return @($catalogue | Where-Object {
        $_.name -and ((Key $_.name) -eq (Key $tail) -or (Key $_.name).Contains((Key $tail)))
    } | Select-Object -First 1)
}

$catPlan = @()
foreach ($t in $specialists) {
    if ($t.categoryId) { continue }
    $p = $programmeKeys[(Key (Effective $t.name))]
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
$failed = 0

# ONE REFUSAL MUST NOT END THE RUN. The first version stopped dead on a single
# 409 and left nine people unentered, which reads as a broken script rather than
# as one row needing a decision. Same rule as the closing procedures in mtb.ps1:
# on the way out, everything runs and the failures are reported.
function Write-One {
    param([string] $What, [scriptblock] $Do)
    try {
        & $Do | Out-Null
        Write-Host ("  $What") -ForegroundColor Green
        $script:done++
    } catch {
        # Invoke-RestMethod puts the server's JSON body in ErrorDetails, and the
        # message there is the useful half.
        $msg = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
        if (-not $msg) { $msg = $_.Exception.Message }
        Write-Host ("  ПРОПАДНА  $What") -ForegroundColor Red
        Write-Host ("            " + ($msg -replace '\s+', ' ')) -ForegroundColor DarkGray
        $script:failed++
    }
}

function Post-Json([string] $Url, $Body, [string] $Method = 'Post') {
    Invoke-RestMethod -Uri $Url -Method $Method -Body ($Body | ConvertTo-Json -Depth 5) `
        -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
}

# First, so nothing below can add a second copy of somebody already here under
# one letter of difference.
foreach ($r in $renamePlan) {
    if ($r.Teacher -and -not $r.ClashTeacher) {
        $id = $r.Teacher.id; $to = $r.To; $from = $r.From
        Write-One "преименуван $from → $to   (наставник)" { Post-Json "$BaseUrl/api/teaching/teacher/$id" @{ name = $to } 'Put' }
    }
    if ($r.Specialist -and -not $r.ClashSpecialist) {
        $to = $r.To; $from = $r.From
        Write-One "преименуван $from → $to   (стручна служба)" { Post-Json "$BaseUrl/api/therapists/$([uri]::EscapeDataString($from))" @{ name = $to } 'Patch' }
    }
}

foreach ($f in $fix) {
    $id = $f.Teacher.id; $k = $f.Want.kind; $sub = $f.Want.subject; $n = $f.Teacher.name
    Write-One "поправено   $n" { Post-Json "$BaseUrl/api/teaching/teacher/$id" @{ kind = $k; subject = $sub } 'Put' }
}

foreach ($a in $add) {
    $cand = $candTeacher[(Key $a.name)]
    $n = $a.name; $k = $a.kind; $sub = $a.subject
    if ($cand) {
        $cid = [int]$cand.id
        Write-One "вратен      $n   (беше на списокот порано)" {
            Post-Json "$BaseUrl/api/roster/memberships" @{ year = $Year; entity = 'teacher'; active = $true; members = @(@{ id = $cid }) } 'Put'
        }
    } else {
        Write-One "додаден     $n" { Post-Json "$BaseUrl/api/teaching/teacher" @{ name = $n; kind = $k; subject = $sub; year = $Year } }
    }
}

foreach ($a in $specAdd) {
    $cand = $candSpecial[(Key $a.name)]
    $n = $a.name
    if ($cand) {
        $cid = [int]$cand.id
        Write-One "вратен      $n   (стручна служба, беше порано)" {
            Post-Json "$BaseUrl/api/roster/memberships" @{ year = $Year; entity = 'therapist'; active = $true; members = @(@{ id = $cid }) } 'Put'
        }
    } else {
        Write-One "внесен      $n   (стручна служба)" { Post-Json "$BaseUrl/api/therapists" @{ name = $n; year = $Year } }
    }
}

if ($Categories -and $catPlan.Count) {
    foreach ($c in $catPlan) {
        $pid = [int]$c.Person.personId; $cid = [int]$c.Category.id
        $n = $c.Person.name; $cn = $c.Category.name
        Write-One "категорија  $n → $cn" {
            Post-Json "$BaseUrl/api/categories/holder" @{ year = $Year; kind = 'therapist'; personId = $pid; categoryId = $cid } 'Put'
        }
    }
} elseif ($catPlan.Count) {
    Write-Host "  ($($catPlan.Count) категории се прескокнати — додај -Categories)" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "$done промени запишани. Освежи ги страниците Настава и Податоци." -ForegroundColor Cyan
if ($failed) { Write-Host "$failed не поминаа — прочитај ги црвените редови погоре." -ForegroundColor Red }
if ($keep.Count -or $unknown.Count) {
    Write-Host "Останаа $($keep.Count + $unknown.Count) за одлука — види погоре." -ForegroundColor Yellow
}
Write-Host ''
try { Stop-Transcript | Out-Null } catch { }
