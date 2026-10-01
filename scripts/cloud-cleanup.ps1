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
# (pg_dump, само тие шеми), датотеката се проверува дека е читлива и дека ги
# содржи сите, и дури тогаш шемите се бришат — во една трансакција. Ништо не
# се губи: се преместува од облакот на овој диск.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1          покажува, прашува
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1 -List    само покажува
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-cleanup.ps1 -Apply   без прашање
#
# Брише САМО шеми со тоа име. Табелите на апликацијата (public) не ги допира.
param(
    [ValidateRange(1, 100)]
    [int]$Keep = 3,
    [switch]$List,
    [switch]$Apply,
    [string]$EnvFile = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$quiet = $Apply -or $List

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
try { $cloud = Get-MtbCloud -Repo $repo -EnvFile $EnvFile } catch { Stop-WithMessage $_.Exception.Message }

Write-Host ''
Write-Host 'MTB · стари recovery копии во облакот (Supabase)' -ForegroundColor Cyan
Write-Host ('  ' + $cloud.Host)

# A native tool's stderr must not throw under 'Stop' (see CLAUDE.md), and its
# output goes to a file so a Cyrillic line is never decoded by the console.
function Invoke-CloudSql([string]$Sql) {
    $out = [IO.Path]::GetTempFileName()
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $errors = & $cloud.Psql $cloud.Url -X -At -F '|' -v ON_ERROR_STOP=1 -o $out -c $Sql 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $rows = @(Get-Content -LiteralPath $out -Encoding UTF8 | Where-Object { $_ })
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { throw (($errors | Out-String).Trim()) }
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
try { $rows = Invoke-CloudSql $sql } catch { Stop-WithMessage ("Не можам да го прочитам облакот:`n" + $_.Exception.Message) }

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
$freed = (& $mb (($old | Measure-Object Bytes -Sum).Sum)).Trim()
Write-Host ''
Write-Host "  За архива: $($old.Count) шеми, $freed. Во облакот остануваат последните $($stay.Count)."
if ($List) { exit 0 }

if (-not $Apply) {
    Write-Host ''
    $answer = Read-Host 'Прво се преземаат во backups\, па се бришат од облакот. Внеси DA за да продолжам'
    if ($answer -notmatch '^(da|да)$') { Write-Host '  Ништо не е сменето.'; exit 0 }
}

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

# Читлива, и ја содржи СЕКОЈА табела од СЕКОЈА шема што ќе се брише. Една
# што недостасува значи дека не се брише ништо.
$ErrorActionPreference = 'Continue'
$listing = @(& $cloud.PgRestore --list $archive 2>&1)
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Stop-WithMessage 'Архивата не може да се прочита — од облакот НЕ е избришано ништо.' }
foreach ($s in $old) {
    $inArchive = @($listing | Where-Object { "$_" -match ('\sTABLE DATA\s+' + [regex]::Escape($s.Name) + '\s') }).Count
    if ($inArchive -ne $s.Tables) {
        Stop-WithMessage "Архивата има $inArchive од $($s.Tables) табели на $($s.Name) — од облакот НЕ е избришано ништо. Архивата остана во $archive."
    }
}
Write-Host ('  {0:N0} KB, проверена: сите табели од {1} шеми се внатре' -f ((Get-Item $archive).Length / 1KB), $old.Count)

# ── бришењето: една трансакција, само овие имиња ──────────────────────────
$drop = 'BEGIN; ' + (($old | ForEach-Object {
    if ($_.Name -notmatch '^mtb_workspace_recovery_[a-z0-9_]+$') { throw "Неочекувано име: $($_.Name)" }
    'DROP SCHEMA "' + $_.Name + '" CASCADE;'
}) -join ' ') + ' COMMIT;'
try { Invoke-CloudSql $drop | Out-Null }
catch { Stop-WithMessage ("Бришењето не помина и е вратено (rollback). Облакот е како пред тоа; архивата е во $archive.`n" + $_.Exception.Message) }

Write-Host ''
Write-Host "Готово. Од облакот се тргнати $($old.Count) шеми ($freed); копијата е во $archive." -ForegroundColor Green
Write-Host 'Враќање на една: pg_restore -n <име> во база по избор.' -ForegroundColor DarkGray
Close-Window
