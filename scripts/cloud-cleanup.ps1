# Облак: старите recovery шеми — архивирај ги локално, па тргни ги од Supabase.
#
# ЗОШТО ПОСТОИ. Секоја група миграции остава во облакот приватна шема
# `mtb_workspace_recovery_…` со цела копија од сите табели како што биле пред
# неа (server/src/lib/workspace-release.ts). Тоа е вистинска заштита — за
# ТАА миграција. Откако следните миграции поминале, таа копија е состојба од
# пред неколку недели што никој нема да ја враќа, а стои во живата база и се
# брои во нејзиниот простор. Шемите никогаш не се бришеа, па се собираа.
#
# ШТО ПРАВИ. Ги покажува сите со големина. Најновите $Keep остануваат во
# облакот. Постарите прво се преземаат во ЕДНА датотека во backups\
# (pg_dump, само тие шеми). Потоа архивата се ДОКАЖУВА:
#
#   1. ВРАЌАЊЕ. Архивата се враќа во локалната база на оваа машина, во истите
#      приватни шеми (кои таму не постојат). Список на содржината на архивата
#      (`pg_restore --list`) не е доказ — тој го чита само нејзиниот индекс, а
#      не дали податоците навистина можат да се вратат.
#   2. СПОРЕДБА. За секоја табела од секоја шема се споредува бројот на
#      редови и отпечаток од содржината, вратеното наспроти она во облакот.
#   3. Привремените шеми се тргаат од локалната база, што и да се случи.
#
# Дури кога секоја табела е иста, шемите се бришат од облакот — во една
# трансакција. Една разлика значи дека од облакот не се брише ништо.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1          покажува, прашува
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1 -List    само покажува
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1 -Apply   без прашање
#
# Брише САМО шеми со тоа име. Табелите на апликацијата (public) не ги допира,
# ниту во облакот ниту локално.
#
# -RehearseOn <адреса> е проба: наместо облакот се зема таа база (на пример
# локалната копија за читање). Целата постапка е иста, па се гледа дека
# работи пред да се пушти врз облакот.
param(
    [ValidateRange(1, 100)]
    [int]$Keep = 3,
    [switch]$List,
    [switch]$Apply,
    [string]$EnvFile = '',
    [string]$CheckUrl = '',       # where the archive is restored to be compared; default: this machine's database
    [string]$RehearseOn = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$quiet = $Apply -or $List
$NAME = '^mtb_workspace_recovery_[a-z0-9_]+$'

function Stop-WithMessage([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Red
    if (-not $quiet) { Read-Host 'Enter за затворање' | Out-Null }
    exit 1
}
function Close-Window([int]$Code = 0) {
    if (-not $quiet) { Read-Host 'Enter за затворање' | Out-Null }
    exit $Code
}

. (Join-Path $PSScriptRoot 'cloud-lib.ps1')
try {
    if ($RehearseOn) {
        $tools = Get-MtbPostgresTools
        $cloud = [pscustomobject]@{ Url = $RehearseOn; Host = 'ПРОБА — ова не е облакот'; PgDump = $tools.PgDump; Psql = $tools.Psql; PgRestore = $tools.PgRestore }
    } else {
        $cloud = Get-MtbCloud -Repo $repo -EnvFile $EnvFile
    }
    if (-not $CheckUrl) { $CheckUrl = Get-MtbLocalUrl -Repo $repo }
} catch { Stop-WithMessage $_.Exception.Message }
if ($CheckUrl -eq $cloud.Url) { Stop-WithMessage 'Архивата не може да се провери во истата база од која е земена.' }
# to_jsonb пишува време според зоната на сесијата: и двете страни во иста.
$env:PGTZ = 'UTC'

Write-Host ''
Write-Host 'MTB · стари recovery копии во облакот (Supabase)' -ForegroundColor Cyan
Write-Host ('  ' + $cloud.Host)

# A native tool's stderr must not throw under 'Stop' (see CLAUDE.md), and its
# output goes to a file so a Cyrillic line is never decoded by the console.
function Invoke-Sql([string]$Url, [string]$Sql) {
    $out = [IO.Path]::GetTempFileName()
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $errors = & $cloud.Psql $Url -X -At -F '|' -v ON_ERROR_STOP=1 -o $out -c $Sql 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $rows = @(Get-Content -LiteralPath $out -Encoding UTF8 | Where-Object { $_ })
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { throw ((@($errors | ForEach-Object { "$_" }) -join "`n").Trim()) }
    return $rows
}

# In the order they were made: a schema's oid only grows.
$sql = @'
SELECT n.nspname,
       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'r'),
       coalesce((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'r'), 0)
  FROM pg_namespace n
 WHERE n.nspname ~ '^mtb_workspace_recovery_[a-z0-9_]+$'
 ORDER BY n.oid
'@
try { $rows = Invoke-Sql $cloud.Url $sql } catch { Stop-WithMessage ("Не можам да го прочитам облакот:`n" + $_.Exception.Message) }

$schemas = @($rows | ForEach-Object {
    $p = $_.Split('|')
    [pscustomobject]@{ Name = $p[0]; Tables = [int]$p[1]; Bytes = [int64]$p[2] }
})
if (-not $schemas.Count) {
    Write-Host ''
    Write-Host '  Нема recovery шеми во облакот.' -ForegroundColor Green
    Close-Window
}

$keepFrom = [Math]::Max(0, $schemas.Count - $Keep)
$old = @($schemas | Select-Object -First $keepFrom)
$stay = @($schemas | Select-Object -Skip $keepFrom)
$mb = { param($bytes) '{0,7:N1} MB' -f ($bytes / 1MB) }

Write-Host ''
Write-Host ("  {0} шеми, вкупно {1}" -f $schemas.Count, (& $mb (($schemas | Measure-Object Bytes -Sum).Sum)).Trim())
foreach ($s in $schemas) {
    $mark = if ($stay -contains $s) { 'останува' } else { 'архива  ' }
    $colour = if ($stay -contains $s) { 'Gray' } else { 'Yellow' }
    Write-Host ("    {0}  {1}  {2,3} табели  {3}" -f $mark, (& $mb $s.Bytes), $s.Tables, $s.Name) -ForegroundColor $colour
}
if (-not $old.Count) {
    Write-Host ''
    Write-Host "  Нема што да се тргне: во облакот се само последните $($schemas.Count) (се чуваат $Keep)." -ForegroundColor Green
    Close-Window
}
foreach ($s in $old) { if ($s.Name -notmatch $NAME) { Stop-WithMessage "Неочекувано име: $($s.Name)" } }
$freed = (& $mb (($old | Measure-Object Bytes -Sum).Sum)).Trim()
Write-Host ''
Write-Host "  За архива: $($old.Count) шеми, $freed. Во облакот остануваат последните $($stay.Count)."
if ($List) { exit 0 }

if (-not $Apply) {
    Write-Host ''
    $answer = Read-Host 'Се преземаат во backups\, се враќаат и споредуваат локално, па се бришат од облакот. Внеси DA за да продолжам'
    if ($answer -notmatch '^(da|да)$') { Write-Host '  Ништо не е сменето.'; exit 0 }
}

$nameList = ($old | ForEach-Object { "'" + $_.Name + "'" }) -join ','

# Пред сè: местото за проверка мора да е слободно. Шема со исто име таму е
# нечија друга работа и не се пишува врз неа.
try { $taken = @(Invoke-Sql $CheckUrl "SELECT nspname FROM pg_namespace WHERE nspname IN ($nameList)") }
catch { Stop-WithMessage ("Локалната база за проверка не одговара — ништо не е направено.`n" + $_.Exception.Message) }
if ($taken.Count) { Stop-WithMessage "Во локалната база веќе постои $($taken[0]). Проверката не пишува врз неа — ништо не е направено." }

# ── архивата ──────────────────────────────────────────────────────────────
$backups = Join-Path $repo 'backups'
New-Item -ItemType Directory -Force -Path $backups | Out-Null
$archive = Join-Path $backups ('supabase-recovery-archive-{0}.dump' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host ''
Write-Host "Архива → $archive" -ForegroundColor Cyan
$dumpArgs = @($cloud.Url, '-Fc', '--no-owner', '--no-privileges', '-f', $archive)
foreach ($s in $old) { $dumpArgs += @('-n', $s.Name) }
$ErrorActionPreference = 'Continue'
$dumpOut = & $cloud.PgDump @dumpArgs 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0 -or -not (Test-Path $archive) -or (Get-Item $archive).Length -lt 1024) {
    Stop-WithMessage ("Архивата не успеа — од облакот НЕ е избришано ништо.`n" + (($dumpOut | Out-String).Trim()))
}
Write-Host ('  {0:N0} KB' -f ((Get-Item $archive).Length / 1KB))

# ── доказот: врати ја и спореди ја ────────────────────────────────────────
# Секоја табела: број на редови и md5 од сите редови. Подредувањето е по
# бајти (convert_to), за две бази со различна локализација да го дадат истиот
# отпечаток за иста содржина. Без наводници во SQL-от: Windows PowerShell ги
# голта кога ги предава на psql (пробата го фати тоа со COLLATE "C").
$contentSql = @"
SELECT n.nspname || '|' || c.relname || '|' || (xpath('/row/v/text()', query_to_xml(format(
         'SELECT count(*)::text || '':'' || coalesce(md5(string_agg(to_jsonb(t)::text, ''|'' ORDER BY convert_to(to_jsonb(t)::text, ''UTF8''))), ''-'') AS v FROM %I.%I t',
         n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname IN ($nameList)
"@
function Get-Content-Proof([string]$Url) {
    $lines = [string[]]@(Invoke-Sql $Url $contentSql)
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    return $lines
}

Write-Host 'Проверка: враќам локално и споредувам со облакот…' -ForegroundColor Cyan
$problem = ''
try {
    $ErrorActionPreference = 'Continue'
    $restoreOut = & $cloud.PgRestore -d $CheckUrl --no-owner --no-privileges --exit-on-error $archive 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw ("архивата не може да се врати: " + (($restoreOut | Out-String).Trim())) }

    $restored = Get-Content-Proof $CheckUrl
    $source = Get-Content-Proof $cloud.Url
    $expected = ($old | Measure-Object Tables -Sum).Sum
    if ($source.Count -ne $expected) { throw "облакот се смени во меѓувреме ($($source.Count) табели, беа $expected)" }
    if ($restored.Count -ne $source.Count) { throw "вратени се $($restored.Count) од $($source.Count) табели" }
    for ($i = 0; $i -lt $source.Count; $i++) {
        if ($restored[$i] -cne $source[$i]) {
            $where = ($source[$i].Split('|')[0..1]) -join '.'
            throw "содржината на $where не е иста по враќањето"
        }
    }
} catch {
    $ErrorActionPreference = 'Stop'
    $problem = $_.Exception.Message
} finally {
    # Привремените шеми се тргаат од локалната база, успеало или не. Само
    # овие имиња, и само затоа што пред малку не постоеја таму.
    try {
        # Името е проверено дека е само мали букви, цифри и _ — не бара наводници.
        Invoke-Sql $CheckUrl ('BEGIN; ' + (($old | ForEach-Object { 'DROP SCHEMA IF EXISTS ' + $_.Name + ' CASCADE;' }) -join ' ') + ' COMMIT;') | Out-Null
    } catch {
        Write-Host "  (привремените шеми не се исчистени од локалната база: $($_.Exception.Message))" -ForegroundColor Yellow
    }
}
if ($problem) {
    Stop-WithMessage "Проверката не помина: $problem.`nОд облакот НЕ е избришано ништо. Архивата остана во $archive, но не е докажана."
}
Write-Host ("  вратена и споредена: {0} табели во {1} шеми, сите исти како во облакот" -f $source.Count, $old.Count) -ForegroundColor Green

# ── бришењето: една трансакција, само овие имиња ──────────────────────────
$drop = 'BEGIN; ' + (($old | ForEach-Object { 'DROP SCHEMA ' + $_.Name + ' CASCADE;' }) -join ' ') + ' COMMIT;'
try { Invoke-Sql $cloud.Url $drop | Out-Null }
catch { Stop-WithMessage ("Бришењето не помина и е вратено (rollback). Облакот е како пред тоа; архивата е во $archive.`n" + $_.Exception.Message) }

Write-Host ''
Write-Host "Готово. Од облакот се тргнати $($old.Count) шеми ($freed); докажаната копија е во $archive." -ForegroundColor Green
Write-Host 'Враќање на една: pg_restore -n <име> во база по избор.' -ForegroundColor DarkGray
Close-Window
