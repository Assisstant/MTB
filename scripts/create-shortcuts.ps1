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
    [switch] $ManualSync,
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

# ASCII names on purpose. A .lnk filename goes through WScript.Shell, which
# encodes it with the system ANSI codepage - and this Windows is not on a
# Cyrillic one, so "Сервер — Вклучи" became "?????? — ??????" and Save() threw
# FileNotFoundException. The shortcut's own text is what the user sees, so it
# cannot be worked around with a Description; the file name must be safe.
$shortcuts = @(
    # The front door. It runs the start procedures, opens the apps itself, and
    # stays open so there is something to close — see docs/PLAN-start-stop.md.
    # The three server shortcuts below stay: they are the right tool when
    # something is being debugged and a whole procedure is in the way.
    @{ Name = 'MTB';                 Script = Join-Path $root 'scripts\mtb.ps1'; Args = ''; Icon = 'shell32.dll,44'; Description = 'MTB - open the day' },
    @{ Name = 'MTB - Zavrshi den';   Script = Join-Path $root 'scripts\mtb.ps1'; Args = '-Action stop'; Icon = 'shell32.dll,46'; Description = 'MTB - backup, publish to pCloud, stop the server' },
    @{ Name = 'MTB Server - Start';  Script = $control; Args = 'start -Wait';  Icon = 'shell32.dll,137'; Description = 'Therapy server - start' },
    @{ Name = 'MTB Server - Stop';   Script = $control; Args = 'stop -Wait';   Icon = 'shell32.dll,109'; Description = 'Therapy server - stop' },
    @{ Name = 'MTB Server - Status'; Script = $control; Args = 'status -Wait'; Icon = 'shell32.dll,23';  Description = 'Therapy server - status' }
)
if ($ManualSync) {
    $shortcuts += @{
        Name = 'MTB Database - Manual Sync'
        Script = Join-Path $root 'scripts\manual-db-sync-menu.ps1'
        Args = ''
        Icon = 'shell32.dll,167'
        Description = 'Export, compare and manually accept database snapshots'
    }
}

# Names used before ASCII was forced; removed too, so -Remove cleans up a
# half-created set from an older run.
$legacyNames = @('Сервер — Вклучи', 'Сервер — Исклучи', 'Сервер — Состојба', 'MTB Database - Manual Sync')

if ($Remove) {
    foreach ($n in (@($shortcuts | ForEach-Object { $_.Name }) + $legacyNames)) {
        $path = Join-Path $target ($n + '.lnk')
        if (Test-Path $path) { Remove-Item $path -Force; Write-Host "izbrishano: $n" }
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
    $lnk.Arguments = '-ExecutionPolicy Bypass -File "{0}" {1}' -f $s.Script, $s.Args
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = Join-Path $env:SystemRoot ('System32\' + $s.Icon)
    $lnk.Description = $s.Description
    # 7 = minimised. mtb.ps1 opens its own window; the PowerShell console behind
    # it is wanted only when something goes wrong, and then it is one click away
    # on the taskbar instead of a black rectangle in front of the app.
    $lnk.WindowStyle = if ($s.ContainsKey('Minimised') -and $s.Minimised) { 7 } else { 1 }
    $lnk.Save()
    Write-Host "sozdadeno: $path" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Готово. Кратенките се на работната површина.' -ForegroundColor Cyan
Write-Host 'Исклучувањето на серверот НЕ ги гаси апликациите — тие работат и офлајн,'
Write-Host 'само не се синхронизираат додека серверот не се врати.'
