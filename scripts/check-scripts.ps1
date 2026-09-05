# Does every .ps1 here parse — in the PowerShell that will actually run it?
#
#   powershell -ExecutionPolicy Bypass -File scripts\check-scripts.ps1
#
# RUN IT WITH `powershell`, NOT `pwsh`. That is the whole point. `powershell
# -File` is Windows PowerShell 5.1 even when it was typed into pwsh 7, and the
# two parsers do not agree. `$d[($i - 1), $j]` — a parenthesised expression as
# the first index of a two-dimensional array — is fine in 7 and a syntax error
# in 5.1, so a script can be checked, committed and still fail on the first
# double-click. This project already carries the same lesson about the UTF-8
# BOM; this is that lesson for the parser.
#
# Nothing is executed. ParseFile reads the file and reports what the parser
# thinks, which is exactly the question and none of the risk.

param([string] $Path)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Path) { $Path = Join-Path $repoRoot 'scripts' }

Write-Host ''
Write-Host "PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Cyan
if ($PSVersionTable.PSVersion.Major -ge 6) {
    Write-Host 'ВНИМАНИЕ: ова е pwsh. Кратенките и .ps1 датотеките ги вика 5.1.' -ForegroundColor Yellow
    Write-Host 'Пушти го истото со  powershell  за проверката да значи нешто.' -ForegroundColor Yellow
}
Write-Host ''

$bad = 0
$seen = 0
foreach ($file in (Get-ChildItem -Path $Path -Filter *.ps1 -Recurse | Sort-Object FullName)) {
    $seen++
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
    $name = $file.FullName.Substring($repoRoot.Length).TrimStart('\')

    # A .ps1 without a UTF-8 BOM is read with the system ANSI codepage by 5.1,
    # which turns Cyrillic into string delimiters and dies somewhere unrelated.
    $head = [System.IO.File]::ReadAllBytes($file.FullName) | Select-Object -First 3
    $hasBom = ($head.Count -eq 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)

    if ($errors -and $errors.Count) {
        $bad++
        Write-Host ("  FAIL  {0}" -f $name) -ForegroundColor Red
        foreach ($e in ($errors | Select-Object -First 3)) {
            Write-Host ("          линија {0}: {1}" -f $e.Extent.StartLineNumber, $e.Message) -ForegroundColor DarkGray
        }
    } elseif (-not $hasBom) {
        $bad++
        Write-Host ("  FAIL  {0}   нема UTF-8 BOM" -f $name) -ForegroundColor Red
    } else {
        Write-Host ("  ok    {0}" -f $name)
    }
}

Write-Host ''
if ($bad) {
    Write-Host "$bad од $seen нема да тргнат овде." -ForegroundColor Red
    exit 1
}
Write-Host "$seen скрипти, сите се парсираат и сите имаат BOM." -ForegroundColor Green
Write-Host ''
exit 0
