# Does the Rule 1 guard actually refuse, or does it merely exist?
#
# A hook that is present and a hook that stops a commit are different claims,
# and only the second one is worth anything. This proves both directions: it
# puts one real name from the local database into a file inside the repository
# and requires `check:names` to fail, then removes the file and requires the
# check to pass.
#
# THE NAME NEVER PASSES THROUGH THE CONSOLE. `psql -o` writes it straight into
# the probe file. Reading it into a PowerShell variable first would decode it
# with the console codepage, which turns Cyrillic into mojibake — the same trap
# the migrations already carry `PGCLIENTENCODING=UTF8` for. A mojibake probe is
# worse than no probe: the checker correctly finds nothing and the guard looks
# broken when it is not.
#
# When it fails, it shows the checker's own output. That is safe to read and to
# paste: `check:names` masks every name it reports.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-name-guard.ps1

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$server   = Join-Path $repoRoot 'server'
$probe    = Join-Path $repoRoot 'docs\_rule1-probe.md'

# `2>&1` on a native command turns its stderr into ErrorRecords, and under
# `$ErrorActionPreference = 'Stop'` those THROW. The checker writes its refusal
# to stderr, so a working guard would kill this script instead of reporting —
# which is exactly what happened the first time this was run.
function Invoke-Check {
    Push-Location $server
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = & npm run --silent check:names 2>&1 | Out-String
        return [pscustomobject]@{ Code = $LASTEXITCODE; Text = $text.TrimEnd() }
    } finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
}

$hooks = git -C $repoRoot config core.hooksPath
if ($hooks -ne '.githooks') {
    Write-Host "core.hooksPath was '$hooks' - setting it to .githooks" -ForegroundColor Yellow
    git -C $repoRoot config core.hooksPath .githooks
}
if (-not (Test-Path (Join-Path $repoRoot '.githooks\pre-commit'))) {
    Write-Host 'FAIL  .githooks/pre-commit is missing.' -ForegroundColor Red
    exit 1
}

# 1. The repository as it stands must be clean, or the rest proves nothing.
if (Test-Path $probe) { Remove-Item $probe -Force }
$before = Invoke-Check
if ($before.Code -ne 0) {
    Write-Host 'FAIL  the repository does not pass check:names as it stands. Fix that first.' -ForegroundColor Red
    Write-Host $before.Text
    exit 1
}

$psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
if (-not $psql) {
    $psql = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
             Sort-Object FullName -Descending | Select-Object -First 1).FullName
}
if (-not $psql) {
    Write-Host 'SKIP  psql was not found, so no name could be taken from the database.' -ForegroundColor Yellow
    exit 2
}
$url = (Get-Content (Join-Path $server '.env') | Select-String '^DATABASE_URL=').Line -replace '^DATABASE_URL=',''

# A name the checker considers searchable: two words, no class prefix, no
# „(над.)" marker. A one-word name matches half the prose in the repository and
# is skipped by design, so a probe built from one would prove nothing.
$sql = @'
SELECT name FROM students
 WHERE name ~ '^\S+\s+\S+$' AND name !~ '[()]' AND name !~ '^\S{1,8}\s+-\s+'
 LIMIT 1
'@

$blocked = $false
$dirty = $null
try {
    $env:PGCLIENTENCODING = 'UTF8'
    & $psql $url -t -A -o $probe -c $sql | Out-Null

    $text = if (Test-Path $probe) { (Get-Content $probe -Raw -Encoding UTF8).Trim() } else { '' }
    if ([string]::IsNullOrWhiteSpace($text)) {
        Write-Host 'SKIP  the database holds no plain two-word name to test with.' -ForegroundColor Yellow
        exit 2
    }
    if ($text -notmatch '[\u0400-\u04FF]') {
        Write-Host 'FAIL  the probe came out without Cyrillic - psql or the file encoding mangled it.' -ForegroundColor Red
        Write-Host "      $($text.Length) characters, no Cyrillic. The test cannot be trusted." -ForegroundColor Red
        exit 1
    }
    Write-Host "probe: $($text.Length) characters, $((($text -split '\s+').Count)) words, Cyrillic (not shown)" -ForegroundColor DarkGray

    $dirty = Invoke-Check
    $blocked = ($dirty.Code -ne 0)
} finally {
    # The probe must not survive this script under any exit path.
    if (Test-Path $probe) { Remove-Item $probe -Force }
}

$after = Invoke-Check
$cleanAgain = ($after.Code -eq 0)

Write-Host ''
if ($blocked -and $cleanAgain) {
    Write-Host 'PASS  a real name is refused, a clean tree is allowed.' -ForegroundColor Green
    Write-Host '      The pre-commit hook runs this same check before every commit.'
    exit 0
}

Write-Host "FAIL  refused-a-name=$blocked  allowed-a-clean-tree=$cleanAgain" -ForegroundColor Red
Write-Host ''
Write-Host 'With the probe in place (names are masked by the checker):' -ForegroundColor Yellow
Write-Host "  exit code: $($dirty.Code)"
Write-Host ($dirty.Text -split "`n" | ForEach-Object { "  $_" }) -Separator "`n"
Write-Host ''
Write-Host 'After it was removed:' -ForegroundColor Yellow
Write-Host "  exit code: $($after.Code)"
Write-Host ($after.Text -split "`n" | ForEach-Object { "  $_" }) -Separator "`n"
exit 1
