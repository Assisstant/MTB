# vezbi-zip.ps1 — Вежби за изговор as one zip for a computer without MTB.
#
# The exercise page needs no server and no Internet, but it is no longer one
# folder: it frames ComuniBoard.html and WBACC.html from the folder above it.
# Copying vezbi\ alone gives two empty tabs. This puts the page, the two tools
# and what they load into one zip, in the layout they expect; unpacked
# anywhere, vezbi\index.html opens by double-click.
#
#   powershell -ExecutionPolicy Bypass -File scripts\vezbi-zip.ps1
#   ... -Out D:\somewhere\Vezbi.zip
#
# The zip is written to backups\ (gitignored, as every *.zip is). It holds no
# records: pictures and recordings made on a device stay in that browser.

param([string] $Out = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root ('backups\Vezbi-za-izgovor-' + (Get-Date -Format 'yyyy-MM-dd') + '.zip') }

# home-button.js is the dock ComuniBoard shows when it is opened by itself.
$files = @('ComuniBoard.html', 'WBACC.html', 'home-button.js', 'vezbi\index.html', 'vezbi\audio.js',
           'vezbi\vezbi.jpg', 'vezbi\tabla.jpg', 'vezbi\crtanje.jpg') +
         @(Get-ChildItem -LiteralPath (Join-Path $root 'vezbi\glasovi') -Filter *.js | ForEach-Object { 'vezbi\glasovi\' + $_.Name }) +
         @(Get-ChildItem -LiteralPath (Join-Path $root 'vezbi\audio') -Filter *.js | ForEach-Object { 'vezbi\audio\' + $_.Name })

$missing = @($files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
if ($missing.Count) {
    Write-Host ('Недостига: ' + ($missing -join ', ') + ' — ништо не е запишано.') -ForegroundColor Red
    exit 1
}

# Written entry by entry with forward slashes: Compress-Archive in Windows
# PowerShell 5.1 writes backslashes, and a phone or a Mac then unpacks one
# flat folder of oddly named files instead of vezbi/glasovi/.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
$zip = [IO.Compression.ZipFile]::Open($Out, 'Create')
try {
    foreach ($f in $files) {
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $f), $f.Replace('\', '/'), 'Optimal')
    }
} finally {
    $zip.Dispose()
}

$mb = [Math]::Round((Get-Item -LiteralPath $Out).Length / 1MB, 1)
Write-Host ('Готово: ' + $Out + ' (' + $mb + ' MB, ' + $files.Count + ' фајлови).') -ForegroundColor Green
Write-Host 'Отпакувај каде било и отвори vezbi\index.html.'
