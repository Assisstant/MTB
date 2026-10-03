# create-shortcuts.ps1 — the MTB shortcuts on the Desktop, one per action in
# mtb-actions.ps1, plus „MTB - Kontrolna tabla", which shows the same actions
# as tiles, and (with -Folder) a PROCITAJ text saying what each one does.
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
# The actions, their words and their commands are written once, in
# mtb-actions.ps1, which the tiles of mtb-launcher.ps1 read too. The front
# door („MTB") runs the start procedures and opens the apps itself — see
# docs/PLAN-start-stop.md; the three server shortcuts stay because they are
# the right tool when something is being debugged and a whole procedure is in
# the way.
. (Join-Path $PSScriptRoot 'mtb-actions.ps1')
$actions = @(Get-MtbActions)
$shortcuts = @(@(Get-MtbLauncherShortcut) + $actions | ForEach-Object {
    $s = $_.Clone()
    $s.Script = Join-Path $PSScriptRoot $s.Script
    $s
})
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

# What each shortcut does, in words, beside them (owner, 3 Oct 2026). A .lnk
# Description is a tooltip nobody hovers; a text file in the folder is read.
# Its name is ASCII for the reason above; its words are the tiles' words, from
# mtb-actions.ps1, so the text and the tiles cannot come to disagree.
$guideName = 'PROCITAJ - sto pravi sekoja kratenka.txt'

if ($Remove) {
    foreach ($n in (@($shortcuts | ForEach-Object { $_.Name }) + $legacyNames)) {
        $path = Join-Path $target ($n + '.lnk')
        if (Test-Path $path) { Remove-Item $path -Force; Write-Host "izbrishano: $n" }
    }
    $guide = Join-Path $target $guideName
    if ($Folder -and (Test-Path -LiteralPath $guide)) { Remove-Item -LiteralPath $guide -Force; Write-Host "izbrishano: $guideName" }
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
    # In a folder, the same shortcut loose on the Desktop is the older copy of
    # this one (the name is ours): one place to click, not two.
    if ($Folder) {
        $loose = Join-Path $desktop ($s.Name + '.lnk')
        if (Test-Path -LiteralPath $loose) { Remove-Item -LiteralPath $loose -Force; Write-Host "premesteno vo papkata: $($s.Name)" }
    }
}

# Only into the folder: loose on the Desktop it would be one more icon there.
if ($Folder) {
    $nl = [Environment]::NewLine
    $text = 'MTB — што прави секоја кратенка' + $nl + '================================' + $nl + $nl +
            'Најлесно: „MTB - Kontrolna tabla“ — сите се таму како плочки, со истиот опис.' + $nl +
            'Овој фајл се пишува сам при секое „MTB“ (од scripts\mtb-actions.ps1);' + $nl +
            'промена направена тука ќе биде заменета.' + $nl
    foreach ($g in Get-MtbActionGroups) {
        $text += $nl + $nl + $g.Title.ToUpper() + $nl + ('-' * $g.Title.Length) + $nl
        foreach ($a in @($actions | Where-Object { $_.Group -eq $g.Key })) {
            $text += $nl + $a.Name + '  —  ' + $a.Title + $nl + '    ' + $a.Text + $nl + '    Кога: ' + $a.When + $nl
        }
    }
    $text += $nl + $nl + 'Ако некоја кратенка исчезне — „MTB“ ги враќа.' + $nl
    # UTF-8 with a BOM, which Windows PowerShell's UTF8 is: Notepad on any
    # codepage then reads the Cyrillic as Cyrillic.
    Set-Content -LiteralPath (Join-Path $target $guideName) -Value $text -Encoding UTF8 -NoNewline
    Write-Host "sozdadeno: $(Join-Path $target $guideName)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Готово. Кратенките се на работната површина.' -ForegroundColor Cyan
Write-Host 'Исклучувањето на серверот НЕ ги гаси апликациите — тие работат и офлајн,'
Write-Host 'само не се синхронизираат додека серверот не се врати.'
