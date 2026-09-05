# mtb.ps1 — the front door. One window that opens the day and closes it.
#
#   двоен клик на кратенката MTB          прозорец
#   ... -Console                          истото како текст, без прозорец
#   ... -Action start | stop | status     една фаза, без мени
#
# See docs/PLAN-start-stop.md for why each decision is the way it is.
#
# WHY A WINDOW AND NOT A CONSOLE. Not looks. A console window closed with X kills
# the process, so the end-of-day publish is simply skipped and nothing can be
# done about it. A Form raises FormClosing first, which can ask, run the closing
# procedures, and even cancel the close. The exit problem this whole thing was
# built around is a WinForms event.
#
# The two rules, unchanged from the console version and shared through
# procedures-lib.ps1:
#
#   On the way IN it gives up at the first FAIL. Apps opened on a server that
#   does not answer, or a database on the wrong migration, do not fail visibly —
#   they answer wrongly, which is worse than not opening.
#
#   On the way OUT it never gives up. A failed backup must not stop the publish;
#   a failed publish must not leave the server running.

param(
    [ValidateSet('run', 'start', 'stop', 'status')]
    [string] $Action = 'run',
    [int] $Port = 3000,
    [switch] $Console
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'procedures-lib.ps1')
$Ctx = New-MtbContext -ScriptsDir $PSScriptRoot -Port $Port

# ── text mode ───────────────────────────────────────────────────────────────

function Write-Result {
    param([pscustomobject] $R)
    $colour = switch ($R.Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ('  {0,-5}' -f $R.Status) -ForegroundColor $colour -NoNewline
    Write-Host (' {0,-11} ' -f $R.Label) -NoNewline
    Write-Host $R.Message
    if ($R.Fix) { Write-Host ('        ' + $R.Fix) -ForegroundColor DarkGray }
}

function Invoke-PhaseText {
    param([string] $Phase, [switch] $StopOnFail)
    $results = @()
    foreach ($p in (Get-MtbProcedures -ScriptsDir $PSScriptRoot -Phase $Phase)) {
        $r = Invoke-MtbProcedure -Procedure $p -Ctx $Ctx
        Write-Result $r
        $results += $r
        if ($StopOnFail -and $r.Status -eq 'FAIL') {
            Write-Host ''
            Write-Host '  Застанувам тука. Апликациите не се отвораат врз ова.' -ForegroundColor Red
            break
        }
    }
    return $results
}

function Invoke-StopText {
    Write-Host ''
    Write-Host 'Затворам го денот' -ForegroundColor Cyan
    $results = Invoke-PhaseText -Phase 'stop'        # без -StopOnFail, намерно
    $bad = @($results | Where-Object { $_.Status -eq 'FAIL' })
    Write-Host ''
    if ($bad.Count) {
        Write-Host "  $($bad.Count) чекор(и) не поминаа: $(($bad.Label) -join ', ')" -ForegroundColor Red
        return 1
    }
    Write-Host '  Готово. Може да се затвори.' -ForegroundColor Green
    return 0
}

function Start-TextMode {
    Write-Host ''
    Write-Host 'MTB' -ForegroundColor Cyan -NoNewline
    Write-Host "  $($Ctx.RepoRoot)"
    Write-Host ''

    if ($Action -eq 'status') { Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan; Write-Host ''; return 0 }
    if ($Action -eq 'stop')   { return (Invoke-StopText) }

    Write-Host 'Отворам го денот' -ForegroundColor Cyan
    $results = Invoke-PhaseText -Phase 'start' -StopOnFail
    Write-Host ''
    if (@($results | Where-Object { $_.Status -eq 'FAIL' }).Count) {
        Write-Host 'Поправи го горното па пушти пак.' -ForegroundColor Red
        Write-Host ''
        Read-Host 'Enter за затворање' | Out-Null
        return 1
    }
    if ($Action -eq 'start') { return 0 }

    while ($true) {
        Write-Host ''
        Write-Host ('  ' + (Get-MtbHealth -Ctx $Ctx).Line) -ForegroundColor Cyan
        Write-Host ''
        Write-Host '  [Enter]  заврши го денот — бекап, објава на pCloud, гаси сервер' -ForegroundColor Green
        Write-Host '  [O]      отвори ги апликациите пак'
        Write-Host '  [S]      состојба'
        Write-Host '  [Q]      само затвори — серверот останува, објава нема' -ForegroundColor DarkGray
        Write-Host ''
        try {
            $Host.UI.RawUI.FlushInputBuffer()
            $code = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown').VirtualKeyCode
        } catch {
            $typed = Read-Host '  избор'
            $code = if ($typed) { [int][char]([string]$typed).ToUpper()[0] } else { 13 }
        }
        switch ($code) {
            13 { return (Invoke-StopText) }
            79 { Invoke-MtbProcedure -Procedure ([pscustomobject]@{ Path = (Join-Path $PSScriptRoot 'procedures\start\50-open.ps1'); Label = 'open' }) -Ctx $Ctx | Out-Null }
            81 { Write-Host ''; Write-Host '  Серверот останува вклучен. Објавата не е направена.' -ForegroundColor Yellow; Write-Host ''; return 0 }
            default { }
        }
    }
}

# Text mode for everything except the plain double-click: -Console when asked,
# and always for a single phase, because those are run by scheduled tasks and by
# hand, where a window would be in the way.
if ($Console -or $Action -ne 'run') { exit (Start-TextMode) }

# ── window ──────────────────────────────────────────────────────────────────

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch {
    # The shortcut starts this minimised, so a silent fall-back would look like
    # nothing happened at all. Open a visible console instead.
    Start-Process powershell.exe -ArgumentList @(
        '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Console'
    )
    exit 0
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$ui = @{}
$script:DayClosed = $false
$script:Busy      = $false

$form                 = New-Object System.Windows.Forms.Form
$form.Text            = 'MTB'
$form.Size            = New-Object System.Drawing.Size(620, 470)
$form.StartPosition   = 'CenterScreen'
$form.Font            = New-Object System.Drawing.Font('Segoe UI', 9)
$form.AutoScaleMode   = 'Dpi'
$form.MinimumSize     = New-Object System.Drawing.Size(520, 380)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path) } catch { }

$header               = New-Object System.Windows.Forms.Panel
$header.Dock          = 'Top'
$header.Height        = 58
$header.BackColor     = [System.Drawing.Color]::FromArgb(240, 243, 247)
$form.Controls.Add($header)

$title                = New-Object System.Windows.Forms.Label
$title.Text           = 'MTB'
$title.Font           = New-Object System.Drawing.Font('Segoe UI Semibold', 13)
$title.Location       = New-Object System.Drawing.Point(14, 8)
$title.AutoSize       = $true
$header.Controls.Add($title)

$identity             = New-Object System.Windows.Forms.Label
$identity.Text        = 'се подига…'
$identity.Location    = New-Object System.Drawing.Point(16, 33)
$identity.AutoSize    = $true
$identity.ForeColor   = [System.Drawing.Color]::FromArgb(70, 80, 95)
$header.Controls.Add($identity)

$buttons              = New-Object System.Windows.Forms.Panel
$buttons.Dock         = 'Bottom'
$buttons.Height       = 80
$form.Controls.Add($buttons)

function New-Button {
    param([string] $Text, [int] $X, [int] $Width, [bool] $Primary = $false)
    $b            = New-Object System.Windows.Forms.Button
    $b.Text       = $Text
    $b.Width      = $Width
    $b.Height     = 32
    $b.Location   = New-Object System.Drawing.Point($X, 12)
    $b.Anchor     = 'Bottom,Left'
    $b.FlatStyle  = 'System'
    if ($Primary) { $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9) }
    $buttons.Controls.Add($b)
    return $b
}

$btnFinish = New-Button -Text 'Заврши го денот' -X 14  -Width 150 -Primary $true
$btnOpen   = New-Button -Text 'Отвори апликации' -X 174 -Width 140
$btnRefresh= New-Button -Text 'Состојба'         -X 324 -Width 100

# Anchored, not docked. Docking order in WinForms follows z-order, so the last
# docked control silently loses its space to a Fill added before it — a layout
# that looks right until the window is resized.
$list                 = New-Object System.Windows.Forms.ListView
$list.Location        = New-Object System.Drawing.Point(0, $header.Height)
$list.Size            = New-Object System.Drawing.Size($form.ClientSize.Width, ($form.ClientSize.Height - $header.Height - $buttons.Height))
$list.Anchor          = 'Top,Bottom,Left,Right'
$list.View            = 'Details'
$list.FullRowSelect   = $true
$list.GridLines       = $false
$list.HeaderStyle     = 'Nonclickable'
$list.BorderStyle     = 'None'
[void]$list.Columns.Add('', 58)
[void]$list.Columns.Add('чекор', 100)
[void]$list.Columns.Add('', 420)
$form.Controls.Add($list)

# Inside the button strip, so no third docked control fights for leftover space.
$status               = New-Object System.Windows.Forms.Label
$status.Location      = New-Object System.Drawing.Point(16, 52)
$status.Size          = New-Object System.Drawing.Size(560, 20)
$status.Anchor        = 'Bottom,Left,Right'
$status.ForeColor     = [System.Drawing.Color]::FromArgb(90, 100, 115)
$status.Text          = ''
$buttons.Controls.Add($status)

function Add-Row {
    param([pscustomobject] $R)
    $item = New-Object System.Windows.Forms.ListViewItem($R.Status)
    [void]$item.SubItems.Add($R.Label)
    $text = $R.Message
    if ($R.Fix) { $text = "$text   ($($R.Fix))" }
    [void]$item.SubItems.Add($text)
    $item.ForeColor = switch ($R.Status) {
        'OK'   { [System.Drawing.Color]::FromArgb(20, 120, 60) }
        'WARN' { [System.Drawing.Color]::FromArgb(150, 100, 0) }
        default{ [System.Drawing.Color]::FromArgb(180, 30, 30) }
    }
    [void]$list.Items.Add($item)
    $item.EnsureVisible()
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-Busy {
    param([bool] $On, [string] $Text = '')
    $script:Busy = $On
    $btnFinish.Enabled  = -not $On
    $btnOpen.Enabled    = -not $On
    $btnRefresh.Enabled = -not $On
    $status.Text = $Text
    $form.Cursor = if ($On) { 'WaitCursor' } else { 'Default' }
    [System.Windows.Forms.Application]::DoEvents()
}

function Update-Identity {
    $h = Get-MtbHealth -Ctx $Ctx
    $identity.Text = $h.Line
    $identity.ForeColor = if ($h.Ok) {
        [System.Drawing.Color]::FromArgb(70, 80, 95)
    } else {
        [System.Drawing.Color]::FromArgb(180, 30, 30)
    }
}

function Invoke-PhaseUi {
    param([string] $Phase, [switch] $StopOnFail)
    $results = @()
    foreach ($p in (Get-MtbProcedures -ScriptsDir $PSScriptRoot -Phase $Phase)) {
        Set-Busy -On $true -Text "$($p.Label)…"
        $r = Invoke-MtbProcedure -Procedure $p -Ctx $Ctx
        Add-Row $r
        $results += $r
        if ($StopOnFail -and $r.Status -eq 'FAIL') { break }
    }
    return $results
}

function Close-Day {
    if ($script:DayClosed -or $script:Busy) { return $true }
    $list.Items.Clear()
    $sep = New-Object System.Windows.Forms.ListViewItem('')
    [void]$sep.SubItems.Add('')
    [void]$sep.SubItems.Add('Затворам го денот')
    $sep.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
    [void]$list.Items.Add($sep)

    $results = Invoke-PhaseUi -Phase 'stop'          # без -StopOnFail, намерно
    $bad = @($results | Where-Object { $_.Status -eq 'FAIL' })
    $script:DayClosed = $true
    Update-Identity
    if ($bad.Count) {
        Set-Busy -On $false -Text "$($bad.Count) чекор(и) не поминаа: $(($bad.Label) -join ', ')"
        [void][System.Windows.Forms.MessageBox]::Show(
            "Не сè помина:`n`n$(($bad | ForEach-Object { "$($_.Label): $($_.Message)" }) -join "`n")",
            'MTB', 'OK', 'Warning')
        return $false
    }
    Set-Busy -On $false -Text 'Денот е затворен. Бекап направен, snapshot објавен, серверот спуштен.'
    return $true
}

$btnOpen.Add_Click({
    Set-Busy -On $true -Text 'отворам…'
    $open = [pscustomobject]@{ Path = (Join-Path $PSScriptRoot 'procedures\start\50-open.ps1'); Label = 'open' }
    $r = Invoke-MtbProcedure -Procedure $open -Ctx $Ctx
    Add-Row $r
    Set-Busy -On $false
})

$btnRefresh.Add_Click({
    Set-Busy -On $true -Text 'проверувам…'
    Update-Identity
    Set-Busy -On $false -Text ''
})

$btnFinish.Add_Click({
    if ([System.Windows.Forms.MessageBox]::Show(
            'Бекап, објава на pCloud и гасење на серверот. Да продолжам?',
            'Заврши го денот', 'YesNo', 'Question') -ne 'Yes') { return }
    if (Close-Day) { $form.Close() }
})

# The whole reason this is a window: X can be answered instead of obeyed.
$form.Add_FormClosing({
    param($sender, $e)
    if ($script:Busy) { $e.Cancel = $true; return }
    if ($script:DayClosed) { return }
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Денот не е затворен.`n`nДа — бекап, објава на pCloud, гасење на серверот." +
        "`nНе — само затвори; серверот останува и објава нема." ,
        'MTB', 'YesNoCancel', 'Warning')
    switch ($answer) {
        'Yes'    { $e.Cancel = $true; if (Close-Day) { $form.Close() } }
        'Cancel' { $e.Cancel = $true }
        default  { }
    }
})

$form.Add_Shown({
    $form.Activate()
    $results = Invoke-PhaseUi -Phase 'start' -StopOnFail
    Update-Identity
    if (@($results | Where-Object { $_.Status -eq 'FAIL' }).Count) {
        Set-Busy -On $false -Text 'Застанав. Апликациите не се отворени врз ова.'
        $script:DayClosed = $true      # ништо не почна, па нема што да се затвора
        $btnFinish.Enabled = $false
    } else {
        Set-Busy -On $false -Text 'Денот е отворен.'
    }
})

[void]$form.ShowDialog()
