# mtb-launcher.ps1 — „MTB - Kontrolna tabla": every MTB action as a tile that
# says what it does and when it is used; a click runs it (owner, 3 Oct 2026:
# „one shortcut inside launches that, and I have the explanation in every
# thumbnail").
#
# A native window, not a page: a page in the browser cannot start a script on
# this machine, and teaching the local server to run them would put „stop the
# server" and „migrate the cloud" behind an address the tailnet can reach.
#
# It only LAUNCHES. Each tile starts exactly the command its shortcut starts,
# in a window of its own, so whatever that script asks („DA", Enter) and
# reports is where it always was. The actions and their words come from
# mtb-actions.ps1 — the shortcuts and PROCITAJ read the same list.
#
# FIVE TABS (owner, 8 and 9 Oct 2026). Омилени is what the person opens every
# day: the star on any tile puts it there or takes it off, so the same tile is
# in its own tab and on Омилени. Евиденција opens a record page in the cloud's
# work space; Вежби opens the exercise pages of this folder, from this
# computer; Одржување keeps the cloud safe and this computer's code current;
# Не се користи holds the local server and the read-only copy, which still
# work and are out of the way. A tile that opens a page carries a picture of
# it. The tabs and which tile sits where are in mtb-actions.ps1 (Get-MtbTabs).
#
# IT REMINDS (owner, 9 Oct 2026: „mozi i ti da me potsekash"). Under the
# heading: what is due — the cloud's backup when the last one is a week old,
# the cloud's cleanup when recovery copies have piled up, the code when this
# computer is behind — each with a button that runs its tile. It reads files
# on this computer and never asks the cloud, so the window opens at once and
# without the Internet. What it knows about the cloud is what cloud-backup.ps1
# and cloud-cleanup.ps1 last wrote down (cloud-lib.ps1), and it says from when.
#
# THE LAYOUT is this computer's own (%LOCALAPPDATA%\MTB\kontrolna-tabla.json),
# never data. In each tab one grid, three to a row, every row full before the
# next — the owner turned down sections because a short one left a row half
# empty. In it:
#   drag    a tile onto another takes that one's place;
#   star    (one tile) on Омилени or not; there the tiles are in the order
#           they were starred, changed by dragging, and have no pin;
#   pin     (one tile) keeps it in the very place it is: it cannot be dragged,
#           nothing is dropped on it, and the free tiles move around it;
#   lock    (the whole grid) nothing moves at all until it is unlocked;
#   colour  click a tile's icon;
#   theme   light or dark, the first time as Windows is set.
# (Owner, 3 Oct 2026: „locked — all stay where they are; pinned — that one
# does not change its place, the others in free mode change places".)
#
#   powershell -ExecutionPolicy Bypass -File scripts\mtb-launcher.ps1

param(
    [int] $Port = 3000,
    # The read-only copy of the cloud, where this computer has one (run-mirror-server.ps1).
    [int] $MirrorPort = 3001,
    # Render the window to a PNG and close: how its look is checked without a click.
    [string] $Snapshot = '',
    # Another layout file, so a check never touches the person's own.
    [string] $LayoutFile = '',
    # Open on this tab (fav, records, practice, upkeep, parked) whatever was open last: for a snapshot of each.
    [string] $StartTab = '',
    # Another repository root to read backups\ from: a check of the reminders
    # with invented files never looks at the real backups.
    [string] $BackupsRoot = ''
)

$ErrorActionPreference = 'Stop'

# WPF needs a single-threaded apartment. Windows PowerShell gives one; anything
# else is handed back to it rather than failing with an obscure COM error.
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    Start-Process powershell.exe -ArgumentList @('-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit 0
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# The console behind the window is noise: hidden while the window is up, shown
# again if anything goes wrong so the error is not lost with it.
Add-Type -Namespace MtbLauncher -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
$console = [MtbLauncher.Native]::GetConsoleWindow()
[void][MtbLauncher.Native]::ShowWindow($console, 0)

$root = Split-Path -Parent $PSScriptRoot
$serverEnv = Join-Path $root 'server\.env'
. (Join-Path $PSScriptRoot 'mtb-actions.ps1')
$groupWord = @{}
foreach ($g in Get-MtbActionGroups) { $groupWord[$g.Key] = $g.Word }

$defaults = @(Get-MtbActions)
$byName = @{}
foreach ($a in $defaults) { $byName[$a.Name] = $a }
$tabs = @(Get-MtbTabs)
$tabKeys = @($tabs | ForEach-Object { $_.Key })
# When a reminder is due. A week for the backup: the cloud is the one place the
# work is written, and a week is what the owner can lose and re-enter.
$backupDueDays = 7
if (-not $BackupsRoot) { $BackupsRoot = $root }
# The layout is kept twice: on this computer, and in the pCloud folder both
# PCs already share (SYNC_DIR in server\.env, or P:\MTB-sync), so HOME and
# WORK show the same panel (owner, 3 Oct 2026). The newer of the two is read;
# both are written. Without pCloud the local copy alone carries on — and a
# check with -LayoutFile never touches either.
$sharedLayout = ''
if (-not $LayoutFile) {
    $LayoutFile = Join-Path $env:LOCALAPPDATA 'MTB\kontrolna-tabla.json'
    $syncDir = 'P:\MTB-sync'
    if (Test-Path -LiteralPath $serverEnv) {
        $line = Get-Content -LiteralPath $serverEnv -Encoding UTF8 | Where-Object { $_ -match '^\s*SYNC_DIR\s*=' } | Select-Object -First 1
        if ($line) { $syncDir = ($line -replace '^\s*SYNC_DIR\s*=\s*', '').Trim().Trim('"') }
    }
    $sharedLayout = Join-Path $syncDir 'kontrolna-tabla.json'
}

$palette = @('#2F6FE4', '#1F5FD1', '#0C8CE9', '#0097A7', '#1E9E8B', '#2E9B4F', '#7CB342',
             '#E0A21B', '#E0752D', '#D64545', '#D6457E', '#8E44AD', '#6B4FD8', '#5B6B82', '#111111')

$themes = @{
    light = @{
        Bg = @('#DCE8FB', '#ECE7FA', '#D3F0E4'); Card = '#EEFFFFFF'; Border = '#162F6FE4'; CardBase = '#FFFFFF'; CardMix = 0.24
        Title = '#1B2A4E'; Body = '#3B4663'; Small = '#7D88A3'; When = '#33405E'; Tint = 0.10
        Pill = '#F2FFFFFF'; PillText = '#2B3655'; BtnBg = '#E6EEFC'; BtnBorder = '#C9D8F5'; BtnFg = '#2563D9'
        Heading = '#2563D9'; Sub = '#56627F'; Footer = '#6A7590'; Icon = '#AAB3C5'; IconHover = '#E9EEF8'
        Shadow = '#2A4A8F'; ShadowOp = 0.10; ShadowHover = 0.22; Popup = '#FFFFFF'; PopupBorder = '#D5DEEF'
    }
    dark = @{
        Bg = @('#101624', '#181530', '#0E211D'); Card = '#F21C2438'; Border = '#2E3F62'; CardBase = '#1C2438'; CardMix = 0.30
        Title = '#EAF0FF'; Body = '#B9C4DE'; Small = '#8796B6'; When = '#DCE4F7'; Tint = 0.24
        Pill = '#EE1C2438'; PillText = '#DCE4F7'; BtnBg = '#26355A'; BtnBorder = '#3A4C7C'; BtnFg = '#A9C4FF'
        Heading = '#86AEFF'; Sub = '#A3AFCB'; Footer = '#8796B6'; Icon = '#66738F'; IconHover = '#2A3656'
        Shadow = '#000000'; ShadowOp = 0.35; ShadowHover = 0.60; Popup = '#1C2438'; PopupBorder = '#33456A'
    }
}

function Get-Brush([string] $Hex) { [Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
function Get-Colour([string] $Hex) { [Windows.Media.ColorConverter]::ConvertFromString($Hex) }
function Get-Thick([double] $L, [double] $T, [double] $R, [double] $B) { [Windows.Thickness]::new($L, $T, $R, $B) }

function New-Text([string] $Text, [double] $Size, [string] $Colour, [string] $Weight = 'Normal') {
    $t = New-Object Windows.Controls.TextBlock
    $t.Text = $Text
    $t.FontSize = $Size
    $t.Foreground = Get-Brush $Colour
    $t.FontWeight = [Windows.FontWeights]::$Weight
    $t.TextWrapping = 'Wrap'
    return $t
}

# ── server\.env: the one place a page's address is kept ─────────────────────
function Get-EnvValue([string] $Key) {
    if (-not (Test-Path -LiteralPath $serverEnv)) { return '' }
    $line = Get-Content -LiteralPath $serverEnv -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return ($line -replace "^\s*$Key\s*=\s*", '').Trim().Trim('"')
}

function Add-EnvValue([string] $Key, [string] $Value) {
    $text = if (Test-Path -LiteralPath $serverEnv) { [IO.File]::ReadAllText($serverEnv) } else { '' }
    $lead = if ($text -and -not $text.EndsWith("`n")) { "`r`n" } else { '' }
    # No BOM: dotenv reads the file, and a BOM in the middle of it is a character.
    [IO.File]::AppendAllText($serverEnv, "$lead$Key=$Value`r`n", (New-Object Text.UTF8Encoding($false)))
}

# ── the layout ──────────────────────────────────────────────────────────────
function Get-SystemTheme {
    try {
        $v = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme
        if ($v -eq 0) { return 'dark' }
    } catch { }
    return 'light'
}

function Read-Layout {
    $j = $null
    $from = @($LayoutFile, $sharedLayout) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending | Select-Object -First 1
    try { if ($from) { $j = Get-Content -LiteralPath $from -Raw -Encoding UTF8 | ConvertFrom-Json } } catch { }
    Use-Layout $j
}

# One reading of a layout, whether it comes from this computer, from pCloud or
# from a file the person imports: what it does not know is left out, never
# guessed, and what it lacks falls back to the defaults.
function Use-Layout($j) {
    # What the file names, in its order; an action it does not know yet (added
    # since) goes in at its own place in the default list, not at the end.
    $order = New-Object Collections.ArrayList
    foreach ($n in @($j.order)) { if ($n -and $byName.ContainsKey($n) -and -not $order.Contains($n)) { [void]$order.Add($n) } }
    for ($i = 0; $i -lt $defaults.Count; $i++) {
        $n = $defaults[$i].Name
        if (-not $order.Contains($n)) { $order.Insert([Math]::Min($i, $order.Count), $n) }
    }
    # pinned: tile → the place it holds in its own tab. A file from before the
    # tabs reads the same: every tile it knows is in the first tab, in the
    # places it had. An older file still kept a plain list here; that meant
    # something else, and is dropped rather than misread.
    $pinned = @{}
    if ($j.pinned -is [Management.Automation.PSCustomObject]) {
        foreach ($p in $j.pinned.PSObject.Properties) { if ($byName.ContainsKey($p.Name)) { $pinned[$p.Name] = [int]$p.Value } }
    }
    $colours = @{}
    if ($j.colors) { foreach ($p in $j.colors.PSObject.Properties) { if ($byName.ContainsKey($p.Name) -and $p.Value -match '^#[0-9A-Fa-f]{6}$') { $colours[$p.Name] = [string]$p.Value } } }
    # favourites: the tiles on „Омилени", in the order they are shown. A file
    # that names them is believed, an empty list too (the person took them all
    # off); a file from before them starts with the ones mtb-actions.ps1 marks.
    $starred = New-Object Collections.ArrayList
    if ($j -and ($j.PSObject.Properties.Name -contains 'favorites')) {
        foreach ($n in @($j.favorites)) { if ($n -and $byName.ContainsKey($n) -and -not $starred.Contains($n)) { [void]$starred.Add($n) } }
    } else {
        foreach ($a in $defaults) { if ($a.Fav) { [void]$starred.Add($a.Name) } }
    }
    $script:favs = $starred

    $script:order = $order
    $script:pinned = $pinned
    $script:gridLocked = ($j.locked -eq $true)
    $script:colours = $colours
    $cards = @{}
    if ($j.cardColors) { foreach ($p in $j.cardColors.PSObject.Properties) { if ($byName.ContainsKey($p.Name) -and $p.Value -match '^(#[0-9A-Fa-f]{6}|none)$') { $cards[$p.Name] = [string]$p.Value } } }
    $script:cardColours = $cards
    $script:theme = if ($j.theme -in @('light', 'dark')) { [string]$j.theme } else { Get-SystemTheme }
    # The tab that was open last; the first one for a file that has none.
    $script:tab = if ($j.tab -in $tabKeys) { [string]$j.tab } else { $tabKeys[0] }
    # Open until somebody folds it: a first look should show what is there.
    $script:controlsOpen = -not ($j.controlsOpen -eq $false)
}

function Get-LayoutJson {
    # kind/version mark an exported file, so an import can tell it from any other JSON.
    @{ kind = 'mtb-kontrolna-tabla'; version = 1
       order = @($script:order); favorites = @($script:favs); pinned = $script:pinned; locked = [bool]$script:gridLocked
       colors = $script:colours; cardColors = $script:cardColours; theme = $script:theme
       tab = $script:tab; controlsOpen = [bool]$script:controlsOpen } | ConvertTo-Json
}

# ── settings as a file the person keeps and carries (owner, 3 Oct 2026) ────
function Export-Layout {
    $dlg = New-Object Microsoft.Win32.SaveFileDialog
    $dlg.Title = 'Извези ги поставките на контролната табла'
    $dlg.Filter = 'Поставки (*.json)|*.json'
    $dlg.FileName = 'MTB-kontrolna-tabla-' + (Get-Date -Format 'yyyy-MM-dd') + '.json'
    $dlg.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
    if (-not $dlg.ShowDialog($window)) { return }
    try {
        Set-Content -LiteralPath $dlg.FileName -Value (Get-LayoutJson) -Encoding UTF8
        $footer.Text = 'Поставките се извезени во ' + $dlg.FileName
    } catch {
        $footer.Text = 'Не се извезени: ' + $_.Exception.Message
    }
}

function Import-Layout {
    $dlg = New-Object Microsoft.Win32.OpenFileDialog
    $dlg.Title = 'Увези поставки на контролната табла'
    $dlg.Filter = 'Поставки (*.json)|*.json'
    $dlg.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
    if (-not $dlg.ShowDialog($window)) { return }
    try {
        $j = Get-Content -LiteralPath $dlg.FileName -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        [void][Windows.MessageBox]::Show($window, 'Фајлот не е JSON што може да се прочита. Ништо не е сменето.', 'MTB', 'OK', 'Warning')
        return
    }
    # Another kind of JSON, or one with none of the settings in it, changes nothing.
    $known = @('order', 'favorites', 'pinned', 'locked', 'colors', 'cardColors', 'theme', 'tab', 'controlsOpen') | Where-Object { $j.PSObject.Properties.Name -contains $_ }
    if (($j.kind -and $j.kind -ne 'mtb-kontrolna-tabla') -or -not $known.Count) {
        [void][Windows.MessageBox]::Show($window, 'Ова не се поставки на контролната табла. Ништо не е сменето.', 'MTB', 'OK', 'Warning')
        return
    }
    Use-Layout $j
    Save-Layout
    $footer.Text = 'Поставките се увезени од ' + $dlg.FileName
    $window.Dispatcher.BeginInvoke([Action]{ Show-Page; Update-Status; $footer.Text = 'Поставките се увезени.' }) | Out-Null
}

function Save-Layout {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LayoutFile) | Out-Null
        $json = Get-LayoutJson
        Set-Content -LiteralPath $LayoutFile -Value $json -Encoding UTF8
        # pCloud may be away (offline, not mounted): the local copy is then the
        # record, and the next save that reaches pCloud brings it level.
        if ($sharedLayout -and (Test-Path -LiteralPath (Split-Path -Parent $sharedLayout))) {
            try { Set-Content -LiteralPath $sharedLayout -Value $json -Encoding UTF8 } catch { }
        }
    } catch {
        $footer.Text = 'Распоредот не е зачуван: ' + $_.Exception.Message
    }
}

# Where each tile of the open tab is shown. A pinned tile holds its own place;
# every other place is filled by the free tiles in order — so the grid stays
# full rows whatever is pinned. The order is one list for all tabs; a tab shows
# its own tiles from it, so moving a tile never disturbs another tab.
function Get-Places {
    # Омилени shows the starred tiles, whatever tab each belongs to, in their
    # own order; a pin is a place in a tile's own tab and means nothing here.
    if ($script:tab -eq 'fav') { return @($script:favs) }
    $mine = @($script:order | Where-Object { $byName[$_].Tab -eq $script:tab })
    $count = $mine.Count
    $places = New-Object 'string[]' $count
    if (-not $count) { return $places }
    foreach ($n in @($mine | Where-Object { $script:pinned.ContainsKey($_) } | Sort-Object { $script:pinned[$_] })) {
        $i = [Math]::Max(0, [Math]::Min([int]$script:pinned[$n], $count - 1))
        while ($places[$i]) { $i = ($i + 1) % $count }
        $places[$i] = $n
    }
    $free = @($mine | Where-Object { -not $script:pinned.ContainsKey($_) })
    $k = 0
    for ($i = 0; $i -lt $count; $i++) { if (-not $places[$i]) { $places[$i] = $free[$k]; $k++ } }
    return $places
}

# A tile's picture, read whole into memory: the file is not held open, so the
# next „Ажурирај" can replace it while this window is up.
$thumbs = @{}
function Get-Thumb([string] $Rel) {
    if (-not $Rel) { return $null }
    if ($thumbs.ContainsKey($Rel)) { return $thumbs[$Rel] }
    $bmp = $null
    $file = Join-Path $root $Rel
    if (Test-Path -LiteralPath $file) {
        try {
            $bmp = New-Object Windows.Media.Imaging.BitmapImage
            $bmp.BeginInit()
            $bmp.CacheOption = 'OnLoad'
            $bmp.UriSource = New-Object Uri($file)
            $bmp.EndInit()
            $bmp.Freeze()
        } catch { $bmp = $null }
    }
    $thumbs[$Rel] = $bmp
    return $bmp
}

function Update-Tiles { Save-Layout; Show-Tiles }

function Move-Tile([string] $From, [string] $To) {
    if ($script:tab -eq 'fav') {
        # The dragged tile takes the other's place among the favourites.
        $at = $script:favs.IndexOf($To)
        if ($From -eq $To -or $script:gridLocked -or $at -lt 0 -or -not $script:favs.Contains($From)) { return }
        $script:favs.Remove($From)
        $script:favs.Insert($at, $From)
        Update-Tiles
        return
    }
    if ($From -eq $To -or $script:gridLocked -or $script:pinned.ContainsKey($From)) { return }
    if ($script:pinned.ContainsKey($To)) {
        $footer.Text = '„' + $byName[$To].Title + '“ е закачена — нејзиното место не се зема.'
        return
    }
    $places = @(Get-Places)
    $wasBefore = [Array]::IndexOf($places, $From) -lt [Array]::IndexOf($places, $To)
    $script:order.Remove($From)
    $at = $script:order.IndexOf($To)
    if ($wasBefore) { $at++ }
    $script:order.Insert($at, $From)
    Update-Tiles
}

function Switch-Pin([string] $Name) {
    if ($script:gridLocked) { $footer.Text = 'Распоредот е заклучен — прво „Отклучи“.'; return }
    $places = @(Get-Places)
    $here = [Array]::IndexOf($places, $Name)
    if ($script:pinned.ContainsKey($Name)) {
        # Unpinned, it rejoins the free tiles where it stood: before the next
        # free one, so nothing visibly jumps.
        $script:pinned.Remove($Name)
        $script:order.Remove($Name)
        $next = @()
        if ($here -lt $places.Count - 1) { $next = @($places[($here + 1)..($places.Count - 1)] | Where-Object { $_ -and -not $script:pinned.ContainsKey($_) } | Select-Object -First 1) }
        if ($next.Count) { $script:order.Insert($script:order.IndexOf($next[0]), $Name) } else { [void]$script:order.Add($Name) }
    } else {
        $script:pinned[$Name] = $here
    }
    Update-Tiles
}

# The star: on Омилени or off it. The whole page is drawn again, because the
# number on the tab's button changes with it.
function Switch-Fav([string] $Name) {
    $title = $byName[$Name].Title
    if ($script:favs.Contains($Name)) {
        $script:favs.Remove($Name)
        $said = '„' + $title + '“ е тргната од „Омилени“. Во своето јазиче останува.'
    } else {
        [void]$script:favs.Add($Name)
        $said = '„' + $title + '“ е додадена во „Омилени“.'
    }
    Save-Layout
    Show-Page
    Update-Status
    $footer.Text = $said
}

function Switch-GridLock {
    $script:gridLocked = -not $script:gridLocked
    Save-Layout
    $window.Dispatcher.BeginInvoke([Action]{ Show-Page; Update-Status }) | Out-Null
}

function Set-TileColour([string] $Name, [string] $Hex, [string] $Target = 'icon') {
    $map = if ($Target -eq 'card') { $script:cardColours } else { $script:colours }
    if ($Hex) { $map[$Name] = $Hex } else { $map.Remove($Name) }
    Update-Tiles
}

function Get-TileColour([hashtable] $A) { if ($script:colours.ContainsKey($A.Name)) { $script:colours[$A.Name] } else { $A.Color } }
# A card's own choice wins; 'none' is a choice too (a plain card), and with no
# choice the card has the colour mtb-actions.ps1 gives it.
function Get-CardColour([hashtable] $A) {
    $c = if ($script:cardColours.ContainsKey($A.Name)) { $script:cardColours[$A.Name] } else { [string]$A.CardColor }
    if ($c -eq 'none') { return '' }
    return $c
}

function Test-SolidCard([string] $Hex) { return $Hex -eq '#111111' }

# A coloured card is the colour mixed into the theme's card, not the colour
# itself: strong enough to tell nine apart at a glance, while the text on it
# keeps the contrast it has on a plain card, in either theme.
function Get-CardFill([string] $Hex) {
    # Black is the one colour taken whole: tinted, it would only be grey.
    if (Test-SolidCard $Hex) { return $Hex }
    $T = $themes[$script:theme]
    $c = Get-Colour $Hex; $b = Get-Colour $T.CardBase; $m = $T.CardMix
    $mix = { param($x, $y) [byte][Math]::Round($y + ($x - $y) * $m) }
    return '#{0:X2}{1:X2}{2:X2}' -f (& $mix $c.R $b.R), (& $mix $c.G $b.G), (& $mix $c.B $b.B)
}

# ── small round buttons on a tile: pin, lock, and the icon that picks a colour
# A click is handled here, so the tile under it does not run as well; what it
# does is deferred, because the redraw replaces this very button.
function Invoke-TileButton {
    $b = $script:tileClick
    switch ($b.Kind) {
        'pin'    { Switch-Pin $b.Name }
        'fav'    { Switch-Fav $b.Name }
        'colour' { Show-Palette $b.Name $b.Element }
    }
}

function New-TileButton([string] $Kind, [string] $Name, [int] $Glyph, [bool] $On, [string] $Colour, [string] $Tip) {
    $T = $themes[$script:theme]
    $b = New-Object Windows.Controls.Border
    $b.Width = 28; $b.Height = 28
    $b.Margin = Get-Thick 4 0 0 0
    $b.CornerRadius = [Windows.CornerRadius]::new(14)
    $b.VerticalAlignment = 'Top'
    $b.Background = Get-Brush $(if ($On) { $Colour } else { '#00000000' })
    $b.ToolTip = $Tip
    $g = New-Text ([string][char]$Glyph) 13 $(if ($On) { '#FFFFFF' } else { $T.Icon })
    $g.FontFamily = 'Segoe MDL2 Assets'
    $g.HorizontalAlignment = 'Center'; $g.VerticalAlignment = 'Center'
    $b.Child = $g
    $b.Tag = @{ Kind = $Kind; Name = $Name; On = $On }
    $b.add_MouseEnter({ param($s, $e) if (-not $s.Tag.On) { $s.Background = Get-Brush $themes[$script:theme].IconHover } })
    $b.add_MouseLeave({ param($s, $e) if (-not $s.Tag.On) { $s.Background = Get-Brush '#00000000' } })
    $b.add_MouseLeftButtonUp({
        param($s, $e)
        $e.Handled = $true
        $script:tileClick = @{ Kind = $s.Tag.Kind; Name = $s.Tag.Name; Element = $s }
        $window.Dispatcher.BeginInvoke([Action]{ Invoke-TileButton }) | Out-Null
    })
    return $b
}

# The palette: two rows under the icon — the icon's colour and the card's.
# Separate on purpose (owner, 3 Oct 2026): the whole card coloured is what
# tells nine tiles apart at a glance, and the two may be combined.
function Add-PaletteRow($Column, $Popup, [string] $Name, [string] $Target, [string] $Title, [string] $Current, [string] $ResetText) {
    $T = $themes[$script:theme]
    $label = New-Text $Title 12.5 $T.Small 'SemiBold'
    if ($Column.Children.Count) { $label.Margin = Get-Thick 0 10 0 0 }
    [void]$Column.Children.Add($label)
    $grid = New-Object Windows.Controls.Primitives.UniformGrid
    $grid.Columns = 7
    $grid.Margin = Get-Thick 0 6 0 4
    foreach ($hex in $palette) {
        $sw = New-Object Windows.Controls.Border
        $sw.Width = 26; $sw.Height = 26
        $sw.Margin = Get-Thick 3 3 3 3
        $sw.CornerRadius = [Windows.CornerRadius]::new($(if ($Target -eq 'card') { 7 } else { 13 }))
        # A card swatch shows the card as it would be, an icon swatch the icon.
        $sw.Background = Get-Brush $(if ($Target -eq 'card') { Get-CardFill $hex } else { $hex })
        $sw.BorderBrush = Get-Brush $(if ($hex -eq $Current) { $T.Title } else { $hex })
        $sw.BorderThickness = $(if ($hex -eq $Current) { Get-Thick 2.5 2.5 2.5 2.5 } else { Get-Thick 1.5 1.5 1.5 1.5 })
        $sw.Cursor = [Windows.Input.Cursors]::Hand
        $sw.Tag = @{ Name = $Name; Hex = $hex; Target = $Target; Popup = $Popup }
        $sw.add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Select-Swatch $s.Tag })
        [void]$grid.Children.Add($sw)
    }
    [void]$Column.Children.Add($grid)
    $back = New-Text $ResetText 12.5 $T.BtnFg 'SemiBold'
    $back.Cursor = [Windows.Input.Cursors]::Hand
    $back.Tag = @{ Name = $Name; Hex = ''; Target = $Target; Popup = $Popup }
    $back.add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Select-Swatch $s.Tag })
    if ($Target -eq 'card') {
        # A card has a colour of its own from the start, so „none" is a choice
        # of its own, beside going back to that first colour.
        $row = New-Object Windows.Controls.StackPanel
        $row.Orientation = 'Horizontal'
        [void]$row.Children.Add($back)
        $plain = New-Text 'Без боја' 12.5 $T.BtnFg 'SemiBold'
        $plain.Margin = Get-Thick 18 0 0 0
        $plain.Cursor = [Windows.Input.Cursors]::Hand
        $plain.Tag = @{ Name = $Name; Hex = 'none'; Target = $Target; Popup = $Popup }
        $plain.add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Select-Swatch $s.Tag })
        [void]$row.Children.Add($plain)
        [void]$Column.Children.Add($row)
    } else {
        [void]$Column.Children.Add($back)
    }
}

function Select-Swatch([hashtable] $Pick) {
    $Pick.Popup.IsOpen = $false
    $script:colourPick = $Pick
    $window.Dispatcher.BeginInvoke([Action]{ Set-TileColour $script:colourPick.Name $script:colourPick.Hex $script:colourPick.Target }) | Out-Null
}

function Show-Palette([string] $Name, $Anchor) {
    $T = $themes[$script:theme]
    $pop = New-Object Windows.Controls.Primitives.Popup
    $pop.PlacementTarget = $Anchor
    $pop.Placement = 'Bottom'
    $pop.StaysOpen = $false
    $pop.AllowsTransparency = $true
    $box = New-Object Windows.Controls.Border
    $box.Background = Get-Brush $T.Popup
    $box.BorderBrush = Get-Brush $T.PopupBorder
    $box.BorderThickness = Get-Thick 1 1 1 1
    $box.CornerRadius = [Windows.CornerRadius]::new(14)
    $box.Padding = Get-Thick 12 10 12 10
    $box.Margin = Get-Thick 0 6 8 8
    $shadow = New-Object Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 16; $shadow.ShadowDepth = 2; $shadow.Opacity = 0.25
    $box.Effect = $shadow
    $col = New-Object Windows.Controls.StackPanel
    Add-PaletteRow $col $pop $Name 'icon' 'Боја на иконата' (Get-TileColour $byName[$Name]) 'Почетна боја на иконата'
    Add-PaletteRow $col $pop $Name 'card' 'Боја на картичката' (Get-CardColour $byName[$Name]) 'Почетна боја на картичката'
    $box.Child = $col
    $pop.Child = $box
    $pop.IsOpen = $true
}

# ── one tile ────────────────────────────────────────────────────────────────
function New-Tile([hashtable] $A) {
    $T = $themes[$script:theme]
    $colour = Get-TileColour $A
    $onFav = $script:tab -eq 'fav'
    $isFav = $script:favs.Contains($A.Name)
    # A pin is a place in the tile's own tab; on Омилени it holds nothing.
    $isPinned = (-not $onFav) -and $script:pinned.ContainsKey($A.Name)
    # Held in place: pinned, or the whole grid locked.
    $isLocked = $isPinned -or $script:gridLocked

    $card = New-Object Windows.Controls.Border
    # One height for every tile of a tab, so its rows read level: taller where
    # the tab's tiles carry a picture.
    # „Не се користи" is a list, a line for each: what is out of use should not
    # take the room of what is in use, and a list has no half-empty row.
    $compact = $script:tab -eq 'parked'
    $card.Height = if ($compact) { 104 } elseif ($script:tabHasThumbs) { 404 } else { 288 }
    $card.Margin = if ($compact) { Get-Thick 0 0 18 10 } else { Get-Thick 0 0 18 18 }
    $card.Padding = if ($compact) { Get-Thick 20 12 16 12 } else { Get-Thick 22 20 16 18 }
    $card.CornerRadius = [Windows.CornerRadius]::new(18)
    $cardColour = Get-CardColour $A
    $card.Background = Get-Brush $(if ($cardColour) { Get-CardFill $cardColour } else { $T.Card })
    # On a black card the words take the dark theme's colours, whatever the theme.
    $TT = if (Test-SolidCard $cardColour) { $themes.dark } else { $T }
    $card.BorderBrush = Get-Brush $T.Border
    $card.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5
    $card.Cursor = [Windows.Input.Cursors]::Hand
    $card.ToolTip = if ($script:gridLocked) { 'Клик: се пушта. Распоредот е заклучен.' }
                    elseif ($isPinned) { 'Клик: се пушта. Закачена — останува на ова место.' }
                    else { 'Клик: се пушта. Повлечи врз друга плочка: се преместува.' }
    $card.AllowDrop = $true
    $shadow = New-Object Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 22; $shadow.ShadowDepth = 3; $shadow.Opacity = $T.ShadowOp
    $shadow.Color = Get-Colour $T.Shadow
    $card.Effect = $shadow
    $card.Tag = @{ Action = $A; Colour = $colour; Locked = $isLocked }

    $dock = New-Object Windows.Controls.DockPanel
    $dock.LastChildFill = $true

    # „when" sits at the bottom of every tile, so a row of tiles reads level.
    $when = New-Object Windows.Controls.Border
    $when.CornerRadius = [Windows.CornerRadius]::new(10)
    $when.Padding = Get-Thick 10 6 10 6
    $when.Margin = Get-Thick 0 10 6 0
    $tint = (Get-Brush $colour).Clone(); $tint.Opacity = $TT.Tint
    $when.Background = $tint
    $when.Child = New-Text ('Кога: ' + $A.When) 12.5 $TT.When 'SemiBold'
    [Windows.Controls.DockPanel]::SetDock($when, 'Bottom')
    if (-not $compact) { [void]$dock.Children.Add($when) }

    # The picture of the page the tile opens, across the top. A brush on a
    # rounded border, so the corners follow the card's.
    $thumb = if ($compact) { $null } else { Get-Thumb $A.Thumb }
    if ($thumb) {
        $pic = New-Object Windows.Controls.Border
        $pic.Height = 132
        $pic.Margin = Get-Thick 0 0 6 14
        $pic.CornerRadius = [Windows.CornerRadius]::new(11)
        $pic.BorderBrush = Get-Brush $T.Border
        $pic.BorderThickness = Get-Thick 1 1 1 1
        $brush = New-Object Windows.Media.ImageBrush($thumb)
        $brush.Stretch = 'UniformToFill'
        $brush.AlignmentY = 'Top'
        $pic.Background = $brush
        [Windows.Controls.DockPanel]::SetDock($pic, 'Top')
        [void]$dock.Children.Add($pic)
    } elseif ($script:tabHasThumbs -and -not $compact) {
        # Among tiles with pictures (Омилени mixes the tabs) a tile that runs a
        # script has none to show: its own icon, large, on its own colour, so
        # the row still reads level and the tile is not half empty.
        $pic = New-Object Windows.Controls.Border
        $pic.Height = 132
        $pic.Margin = Get-Thick 0 0 6 14
        $pic.CornerRadius = [Windows.CornerRadius]::new(11)
        $wash = (Get-Brush $colour).Clone(); $wash.Opacity = 0.16
        $pic.Background = $wash
        $big = New-Text ([string][char]$A.Glyph) 54 $colour
        $big.FontFamily = 'Segoe MDL2 Assets'
        $big.HorizontalAlignment = 'Center'; $big.VerticalAlignment = 'Center'
        $pic.Child = $big
        [Windows.Controls.DockPanel]::SetDock($pic, 'Top')
        [void]$dock.Children.Add($pic)
    }

    $stack = New-Object Windows.Controls.StackPanel
    $head = New-Object Windows.Controls.DockPanel

    $tools = New-Object Windows.Controls.StackPanel
    $tools.Orientation = 'Horizontal'
    $tools.VerticalAlignment = 'Top'
    [void]$tools.Children.Add((New-TileButton 'fav' $A.Name $(if ($isFav) { 0xE735 } else { 0xE734 }) $isFav '#E0A21B' $(if ($isFav) { 'Тргни од „Омилени“ — во своето јазиче останува' } else { 'Додај во „Омилени“' })))
    if (-not $onFav) {
        [void]$tools.Children.Add((New-TileButton 'pin' $A.Name 0xE718 $isPinned $colour $(if ($isPinned) { 'Откачи: пак се мести слободно' } else { 'Закачи: останува на ова место, другите се местат околу неа' })))
    }
    [Windows.Controls.DockPanel]::SetDock($tools, 'Right')
    [void]$head.Children.Add($tools)

    # The icon is also where its colour is chosen.
    $chip = New-Object Windows.Controls.Border
    $chip.Width = 48; $chip.Height = 48
    $chip.CornerRadius = [Windows.CornerRadius]::new(14)
    $chip.Background = Get-Brush $colour
    $chip.ToolTip = 'Клик: избери боја'
    $glyph = New-Text ([string][char]$A.Glyph) 21 '#FFFFFF'
    $glyph.FontFamily = 'Segoe MDL2 Assets'
    $glyph.HorizontalAlignment = 'Center'; $glyph.VerticalAlignment = 'Center'
    $chip.Child = $glyph
    $chip.Tag = @{ Kind = 'colour'; Name = $A.Name }
    $chip.add_MouseLeftButtonUp({
        param($s, $e)
        $e.Handled = $true
        $script:tileClick = @{ Kind = 'colour'; Name = $s.Tag.Name; Element = $s }
        $window.Dispatcher.BeginInvoke([Action]{ Invoke-TileButton }) | Out-Null
    })
    [Windows.Controls.DockPanel]::SetDock($chip, 'Left')
    [void]$head.Children.Add($chip)

    $names = New-Object Windows.Controls.StackPanel
    $names.Margin = Get-Thick 14 1 4 0
    $names.VerticalAlignment = 'Center'
    [void]$names.Children.Add((New-Text $A.Title 17.5 $TT.Title 'Bold'))
    if ($A.UrlKey) {
        $url = Get-EnvValue $A.UrlKey
        $where = if ($url -match '^https?://([^/]+)') { 'во прелистувач · ' + $Matches[1] } else { 'во прелистувач · адресата се внесува при прв клик' }
    } elseif ($A.File) {
        $where = 'од овој компјутер · и без Интернет'
    } else {
        $where = 'кратенка: ' + $A.Name
    }
    # The section a tile used to sit in is now a word on it.
    $where += ' · ' + $groupWord[$A.Group]
    [void]$names.Children.Add((New-Text $where 11.5 $TT.Small))
    [void]$head.Children.Add($names)
    [void]$stack.Children.Add($head)

    $body = New-Text $A.Text 13.5 $TT.Body
    $body.Margin = Get-Thick 0 14 6 0
    $body.LineHeight = 20
    if ($compact) {
        # One line; the whole of it, and when it is used, on hover.
        $body.Margin = Get-Thick 0 8 6 0
        $body.TextWrapping = 'NoWrap'
        $body.TextTrimming = 'CharacterEllipsis'
        $card.ToolTip = $A.Text + [Environment]::NewLine + 'Кога: ' + $A.When
    }
    [void]$stack.Children.Add($body)
    [void]$dock.Children.Add($stack)
    $card.Child = $dock

    $card.add_MouseEnter({ param($s, $e) $s.BorderBrush = Get-Brush $s.Tag.Colour; $s.Effect.Opacity = $themes[$script:theme].ShadowHover })
    $card.add_MouseLeave({ param($s, $e) $s.BorderBrush = Get-Brush $themes[$script:theme].Border; $s.Effect.Opacity = $themes[$script:theme].ShadowOp })

    # A click runs it; a press that moves more than a few pixels is a drag —
    # unless the tile is locked, which stays a click however the mouse moves.
    $card.add_PreviewMouseLeftButtonDown({
        param($s, $e)
        $script:pressAt = $e.GetPosition($window); $script:pressed = $s; $script:dragged = $false
    })
    $card.add_PreviewMouseMove({
        param($s, $e)
        if ($e.LeftButton -ne 'Pressed' -or $script:pressed -ne $s -or $script:dragged -or $s.Tag.Locked) { return }
        $now = $e.GetPosition($window)
        if ([Math]::Abs($now.X - $script:pressAt.X) -lt 8 -and [Math]::Abs($now.Y - $script:pressAt.Y) -lt 8) { return }
        $script:dragged = $true
        $s.Opacity = 0.45
        [void][Windows.DragDrop]::DoDragDrop($s, [Windows.DataObject]::new('mtb-tile', $s.Tag.Action.Name), 'Move')
        $s.Opacity = 1
        $script:pressed = $null
    })
    $card.add_MouseLeftButtonUp({
        param($s, $e)
        if ($script:pressed -eq $s -and -not $script:dragged) { $script:pressed = $null; Start-Action $s.Tag.Action }
    })
    $card.add_DragOver({
        param($s, $e)
        $e.Effects = if ($s.Tag.Locked) { 'None' } else { 'Move' }
        $e.Handled = $true
    })
    $card.add_DragEnter({
        param($s, $e)
        if ($s.Tag.Locked) { return }
        $s.BorderBrush = Get-Brush $themes[$script:theme].Heading; $s.BorderThickness = Get-Thick 3 3 3 3
    })
    $card.add_DragLeave({ param($s, $e) $s.BorderBrush = Get-Brush $themes[$script:theme].Border; $s.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5 })
    $card.add_Drop({
        param($s, $e)
        $e.Handled = $true
        $script:dropFrom = [string]$e.Data.GetData('mtb-tile')
        $script:dropTo = $s.Tag.Action.Name
        # The redraw replaces every tile, this one too: it must not happen
        # inside the drag loop that still holds the dragged tile. Not a
        # GetNewClosure(): a closure no longer sees this script's functions.
        $window.Dispatcher.BeginInvoke([Action]{ Move-Tile $script:dropFrom $script:dropTo }) | Out-Null
    })
    return $card
}

# ── running one ─────────────────────────────────────────────────────────────
function Open-Page([hashtable] $A) {
    $url = Get-EnvValue $A.UrlKey
    if (-not $url) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        $url = [Microsoft.VisualBasic.Interaction]::InputBox(
            [string]$A.UrlPrompt + [Environment]::NewLine + [Environment]::NewLine +
            'Се запишува во server\.env на овој компјутер (' + $A.UrlKey + '), не во репото.', 'MTB — ' + $A.Title, '').Trim()
        if (-not $url) { return }
        if ($url -notmatch '^https://[^/\s]+') {
            [void][Windows.MessageBox]::Show($window, 'Тоа не е адреса што почнува со https:// — ништо не е запишано.', 'MTB', 'OK', 'Warning')
            return
        }
        Add-EnvValue $A.UrlKey $url
        Show-Tiles
    }
    # A tile for one page of that server: the same address, its own path.
    if ($A.Page) { $url = ($url -replace '^(https?://[^/\s]+).*$', '$1') + '/' + $A.Page }
    Start-Process $url
    $footer.Text = 'Отворено во прелистувачот: ' + $url
}

# The program that opens web addresses on this computer. A file opened through
# its association loses what follows „?" and „#" in its address — Windows hands
# the browser a path — so a page's part has to be given to the browser itself.
function Get-BrowserProgram {
    try {
        $choice = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop
        $opener = (Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $choice.ProgId + '\shell\open\command') -ErrorAction Stop).GetValue('')
        if ($opener -match '^\s*"([^"]+\.exe)"' -or $opener -match '^\s*(\S+\.exe)') {
            $program = $Matches[1]
            if (Test-Path -LiteralPath $program) { return $program }
        }
    } catch { }
    return ''
}

# A page of this folder, in the browser, straight from the disk.
function Open-File([hashtable] $A) {
    $file = Join-Path $root $A.File
    if (-not (Test-Path -LiteralPath $file)) {
        $footer.Text = 'Го нема фајлот „' + $A.File + '“ во папката MTB — „Ажурирај среде ден“ го носи.'
        return
    }
    $program = if ($A.Part) { Get-BrowserProgram } else { '' }
    if (-not $program) {
        # Without the browser's own program the page opens at its start, where
        # its three tiles lead to the same parts.
        Start-Process $file
        $footer.Text = 'Отворено од овој компјутер: ' + $A.File
        return
    }
    $pageAddress = ([Uri] $file).AbsoluteUri
    # The page cannot know where the diary is: the cloud's address is in
    # server\.env, not in the repository. Handed over here, its „S-Дневник"
    # leads to the same place as the tile on „Евиденција".
    $cloudBase = Get-EnvValue 'MTB_CLOUD_URL'
    if ($cloudBase -match '^(https://[^/\s?#]+)') { $pageAddress += '?oblak=' + [Uri]::EscapeDataString($Matches[1]) }
    $pageAddress += '#' + $A.Part
    Start-Process -FilePath $program -ArgumentList ('"' + $pageAddress + '"')
    $footer.Text = 'Отворено од овој компјутер: ' + $A.File + ' · ' + $A.Title
}

function Start-Action([hashtable] $A) {
    if ($A.Confirm) {
        $answer = [Windows.MessageBox]::Show($window, $A.Confirm, $A.Title, 'YesNo', 'Question')
        if ($answer -ne 'Yes') { return }
    }
    try {
        if ($A.UrlKey) { Open-Page $A; return }
        if ($A.File) { Open-File $A; return }
        $script = Join-Path $PSScriptRoot $A.Script
        $argv = @('-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
        if ($A.Args) { $argv += @($A.Args -split ' ' | Where-Object { $_ }) }
        Start-Process powershell.exe -ArgumentList $argv -WorkingDirectory $root
        $footer.Text = 'Пуштено: „' + $A.Title + '“ — во свој прозорец. Таму се гледа што прави и што прашува.'
        $refresh.Stop(); $refresh.Start()
    } catch {
        $footer.Text = 'Не тргна „' + $A.Title + '“: ' + $_.Exception.Message
    }
}

# ── is the server up? ───────────────────────────────────────────────────────
# The pill at the top says whether anything is due (Show-Reminders). The local
# server is not what the day depends on any more, so its state is one line on
# the tab that holds its tiles — a red dot for a server nobody uses taught the
# eye to ignore the dot. It is still asked: it knows how far behind the code is.
function Update-Status {
    $behind = 0
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        $label = if ($h.server.label) { $h.server.label } else { 'СЕРВЕР' }
        $localSays = "Локалниот сервер работи · $label · база $($h.database)"
        if ($h.update -and $h.update.behind) { $behind = [int]$h.update.behind }
    } catch {
        $localSays = 'Локалниот сервер не е вклучен. За работа во облакот не е потребен.'
    }
    if ($script:localLine) { $localLine.Text = $localSays }
    Update-CopyLine
    Show-Reminders $behind
}

# How long ago, in the words a person uses for a date.
function Get-DaysAgo([DateTime] $At) {
    $days = [int]((Get-Date).Date - $At.Date).TotalDays
    if ($days -le 0) { return 'денес' }
    if ($days -eq 1) { return 'вчера' }
    return 'пред ' + $days + ' дена'
}

# What is due, and what is in order. Files on this computer only: the newest
# backup of the cloud (cloud-backup.ps1's, or the one cloud-migrate.ps1 takes
# before a migration — either is the whole database), and the note the cloud
# scripts leave (cloud-lib.ps1). A number in that note is from when it was
# written, so the sentence says the date.
function Get-Reminders([int] $Behind) {
    $due = New-Object Collections.ArrayList
    $fine = New-Object Collections.ArrayList
    $store = Join-Path $BackupsRoot 'backups'

    $dumps = @()
    if (Test-Path -LiteralPath (Join-Path $store 'cloud')) { $dumps += @(Get-ChildItem -LiteralPath (Join-Path $store 'cloud') -File -Filter 'supabase-backup-*.dump') }
    if (Test-Path -LiteralPath $store) { $dumps += @(Get-ChildItem -LiteralPath $store -File -Filter 'supabase-before-*.dump') }
    $newest = @($dumps | Where-Object { $_.Length -ge 1024 } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if (-not $newest.Count) {
        [void]$due.Add(@{ Text = 'Резерва на облакот: на овој компјутер уште нема ниедна.'; Run = 'MTB - Oblak rezerva' })
    } else {
        $when = Get-DaysAgo $newest[0].LastWriteTime
        if (((Get-Date).Date - $newest[0].LastWriteTime.Date).TotalDays -ge $backupDueDays) {
            [void]$due.Add(@{ Text = 'Резерва на облакот: последната е ' + $when + ' (' + $newest[0].LastWriteTime.ToString('dd.MM.yyyy') + ').'; Run = 'MTB - Oblak rezerva' })
        } else {
            [void]$fine.Add('резерва на облакот: ' + $when)
        }
    }

    $note = $null
    $noteFile = Join-Path $store 'cloud\state.json'
    if (Test-Path -LiteralPath $noteFile) { try { $note = Get-Content -LiteralPath $noteFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
    if ($note -and "$($note.recoverySchemas)" -match '^\d+$') {
        $keep = if ("$($note.recoveryKeep)" -match '^\d+$') { [int]$note.recoveryKeep } else { 3 }
        $seen = ''
        try { $seen = ' (видено ' + ([DateTime]$note.checkedAt).ToString('dd.MM.yyyy') + ')' } catch { }
        if ([int]$note.recoverySchemas -gt $keep) {
            [void]$due.Add(@{ Text = 'Чистење на облакот: таму има ' + [int]$note.recoverySchemas + ' стари recovery копии, а се чуваат ' + $keep + $seen + '.'; Run = 'MTB - Oblak chistenje' })
        } else {
            [void]$fine.Add('облакот е исчистен')
        }
    }

    if ($Behind -gt 0) {
        [void]$due.Add(@{ Text = 'Кодот на овој компјутер е ' + $Behind + ' измени зад GitHub.'; Run = 'MTB - Azuriraj' })
    }
    return @{ Due = $due; Fine = $fine }
}

# One row for each thing that is due, with the button that does it. Nothing
# due: one quiet sentence, so the absence of a reminder is not mistaken for
# the panel not having looked.
function Show-Reminders([int] $Behind) {
    $T = $themes[$script:theme]
    $r = Get-Reminders $Behind
    $remindBox.Children.Clear()
    if (-not $r.Due.Count) {
        $dot.Fill = Get-Brush '#2E9B4F'
        $status.Text = 'Нема што да се прави' + $(if ($r.Fine.Count) { ' · ' + ($r.Fine -join ' · ') } else { '' })
        return
    }
    $dot.Fill = Get-Brush '#E0A21B'
    $status.Text = if ($r.Due.Count -eq 1) { 'Потсетник: една работа чека' } else { 'Потсетник: ' + $r.Due.Count + ' работи чекаат' }
    foreach ($one in $r.Due) {
        $row = New-Object Windows.Controls.Border
        $row.CornerRadius = [Windows.CornerRadius]::new(14)
        $row.Padding = Get-Thick 16 8 8 8
        $row.Margin = Get-Thick 0 8 0 0
        $row.HorizontalAlignment = 'Center'
        $wash = (Get-Brush '#E0A21B').Clone(); $wash.Opacity = $(if ($script:theme -eq 'dark') { 0.22 } else { 0.18 })
        $row.Background = $wash
        $row.BorderBrush = Get-Brush '#E0A21B'
        $row.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5
        $line = New-Object Windows.Controls.StackPanel
        $line.Orientation = 'Horizontal'
        $words = New-Text $one.Text 14 $T.Title 'SemiBold'
        $words.VerticalAlignment = 'Center'
        $words.Margin = Get-Thick 0 0 10 0
        [void]$line.Children.Add($words)
        $target = $byName[$one.Run]
        if ($target) {
            $go = New-PillButton ('Направи сега: ' + $target.Title) 'Ја пушта плочката, во свој прозорец' {
                param($s, $e)
                $e.Handled = $true
                $script:remindRun = [string]$s.Tag
                $window.Dispatcher.BeginInvoke([Action]{ Start-Action $byName[$script:remindRun] }) | Out-Null
            }
            $go.Tag = $one.Run
            [void]$line.Children.Add($go)
        }
        $row.Child = $line
        [void]$remindBox.Children.Add($row)
    }
}

# Only where a read-only copy of the cloud is set up (HOME, not WORK): how old
# its data is, read from the copy's own server. It says the copy's AGE, which
# is always known; whether the cloud has moved since is known only by asking
# the cloud, and that is the tile „Освежи ја копијата“.
function Update-CopyLine {
    if (-not $script:copyLine) { return }
    try {
        $m = Invoke-RestMethod -Uri "http://127.0.0.1:$MirrorPort/api/health" -TimeoutSec 1
        if (-not $m.mirror -or $m.mirror.mode -ne 'readonly') {
            $copyLine.Text = 'Копија од облакот: на портата ' + $MirrorPort + ' одговара друг сервер, не копијата.'
        } elseif ($m.mirror.dataAt) {
            $raw = $m.mirror.dataAt
            $at = if ($raw -is [DateTime]) { $raw.ToLocalTime() }
                  else { [DateTimeOffset]::Parse([string]$raw, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime }
            $age = (Get-Date) - $at
            $old = if ($age.TotalHours -lt 1) { 'помалку од еден час' }
                   elseif ($age.TotalHours -lt 48) { [string][int][Math]::Floor($age.TotalHours) + ' часа' }
                   else { [string][int][Math]::Floor($age.TotalDays) + ' дена' }
            $copyLine.Text = 'Копија од облакот (само читање): податоци од ' + $at.ToString('dd.MM.yyyy, HH:mm') + ' — стари ' + $old + '.'
        } else {
            $copyLine.Text = 'Копија од облакот: уште нема преземена снимка.'
        }
    } catch {
        $copyLine.Text = 'Копија од облакот: серверот ѝ не е вклучен — плочката „Копија од облакот“ го вклучува.'
    }
}

# ── the page: built again whole when the theme changes ─────────────────────
function New-PillButton([string] $Text, [string] $Tip, [scriptblock] $OnClick) {
    $T = $themes[$script:theme]
    $b = New-Object Windows.Controls.Border
    $b.CornerRadius = [Windows.CornerRadius]::new(14)
    $b.Padding = Get-Thick 12 5 12 5
    $b.Margin = Get-Thick 4 0 0 0
    $b.Background = Get-Brush $T.BtnBg
    $b.BorderBrush = Get-Brush $T.BtnBorder
    $b.BorderThickness = Get-Thick 1 1 1 1
    $b.Cursor = [Windows.Input.Cursors]::Hand
    $b.ToolTip = $Tip
    $b.Child = New-Text $Text 12.5 $T.BtnFg 'SemiBold'
    $b.add_MouseLeftButtonUp($OnClick)
    return $b
}

# Folding the controls only shows or hides them: nothing is rebuilt, so a
# click there never redraws the tiles.
function Set-ControlsShown {
    $controls.Visibility = if ($script:controlsOpen) { 'Visible' } else { 'Collapsed' }
    $barButton.Child.Text = if ($script:controlsOpen) { 'Скриј ▲' } else { 'Контроли ▼' }
}

function Switch-Controls {
    $script:controlsOpen = -not $script:controlsOpen
    Set-ControlsShown
    Save-Layout
}

function Show-Tiles {
    $tiles.Children.Clear()
    $names = @(Get-Places)
    $script:tabHasThumbs = [bool](@($names | Where-Object { Get-Thumb $byName[$_].Thumb }).Count)
    foreach ($n in $names) { [void]$tiles.Children.Add((New-Tile $byName[$n])) }
}

# One tab of the strip. The chosen one is filled; a click on another opens it.
function New-TabButton([hashtable] $One) {
    $T = $themes[$script:theme]
    $on = $One.Key -eq $script:tab
    $b = New-Object Windows.Controls.Border
    $b.CornerRadius = [Windows.CornerRadius]::new(19)
    $b.Padding = Get-Thick 24 9 24 9
    $b.Margin = Get-Thick 5 0 5 0
    $b.Background = Get-Brush $(if ($on) { $T.BtnFg } else { $T.BtnBg })
    $b.BorderBrush = Get-Brush $(if ($on) { $T.BtnFg } else { $T.BtnBorder })
    $b.BorderThickness = Get-Thick 1 1 1 1
    $b.Cursor = [Windows.Input.Cursors]::Hand
    $b.ToolTip = $One.Text
    $count = if ($One.Key -eq 'fav') { $script:favs.Count } else { @($script:order | Where-Object { $byName[$_].Tab -eq $One.Key }).Count }
    $b.Child = New-Text ($One.Title + '  ' + $count) 15 $(if ($on) { $T.CardBase } else { $T.BtnFg }) 'Bold'
    $b.Tag = $One.Key
    $b.add_MouseLeftButtonUp({
        param($s, $e)
        $e.Handled = $true
        if ($script:tab -eq $s.Tag) { return }
        $script:tab = [string]$s.Tag
        Save-Layout
        $window.Dispatcher.BeginInvoke([Action]{ Show-Page; Update-Status }) | Out-Null
    })
    return $b
}

function Show-Page {
    $T = $themes[$script:theme]
    $bg = New-Object Windows.Media.LinearGradientBrush
    $bg.StartPoint = [Windows.Point]::new(0, 0); $bg.EndPoint = [Windows.Point]::new(1, 1)
    $stops = $T.Bg
    $bg.GradientStops.Add([Windows.Media.GradientStop]::new((Get-Colour $stops[0]), 0))
    $bg.GradientStops.Add([Windows.Media.GradientStop]::new((Get-Colour $stops[1]), 0.55))
    $bg.GradientStops.Add([Windows.Media.GradientStop]::new((Get-Colour $stops[2]), 1))
    $window.Background = Get-Brush $stops[0]

    $scroll = New-Object Windows.Controls.ScrollViewer
    $scroll.VerticalScrollBarVisibility = 'Auto'
    $scroll.Background = $bg
    $page = New-Object Windows.Controls.StackPanel
    $page.Margin = Get-Thick 36 34 18 30
    $page.MaxWidth = 1060
    $page.HorizontalAlignment = 'Center'

    $heading = New-Text 'MTB — Контролна табла' 32 $T.Heading 'Bold'
    $heading.HorizontalAlignment = 'Center'
    [void]$page.Children.Add($heading)
    # The bar: what is always shown is the server's state and one button; the
    # help and every control fold away under it, as in the apps (owner,
    # 3 Oct 2026). Whether it is open is kept with the rest of the layout.
    $pill = New-Object Windows.Controls.Border
    $pill.CornerRadius = [Windows.CornerRadius]::new(20)
    $pill.Background = Get-Brush $T.Pill
    $pill.Padding = Get-Thick 16 6 6 6
    $pill.Margin = Get-Thick 0 16 18 0
    $pill.HorizontalAlignment = 'Center'
    $pillRow = New-Object Windows.Controls.StackPanel
    $pillRow.Orientation = 'Horizontal'
    $script:dot = New-Object Windows.Shapes.Ellipse
    $dot.Width = 11; $dot.Height = 11; $dot.VerticalAlignment = 'Center'
    $dot.Fill = Get-Brush '#9AA4B8'
    [void]$pillRow.Children.Add($dot)
    $script:status = New-Text 'Гледам што чека…' 13.5 $T.PillText 'SemiBold'
    $status.Margin = Get-Thick 10 0 10 0; $status.VerticalAlignment = 'Center'
    [void]$pillRow.Children.Add($status)
    $script:barButton = New-PillButton '' 'Покажи или скриј ги контролите' { Switch-Controls }
    [void]$pillRow.Children.Add($barButton)
    $pill.Child = $pillRow
    [void]$page.Children.Add($pill)

    # What is due, filled by Show-Reminders once the page is up.
    $script:remindBox = New-Object Windows.Controls.StackPanel
    $remindBox.Margin = Get-Thick 0 4 18 0
    [void]$page.Children.Add($remindBox)

    $script:controls = New-Object Windows.Controls.StackPanel
    $controls.Margin = Get-Thick 0 10 18 0

    $subText = if ($script:gridLocked) { 'Распоредот е заклучен: плочките стојат каде што се. Клик на плочка ја пушта; клик на иконата: бои.' }
               else { 'Клик на плочка ја пушта. Ѕвезда: плочката е и во „Омилени“. Повлечи ја врз друга за да ја преместиш. Игла: останува на своето место. Клик на иконата: бои.' }
    $sub = New-Text $subText 13.5 $T.Sub
    $sub.HorizontalAlignment = 'Center'; $sub.TextAlignment = 'Center'
    [void]$controls.Children.Add($sub)

    $buttons = New-Object Windows.Controls.WrapPanel
    $buttons.HorizontalAlignment = 'Center'
    $buttons.Margin = Get-Thick 0 10 0 0
    [void]$buttons.Children.Add((New-PillButton 'Освежи' 'Погледни пак: потсетниците и локалниот сервер' { Update-Status }))
    $themeText = if ($script:theme -eq 'dark') { 'Светла тема' } else { 'Темна тема' }
    [void]$buttons.Children.Add((New-PillButton $themeText 'Светла или темна; се памети на овој компјутер' {
        $script:theme = if ($script:theme -eq 'dark') { 'light' } else { 'dark' }
        Save-Layout
        $window.Dispatcher.BeginInvoke([Action]{ Show-Page; Update-Status }) | Out-Null
    }))
    $lockText = if ($script:gridLocked) { 'Отклучи распоред' } else { 'Заклучи распоред' }
    [void]$buttons.Children.Add((New-PillButton $lockText 'Заклучен: ниедна плочка не се мести' { Switch-GridLock }))
    [void]$buttons.Children.Add((New-PillButton 'Почетен распоред' 'Редоследот, омилените, иглите и боите како на почеток' {
        if ($script:gridLocked) { $footer.Text = 'Распоредот е заклучен — прво „Отклучи“.'; return }
        $script:order = New-Object Collections.ArrayList
        foreach ($a in $defaults) { [void]$script:order.Add($a.Name) }
        $script:pinned = @{}
        $script:colours = @{}
        $script:cardColours = @{}
        $script:favs = New-Object Collections.ArrayList
        foreach ($a in $defaults) { if ($a.Fav) { [void]$script:favs.Add($a.Name) } }
        Save-Layout
        $window.Dispatcher.BeginInvoke([Action]{ Show-Page; Update-Status; $footer.Text = 'Распоредот е вратен на почетниот.' }) | Out-Null
    }))
    # The settings as a file: kept and carried by hand, beside pCloud.
    [void]$buttons.Children.Add((New-PillButton 'Извези поставки' 'Зачувај ги редоследот, иглите, боите и темата во JSON фајл' {
        $window.Dispatcher.BeginInvoke([Action]{ Export-Layout }) | Out-Null
    }))
    [void]$buttons.Children.Add((New-PillButton 'Увези поставки' 'Вчитај поставки од JSON фајл што си го извезол' {
        $window.Dispatcher.BeginInvoke([Action]{ Import-Layout }) | Out-Null
    }))
    [void]$controls.Children.Add($buttons)
    [void]$page.Children.Add($controls)
    Set-ControlsShown

    # The tabs, always shown: they are the way around, not a setting.
    $strip = New-Object Windows.Controls.StackPanel
    $strip.Orientation = 'Horizontal'
    $strip.HorizontalAlignment = 'Center'
    $strip.Margin = Get-Thick 0 20 18 0
    foreach ($one in $tabs) { [void]$strip.Children.Add((New-TabButton $one)) }
    [void]$page.Children.Add($strip)
    $about = New-Text ([string]($tabs | Where-Object { $_.Key -eq $script:tab }).Text) 13.5 $T.Sub
    $about.HorizontalAlignment = 'Center'; $about.TextAlignment = 'Center'
    $about.Margin = Get-Thick 0 10 18 0
    [void]$page.Children.Add($about)

    # The local server's state and the copy's age belong with their tiles.
    $script:localLine = $null
    $script:copyLine = $null
    if ($script:tab -eq 'parked') {
        $script:localLine = New-Text 'Локалниот сервер: проверувам…' 13 $T.Sub
        $localLine.HorizontalAlignment = 'Center'; $localLine.TextAlignment = 'Center'
        $localLine.Margin = Get-Thick 0 8 18 0
        [void]$page.Children.Add($localLine)
        if (Test-MtbEnvKey 'MTB_MIRROR_READER_DATABASE_URL') {
            $script:copyLine = New-Text 'Копија од облакот: проверувам…' 13 $T.Sub
            $copyLine.HorizontalAlignment = 'Center'; $copyLine.TextAlignment = 'Center'
            $copyLine.Margin = Get-Thick 0 4 18 0
            [void]$page.Children.Add($copyLine)
        }
    }
    if ($script:tab -eq 'fav' -and -not $script:favs.Count) {
        $none = New-Text 'Тука уште нема ништо. Отвори друго јазиче и допри ја ѕвездата на плочката што ја користиш секој ден.' 14.5 $T.Body
        $none.HorizontalAlignment = 'Center'; $none.TextAlignment = 'Center'
        $none.Margin = Get-Thick 0 26 18 10
        [void]$page.Children.Add($none)
    }

    # Three columns whatever the window's width (it cannot get narrower than
    # three tiles), so a row is full before the next one starts.
    $script:tiles = New-Object Windows.Controls.Primitives.UniformGrid
    $tiles.Columns = if ($script:tab -eq 'parked') { 1 } else { 3 }
    $tiles.Margin = Get-Thick 0 16 0 0
    [void]$page.Children.Add($tiles)

    $script:footer = New-Text 'Описот е и во „PROCITAJ - sto pravi sekoja kratenka.txt“ во папката MTB.' 12.5 $T.Footer
    $footer.Margin = Get-Thick 2 12 18 0
    [void]$page.Children.Add($footer)

    Show-Tiles
    $scroll.Content = $page
    $window.Content = $scroll
}

try {
    Read-Layout
    if ($StartTab -in $tabKeys) { $script:tab = $StartTab }

    $window = New-Object Windows.Window
    $window.Title = 'MTB — Контролна табла'
    $window.Width = 1160; $window.Height = [Math]::Min(940, [Windows.SystemParameters]::WorkArea.Height - 40)
    $window.MinWidth = 1000; $window.MinHeight = 400
    $window.WindowStartupLocation = 'CenterScreen'
    $window.FontFamily = 'Segoe UI'
    Show-Page

    # A started action changes what the pill should say (the day opened, the
    # server stopped); look again once it has had time to do it.
    $refresh = New-Object Windows.Threading.DispatcherTimer
    $refresh.Interval = [TimeSpan]::FromSeconds(10)
    $refresh.add_Tick({ $refresh.Stop(); Update-Status })

    $window.add_Activated({ if ($script:rendered) { Update-Status } })
    $window.add_ContentRendered({
        $script:rendered = $true
        Update-Status
        if ($Snapshot) {
            $window.Dispatcher.Invoke([Action]{}, 'Background')
            $view = $window.Content
            $bmp = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$view.ActualWidth, [int]$view.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
            $bmp.Render($view)
            $png = [Windows.Media.Imaging.PngBitmapEncoder]::new()
            $png.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
            $out = [IO.File]::Create($Snapshot); $png.Save($out); $out.Close()
            $window.Close()
        }
    })
    if ($Snapshot) { $window.Height = 1600 }
    [void]$window.ShowDialog()
} catch {
    [void][MtbLauncher.Native]::ShowWindow($console, 5)
    $detail = "$($_.Exception.Message)"
    if ($_.InvocationInfo) { $detail += [Environment]::NewLine + $_.InvocationInfo.PositionMessage }
    [void][Windows.MessageBox]::Show("Контролната табла не тргна.`n`n$detail", 'MTB', 'OK', 'Error')
    exit 1
}
