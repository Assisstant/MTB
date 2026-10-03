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
# The order of the tiles is this computer's own layout
# (%LOCALAPPDATA%\MTB\kontrolna-tabla.json), never data: drag a tile onto
# another to move it. One grid, three to a row — no sections, no pins.
#
#   powershell -ExecutionPolicy Bypass -File scripts\mtb-launcher.ps1

param(
    [int] $Port = 3000,
    # Render the window to a PNG and close: how its look is checked without a click.
    [string] $Snapshot = '',
    # Another layout file, so a check never touches the person's own.
    [string] $LayoutFile = ''
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
if (-not $LayoutFile) { $LayoutFile = Join-Path $env:LOCALAPPDATA 'MTB\kontrolna-tabla.json' }

function Get-Brush([string] $Hex) { [Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
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

# ── the layout: one order, per computer ─────────────────────────────────────
function Read-Layout {
    $savedOrder = @()
    try {
        if (Test-Path -LiteralPath $LayoutFile) {
            $j = Get-Content -LiteralPath $LayoutFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $savedOrder = @($j.order)
        }
    } catch { }
    # What the file names, in its order; an action it does not know yet (added
    # since) goes in at its own place in the default list, not at the end.
    $order = New-Object Collections.ArrayList
    foreach ($n in $savedOrder) { if ($byName.ContainsKey($n) -and -not $order.Contains($n)) { [void]$order.Add($n) } }
    for ($i = 0; $i -lt $defaults.Count; $i++) {
        $n = $defaults[$i].Name
        if (-not $order.Contains($n)) { $order.Insert([Math]::Min($i, $order.Count), $n) }
    }
    $script:order = $order
}

function Save-Layout {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LayoutFile) | Out-Null
        @{ order = @($script:order) } | ConvertTo-Json | Set-Content -LiteralPath $LayoutFile -Encoding UTF8
    } catch {
        $footer.Text = 'Распоредот не е зачуван: ' + $_.Exception.Message
    }
}

# Dropping $From on $To puts it where $To is, anywhere in the grid. The owner
# (3 Oct 2026): no sections and no pins — one grid, three to a row, filled in
# order, and the order is whatever the tiles were dragged into.
function Move-Tile([string] $From, [string] $To) {
    if ($From -eq $To) { return }
    $wasBefore = $script:order.IndexOf($From) -lt $script:order.IndexOf($To)
    $script:order.Remove($From)
    $at = $script:order.IndexOf($To)
    if ($wasBefore) { $at++ }
    $script:order.Insert($at, $From)
    Save-Layout
    Show-Tiles
}

# ── one tile ────────────────────────────────────────────────────────────────
$idleBorder = '#162F6FE4'

function New-Tile([hashtable] $A) {
    $card = New-Object Windows.Controls.Border
    $card.Height = 272
    $card.Margin = Get-Thick 0 0 18 18
    $card.Padding = Get-Thick 22 20 18 18
    $card.CornerRadius = [Windows.CornerRadius]::new(18)
    $card.Background = Get-Brush '#EEFFFFFF'
    $card.BorderBrush = Get-Brush $idleBorder
    $card.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5
    $card.Cursor = [Windows.Input.Cursors]::Hand
    $card.ToolTip = 'Клик: се пушта. Повлечи врз друга плочка: се преместува.'
    $card.AllowDrop = $true
    $shadow = New-Object Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 22; $shadow.ShadowDepth = 3; $shadow.Opacity = 0.10
    $shadow.Color = [Windows.Media.ColorConverter]::ConvertFromString('#2A4A8F')
    $card.Effect = $shadow
    $card.Tag = $A

    $dock = New-Object Windows.Controls.DockPanel
    $dock.LastChildFill = $true

    # „when" sits at the bottom of every tile, so a row of tiles reads level.
    $when = New-Object Windows.Controls.Border
    $when.CornerRadius = [Windows.CornerRadius]::new(10)
    $when.Padding = Get-Thick 10 6 10 6
    $when.Margin = Get-Thick 0 10 4 0
    $tint = (Get-Brush $A.Color).Clone(); $tint.Opacity = 0.10
    $when.Background = $tint
    $when.Child = New-Text ('Кога: ' + $A.When) 12.5 '#33405E' 'SemiBold'
    [Windows.Controls.DockPanel]::SetDock($when, 'Bottom')
    [void]$dock.Children.Add($when)

    $stack = New-Object Windows.Controls.StackPanel
    $head = New-Object Windows.Controls.DockPanel

    # A grip in the corner says the tile can be dragged; it does nothing itself.
    $grip = New-Text ([string][char]0xE700) 14 '#B4BCCD'
    $grip.FontFamily = 'Segoe MDL2 Assets'
    $grip.VerticalAlignment = 'Top'
    $grip.Margin = Get-Thick 6 4 0 0
    $grip.ToolTip = 'Повлечи врз друга плочка за да ја преместиш'
    [Windows.Controls.DockPanel]::SetDock($grip, 'Right')
    [void]$head.Children.Add($grip)

    $chip = New-Object Windows.Controls.Border
    $chip.Width = 48; $chip.Height = 48
    $chip.CornerRadius = [Windows.CornerRadius]::new(14)
    $chip.Background = Get-Brush $A.Color
    $glyph = New-Text ([string][char]$A.Glyph) 21 '#FFFFFF'
    $glyph.FontFamily = 'Segoe MDL2 Assets'
    $glyph.HorizontalAlignment = 'Center'; $glyph.VerticalAlignment = 'Center'
    $chip.Child = $glyph
    [Windows.Controls.DockPanel]::SetDock($chip, 'Left')
    [void]$head.Children.Add($chip)

    $names = New-Object Windows.Controls.StackPanel
    $names.Margin = Get-Thick 14 1 4 0
    $names.VerticalAlignment = 'Center'
    [void]$names.Children.Add((New-Text $A.Title 17.5 '#1B2A4E' 'Bold'))
    if ($A.UrlKey) {
        $url = Get-EnvValue $A.UrlKey
        $where = if ($url -match '^https?://([^/]+)') { 'во прелистувач · ' + $Matches[1] } else { 'во прелистувач · адресата се внесува при прв клик' }
    } else {
        $where = 'кратенка: ' + $A.Name
    }
    # The section a tile used to sit in is now a word on it.
    $where += ' · ' + $groupWord[$A.Group]
    [void]$names.Children.Add((New-Text $where 11.5 '#7D88A3'))
    [void]$head.Children.Add($names)
    [void]$stack.Children.Add($head)

    $body = New-Text $A.Text 13.5 '#3B4663'
    $body.Margin = Get-Thick 0 14 4 0
    $body.LineHeight = 20
    [void]$stack.Children.Add($body)
    [void]$dock.Children.Add($stack)
    $card.Child = $dock

    $card.add_MouseEnter({ param($s, $e) $s.BorderBrush = Get-Brush $s.Tag.Color; $s.Effect.Opacity = 0.22 })
    $card.add_MouseLeave({ param($s, $e) $s.BorderBrush = Get-Brush $idleBorder; $s.Effect.Opacity = 0.10 })

    # A click runs it; a press that moves more than a few pixels is a drag.
    $card.add_PreviewMouseLeftButtonDown({
        param($s, $e)
        $script:pressAt = $e.GetPosition($window); $script:pressed = $s; $script:dragged = $false
    })
    $card.add_PreviewMouseMove({
        param($s, $e)
        if ($e.LeftButton -ne 'Pressed' -or $script:pressed -ne $s -or $script:dragged) { return }
        $now = $e.GetPosition($window)
        if ([Math]::Abs($now.X - $script:pressAt.X) -lt 8 -and [Math]::Abs($now.Y - $script:pressAt.Y) -lt 8) { return }
        $script:dragged = $true
        $s.Opacity = 0.45
        [void][Windows.DragDrop]::DoDragDrop($s, [Windows.DataObject]::new('mtb-tile', $s.Tag.Name), 'Move')
        $s.Opacity = 1
        $script:pressed = $null
    })
    $card.add_MouseLeftButtonUp({
        param($s, $e)
        if ($script:pressed -eq $s -and -not $script:dragged) { $script:pressed = $null; Start-Action $s.Tag }
    })
    $card.add_DragEnter({ param($s, $e) $s.BorderBrush = Get-Brush '#2563D9'; $s.BorderThickness = Get-Thick 3 3 3 3 })
    $card.add_DragLeave({ param($s, $e) $s.BorderBrush = Get-Brush $idleBorder; $s.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5 })
    $card.add_Drop({
        param($s, $e)
        $e.Handled = $true
        $script:dropFrom = [string]$e.Data.GetData('mtb-tile')
        $script:dropTo = $s.Tag.Name
        # The redraw replaces every tile, this one too: it must not happen
        # inside the drag loop that still holds the dragged tile. Not a
        # GetNewClosure(): a closure no longer sees this script's functions.
        $window.Dispatcher.BeginInvoke([Action]{ Move-Tile $script:dropFrom $script:dropTo }) | Out-Null
    })
    return $card
}

# ── the tiles: one grid, three to a row, in this computer's order ──────────
function Show-Tiles {
    $tiles.Children.Clear()
    foreach ($n in $script:order) { [void]$tiles.Children.Add((New-Tile $byName[$n])) }
}

# ── running one ─────────────────────────────────────────────────────────────
function Open-Page([hashtable] $A) {
    $url = Get-EnvValue $A.UrlKey
    if (-not $url) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        $url = [Microsoft.VisualBasic.Interaction]::InputBox(
            'Адресата на облачниот работен простор, на пример https://…/MTB-Workspace.html' + [Environment]::NewLine + [Environment]::NewLine +
            'Се запишува во server\.env на овој компјутер (' + $A.UrlKey + '), не во репото.', 'MTB — ' + $A.Title, '').Trim()
        if (-not $url) { return }
        if ($url -notmatch '^https://[^/\s]+') {
            [void][Windows.MessageBox]::Show($window, 'Тоа не е адреса што почнува со https:// — ништо не е запишано.', 'MTB', 'OK', 'Warning')
            return
        }
        Add-EnvValue $A.UrlKey $url
        Show-Tiles
    }
    Start-Process $url
    $footer.Text = 'Отворено во прелистувачот: ' + $url
}

function Start-Action([hashtable] $A) {
    if ($A.Confirm) {
        $answer = [Windows.MessageBox]::Show($window, $A.Confirm, $A.Title, 'YesNo', 'Question')
        if ($answer -ne 'Yes') { return }
    }
    try {
        if ($A.UrlKey) { Open-Page $A; return }
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
function Update-Status {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        $label = if ($h.server.label) { $h.server.label } else { 'СЕРВЕР' }
        $dot.Fill = Get-Brush $(if ($h.ok) { '#2E9B4F' } else { '#E0A21B' })
        $status.Text = "Локалниот сервер работи · $label · база $($h.database)"
    } catch {
        $dot.Fill = Get-Brush '#D64545'
        $status.Text = 'Локалниот сервер не е вклучен — „Отвори го денот“ го вклучува.'
    }
}

function New-PillButton([string] $Text) {
    $b = New-Object Windows.Controls.Button
    $b.Content = $Text
    $b.Padding = Get-Thick 12 4 12 4
    $b.Margin = Get-Thick 0 0 4 0
    $b.Background = Get-Brush '#E6EEFC'; $b.BorderBrush = Get-Brush '#C9D8F5'
    $b.Foreground = Get-Brush '#2563D9'; $b.Cursor = [Windows.Input.Cursors]::Hand
    return $b
}

try {
    Read-Layout

    $window = New-Object Windows.Window
    $window.Title = 'MTB — Контролна табла'
    $window.Width = 1140; $window.Height = [Math]::Min(940, [Windows.SystemParameters]::WorkArea.Height - 40)
    $window.MinWidth = 1000; $window.MinHeight = 400
    $window.WindowStartupLocation = 'CenterScreen'
    $window.FontFamily = 'Segoe UI'
    $bg = New-Object Windows.Media.LinearGradientBrush
    $bg.StartPoint = [Windows.Point]::new(0, 0); $bg.EndPoint = [Windows.Point]::new(1, 1)
    foreach ($stop in @(@('#DCE8FB', 0), @('#ECE7FA', 0.55), @('#D3F0E4', 1))) {
        $bg.GradientStops.Add([Windows.Media.GradientStop]::new([Windows.Media.ColorConverter]::ConvertFromString($stop[0]), $stop[1]))
    }

    $scroll = New-Object Windows.Controls.ScrollViewer
    $scroll.VerticalScrollBarVisibility = 'Auto'
    $scroll.Background = $bg
    $page = New-Object Windows.Controls.StackPanel
    $page.Margin = Get-Thick 36 34 18 30
    $page.MaxWidth = 1040
    $page.HorizontalAlignment = 'Center'

    $heading = New-Text 'MTB — Контролна табла' 32 '#2563D9' 'Bold'
    $heading.HorizontalAlignment = 'Center'
    [void]$page.Children.Add($heading)
    $sub = New-Text 'Клик на плочка ја пушта. Повлечи ја врз друга за да ја преместиш — редоследот се памети на овој компјутер.' 14 '#56627F'
    $sub.HorizontalAlignment = 'Center'; $sub.TextAlignment = 'Center'
    $sub.Margin = Get-Thick 0 8 18 0
    [void]$page.Children.Add($sub)

    # The status pill: one look before a click says which machine this is.
    $pill = New-Object Windows.Controls.Border
    $pill.CornerRadius = [Windows.CornerRadius]::new(20)
    $pill.Background = Get-Brush '#F2FFFFFF'
    $pill.Padding = Get-Thick 16 8 8 8
    $pill.Margin = Get-Thick 0 18 18 8
    $pill.HorizontalAlignment = 'Center'
    $pillRow = New-Object Windows.Controls.StackPanel
    $pillRow.Orientation = 'Horizontal'
    $dot = New-Object Windows.Shapes.Ellipse
    $dot.Width = 11; $dot.Height = 11; $dot.VerticalAlignment = 'Center'
    $dot.Fill = Get-Brush '#9AA4B8'
    [void]$pillRow.Children.Add($dot)
    $status = New-Text 'Проверувам го серверот…' 13.5 '#2B3655' 'SemiBold'
    $status.Margin = Get-Thick 10 0 12 0; $status.VerticalAlignment = 'Center'
    [void]$pillRow.Children.Add($status)
    $again = New-PillButton 'Освежи'
    $again.add_Click({ Update-Status })
    [void]$pillRow.Children.Add($again)
    $reset = New-PillButton 'Почетен распоред'
    $reset.ToolTip = 'Редоследот како што беше на почеток'
    $reset.add_Click({
        $script:order = New-Object Collections.ArrayList
        foreach ($a in $defaults) { [void]$script:order.Add($a.Name) }
        Save-Layout
        Show-Tiles
        $footer.Text = 'Распоредот е вратен на почетниот.'
    })
    [void]$pillRow.Children.Add($reset)
    $pill.Child = $pillRow
    [void]$page.Children.Add($pill)

    # Three columns whatever the window's width (it cannot get narrower than
    # three tiles), so a row is full before the next one starts.
    $tiles = New-Object Windows.Controls.Primitives.UniformGrid
    $tiles.Columns = 3
    $tiles.Margin = Get-Thick 0 18 0 0
    [void]$page.Children.Add($tiles)

    $footer = New-Text 'Описот е и во „PROCITAJ - sto pravi sekoja kratenka.txt“ во папката MTB.' 12.5 '#6A7590'
    $footer.Margin = Get-Thick 2 12 18 0
    [void]$page.Children.Add($footer)

    Show-Tiles
    $scroll.Content = $page
    $window.Content = $scroll

    # A started action changes what the pill should say (the day opened, the
    # server stopped); look again once it has had time to do it.
    $refresh = New-Object Windows.Threading.DispatcherTimer
    $refresh.Interval = [TimeSpan]::FromSeconds(10)
    $refresh.add_Tick({ $refresh.Stop(); Update-Status })

    $window.add_ContentRendered({
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
    if ($Snapshot) { $window.Height = 1800 }
    [void]$window.ShowDialog()
} catch {
    [void][MtbLauncher.Native]::ShowWindow($console, 5)
    $detail = "$($_.Exception.Message)"
    if ($_.InvocationInfo) { $detail += [Environment]::NewLine + $_.InvocationInfo.PositionMessage }
    [void][Windows.MessageBox]::Show("Контролната табла не тргна.`n`n$detail", 'MTB', 'OK', 'Error')
    exit 1
}
