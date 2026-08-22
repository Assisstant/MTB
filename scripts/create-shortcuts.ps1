# create-shortcuts.ps1 — three clickable shortcuts on the Desktop:
#
#   Сервер — Вклучи     starts it, waits until it really answers
#   Сервер — Исклучи    stops it (task, supervisor and server, in that order)
#   Сервер — Состојба   says whether it is running, and on which address
#
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
#   ... -Remove     deletes them again
#
# Put in a folder rather than loose on the Desktop with -Folder "MTB".

param(
    [string] $Folder = '',
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$control = Join-Path $root 'scripts\server-control.ps1'

if (-not (Test-Path $control)) {
    Write-Host "Не го наоѓам server-control.ps1 — дали е ова вистинската папка?" -ForegroundColor Red
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$target = if ($Folder) { Join-Path $desktop $Folder } else { $desktop }

$shortcuts = @(
    @{ Name = 'Сервер — Вклучи';   Action = 'start';  Icon = 'shell32.dll,137' },
    @{ Name = 'Сервер — Исклучи';  Action = 'stop';   Icon = 'shell32.dll,109' },
    @{ Name = 'Сервер — Состојба'; Action = 'status'; Icon = 'shell32.dll,23'  }
)

if ($Remove) {
    foreach ($s in $shortcuts) {
        $path = Join-Path $target ($s.Name + '.lnk')
        if (Test-Path $path) { Remove-Item $path -Force; Write-Host "избришано: $($s.Name)" }
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
$shell = New-Object -ComObject WScript.Shell

foreach ($s in $shortcuts) {
    $path = Join-Path $target ($s.Name + '.lnk')
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = 'powershell.exe'
    # -Wait keeps the window open so the result is readable; without it the
    # window closes instantly and a click looks like it did nothing.
    $lnk.Arguments = '-ExecutionPolicy Bypass -File "{0}" {1} -Wait' -f $control, $s.Action
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = Join-Path $env:SystemRoot ('System32\' + $s.Icon)
    $lnk.Description = 'Therapy server — ' + $s.Action
    $lnk.WindowStyle = 1
    $lnk.Save()
    Write-Host "создадено: $path" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Готово. Трите кратенки се на работната површина.' -ForegroundColor Cyan
Write-Host 'Исклучувањето на серверот НЕ ги гаси апликациите — тие работат и офлајн,'
Write-Host 'само не се синхронизираат додека серверот не се врати.'
