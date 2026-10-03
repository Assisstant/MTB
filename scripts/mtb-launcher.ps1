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
#   powershell -ExecutionPolicy Bypass -File scripts\mtb-launcher.ps1

param(
    [int] $Port = 3000,
    # Render the window to a PNG and close: how its look is checked without a click.
    [string] $Snapshot = ''
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
. (Join-Path $PSScriptRoot 'mtb-actions.ps1')

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

# ── one tile ────────────────────────────────────────────────────────────────
function New-Tile([hashtable] $A) {
    $card = New-Object Windows.Controls.Border
    $card.Width = 322
    $card.Height = 272
    $card.Margin = Get-Thick 0 0 18 18
    $card.Padding = Get-Thick 22 20 22 18
    $card.CornerRadius = [Windows.CornerRadius]::new(18)
    $card.Background = Get-Brush '#EEFFFFFF'
    $card.BorderBrush = Get-Brush '#162F6FE4'
    $card.BorderThickness = Get-Thick 1.5 1.5 1.5 1.5
    $card.Cursor = [Windows.Input.Cursors]::Hand
    $card.ToolTip = 'Кликни за да се пушти „' + $A.Name + '“'
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
    $when.Margin = Get-Thick 0 10 0 0
    $tint = (Get-Brush $A.Color).Clone(); $tint.Opacity = 0.10
    $when.Background = $tint
    $whenText = New-Text ('Кога: ' + $A.When) 12.5 '#33405E' 'SemiBold'
    $when.Child = $whenText
    [Windows.Controls.DockPanel]::SetDock($when, 'Bottom')
    [void]$dock.Children.Add($when)

    $stack = New-Object Windows.Controls.StackPanel
    $head = New-Object Windows.Controls.StackPanel
    $head.Orientation = 'Horizontal'

    $chip = New-Object Windows.Controls.Border
    $chip.Width = 48; $chip.Height = 48
    $chip.CornerRadius = [Windows.CornerRadius]::new(14)
    $chip.Background = Get-Brush $A.Color
    $glyph = New-Text ([string][char]$A.Glyph) 21 '#FFFFFF'
    $glyph.FontFamily = 'Segoe MDL2 Assets'
    $glyph.HorizontalAlignment = 'Center'; $glyph.VerticalAlignment = 'Center'
    $chip.Child = $glyph
    [void]$head.Children.Add($chip)

    $names = New-Object Windows.Controls.StackPanel
    $names.Margin = Get-Thick 14 1 0 0
    $names.VerticalAlignment = 'Center'
    $title = New-Text $A.Title 17.5 '#1B2A4E' 'Bold'
    $short = New-Text ('кратенка: ' + $A.Name) 11.5 '#7D88A3'
    [void]$names.Children.Add($title)
    [void]$names.Children.Add($short)
    [void]$head.Children.Add($names)
    [void]$stack.Children.Add($head)

    $body = New-Text $A.Text 13.5 '#3B4663'
    $body.Margin = Get-Thick 0 14 0 0
    $body.LineHeight = 20
    [void]$stack.Children.Add($body)
    [void]$dock.Children.Add($stack)
    $card.Child = $dock

    $card.add_MouseEnter({
        param($s, $e)
        $s.BorderBrush = Get-Brush $s.Tag.Color
        $s.Effect.Opacity = 0.22
    })
    $card.add_MouseLeave({
        param($s, $e)
        $s.BorderBrush = Get-Brush '#162F6FE4'
        $s.Effect.Opacity = 0.10
    })
    $card.add_MouseLeftButtonUp({ param($s, $e) Start-Action $s.Tag })
    return $card
}

# ── running one ─────────────────────────────────────────────────────────────
function Start-Action([hashtable] $A) {
    if ($A.Confirm) {
        $answer = [Windows.MessageBox]::Show($window, $A.Confirm, $A.Title, 'YesNo', 'Question')
        if ($answer -ne 'Yes') { return }
    }
    $script = Join-Path $PSScriptRoot $A.Script
    $argv = @('-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
    if ($A.Args) { $argv += @($A.Args -split ' ' | Where-Object { $_ }) }
    try {
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
        $status.Text = "Серверот работи · $label · база $($h.database)"
    } catch {
        $dot.Fill = Get-Brush '#D64545'
        $status.Text = 'Серверот не е вклучен — „Отвори го денот“ го вклучува.'
    }
}

try {
    $window = New-Object Windows.Window
    $window.Title = 'MTB — Контролна табла'
    $window.Width = 1140; $window.Height = [Math]::Min(940, [Windows.SystemParameters]::WorkArea.Height - 40)
    $window.MinWidth = 420; $window.MinHeight = 400
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
    $sub = New-Text 'Секоја плочка е една кратенка од папката MTB. Кликни за да ја пуштиш — се отвора во свој прозорец.' 14 '#56627F'
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
    $again = New-Object Windows.Controls.Button
    $again.Content = 'Освежи'
    $again.Padding = Get-Thick 12 4 12 4
    $again.Background = Get-Brush '#E6EEFC'; $again.BorderBrush = Get-Brush '#C9D8F5'
    $again.Foreground = Get-Brush '#2563D9'; $again.Cursor = [Windows.Input.Cursors]::Hand
    $again.add_Click({ Update-Status })
    [void]$pillRow.Children.Add($again)
    $pill.Child = $pillRow
    [void]$page.Children.Add($pill)

    $actions = @(Get-MtbActions)
    foreach ($g in Get-MtbActionGroups) {
        $members = @($actions | Where-Object { $_.Group -eq $g.Key })
        if (-not $members.Count) { continue }
        $gt = New-Text $g.Title.ToUpper() 13 '#5A6785' 'Bold'
        $gt.Margin = Get-Thick 2 22 0 12
        [void]$page.Children.Add($gt)
        $wrap = New-Object Windows.Controls.WrapPanel
        foreach ($a in $members) { [void]$wrap.Children.Add((New-Tile $a)) }
        [void]$page.Children.Add($wrap)
    }

    $footer = New-Text 'Описот е и во „PROCITAJ - sto pravi sekoja kratenka.txt“ во истата папка.' 12.5 '#6A7590'
    $footer.Margin = Get-Thick 2 12 18 0
    [void]$page.Children.Add($footer)

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
    if ($Snapshot) { $window.Height = 1500 }
    [void]$window.ShowDialog()
} catch {
    [void][MtbLauncher.Native]::ShowWindow($console, 5)
    $detail = "$($_.Exception.Message)"
    if ($_.InvocationInfo) { $detail += [Environment]::NewLine + $_.InvocationInfo.PositionMessage }
    [void][Windows.MessageBox]::Show("Контролната табла не тргна.`n`n$detail", 'MTB', 'OK', 'Error')
    exit 1
}
