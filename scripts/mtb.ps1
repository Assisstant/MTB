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

# NOTHING SLOW MAY RUN ON THIS THREAD. Waiting for the API to answer takes most
# of a minute; do it here and Windows stops receiving messages from the window,
# marks it "not responding" and paints it black — so the app looks broken at
# exactly the moment it is working. The phase runs in its own runspace and this
# thread only drains its queue on a timer.
$script:Phase      = $null      # the running phase, or $null
$script:PhaseKind  = ''         # 'start' | 'stop'
$script:Results    = @()
$script:DayClosed  = $false
$script:CloseAfter = $false

$form                 = New-Object System.Windows.Forms.Form
$form.Text            = 'MTB'
$form.Size            = New-Object System.Drawing.Size(660, 480)
$form.StartPosition   = 'CenterScreen'
$form.Font            = New-Object System.Drawing.Font('Segoe UI', 9)
$form.AutoScaleMode   = 'Dpi'
$form.MinimumSize     = New-Object System.Drawing.Size(540, 380)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path) } catch { }

$header               = New-Object System.Windows.Forms.Panel
$header.Dock          = 'Top'
$header.Height        = 60
$header.BackColor     = [System.Drawing.Color]::FromArgb(243, 246, 250)
$form.Controls.Add($header)

$title                = New-Object System.Windows.Forms.Label
$title.Text           = 'MTB'
$title.Font           = New-Object System.Drawing.Font('Segoe UI Semibold', 14)
$title.Location       = New-Object System.Drawing.Point(14, 8)
$title.AutoSize       = $true
$header.Controls.Add($title)

$identity             = New-Object System.Windows.Forms.Label
$identity.Text        = 'се подига…'
$identity.Location    = New-Object System.Drawing.Point(16, 36)
$identity.AutoSize    = $true
$identity.ForeColor   = [System.Drawing.Color]::FromArgb(70, 80, 95)
$header.Controls.Add($identity)

$buttons              = New-Object System.Windows.Forms.Panel
$buttons.Dock         = 'Bottom'
$buttons.Height       = 82
$form.Controls.Add($buttons)

$btnFinish            = New-Object System.Windows.Forms.Button
$btnFinish.Text       = 'Заврши го денот'
$btnFinish.Font       = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
$btnFinish.SetBounds(14, 12, 155, 32)
$btnFinish.FlatStyle  = 'System'
$buttons.Controls.Add($btnFinish)

$btnOpen              = New-Object System.Windows.Forms.Button
$btnOpen.Text         = 'Отвори апликации'
$btnOpen.SetBounds(179, 12, 145, 32)
$btnOpen.FlatStyle    = 'System'
$buttons.Controls.Add($btnOpen)

$btnRefresh           = New-Object System.Windows.Forms.Button
$btnRefresh.Text      = 'Состојба'
$btnRefresh.SetBounds(334, 12, 100, 32)
$btnRefresh.FlatStyle = 'System'
$buttons.Controls.Add($btnRefresh)

$status               = New-Object System.Windows.Forms.Label
$status.SetBounds(16, 52, 600, 20)
$status.Anchor        = 'Bottom,Left,Right'
$status.ForeColor     = [System.Drawing.Color]::FromArgb(90, 100, 115)
$status.Text          = ''
$buttons.Controls.Add($status)

# Anchored, not docked: docking order in WinForms follows z-order, so a Fill
# added before a Bottom silently eats it — a layout that looks right until the
# window is resized.
$list                 = New-Object System.Windows.Forms.ListView
$list.SetBounds(0, $header.Height, $form.ClientSize.Width, ($form.ClientSize.Height - $header.Height - $buttons.Height))
$list.Anchor          = 'Top,Bottom,Left,Right'
$list.View            = 'Details'
$list.FullRowSelect   = $true
$list.HeaderStyle     = 'Nonclickable'
$list.BorderStyle     = 'None'
[void]$list.Columns.Add('', 60)
[void]$list.Columns.Add('чекор', 96)
[void]$list.Columns.Add('', 460)
$form.Controls.Add($list)

$timer                = New-Object System.Windows.Forms.Timer
$timer.Interval       = 120

function Add-Row {
    param([pscustomobject] $R)
    $item = New-Object System.Windows.Forms.ListViewItem([string]$R.Status)
    [void]$item.SubItems.Add([string]$R.Label)
    $text = [string]$R.Message
    if ($R.Fix) { $text = "$text   ($($R.Fix))" }
    [void]$item.SubItems.Add($text)
    $item.ForeColor = switch ($R.Status) {
        'OK'    { [System.Drawing.Color]::FromArgb(20, 120, 60) }
        'WARN'  { [System.Drawing.Color]::FromArgb(150, 95, 0) }
        default { [System.Drawing.Color]::FromArgb(185, 30, 30) }
    }
    [void]$list.Items.Add($item)
    $item.EnsureVisible()
}

function Add-Heading {
    param([string] $Text)
    $item = New-Object System.Windows.Forms.ListViewItem('')
    [void]$item.SubItems.Add('')
    [void]$item.SubItems.Add($Text)
    $item.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
    [void]$list.Items.Add($item)
    $item.EnsureVisible()
}

function Set-Working {
    param([bool] $On)
    $btnFinish.Enabled  = (-not $On) -and (-not $script:DayClosed)
    $btnOpen.Enabled    = -not $On
    $btnRefresh.Enabled = -not $On
    $form.Cursor = if ($On) { [System.Windows.Forms.Cursors]::AppStarting } else { [System.Windows.Forms.Cursors]::Default }
}

function Update-Identity {
    $h = Get-MtbHealth -Ctx $Ctx
    $identity.Text = $h.Line
    $identity.ForeColor = if ($h.Ok) {
        [System.Drawing.Color]::FromArgb(70, 80, 95)
    } else {
        [System.Drawing.Color]::FromArgb(185, 30, 30)
    }
}

function Start-Phase {
    param([string] $Kind, [bool] $StopOnFail)
    $script:PhaseKind = $Kind
    $script:Results   = @()
    $script:Phase     = Start-MtbPhase -ScriptsDir $PSScriptRoot -Phase $Kind -Ctx $Ctx -StopOnFail $StopOnFail
    Set-Working -On $true
    $timer.Start()
}

function Complete-Phase {
    $timer.Stop()
    Stop-MtbPhase -Phase $script:Phase
    $script:Phase = $null
    $bad = @($script:Results | Where-Object { $_.Status -eq 'FAIL' })

    if ($script:PhaseKind -eq 'start') {
        Update-Identity
        if ($bad.Count) {
            # Nothing opened, so there is nothing to close down either.
            $script:DayClosed = $true
            $status.Text = 'Застанав. Апликациите не се отворени врз ова.'
        } else {
            $status.Text = 'Денот е отворен.'
        }
        Set-Working -On $false
        return
    }

    $script:DayClosed = $true
    Update-Identity
    Set-Working -On $false
    if ($bad.Count) {
        $status.Text = "$($bad.Count) чекор(и) не поминаа: $(($bad.Label) -join ', ')"
        [void][System.Windows.Forms.MessageBox]::Show(
            ("Не сè помина:`n`n" + (($bad | ForEach-Object { "$($_.Label): $($_.Message)" }) -join "`n")),
            'MTB', 'OK', 'Warning')
    } else {
        $status.Text = 'Денот е затворен. Бекап направен, snapshot објавен, серверот спуштен.'
    }
    if ($script:CloseAfter) { $form.Close() }
}

$timer.Add_Tick({
    if (-not $script:Phase) { $timer.Stop(); return }
    foreach ($item in (Receive-MtbPhase -Phase $script:Phase)) {
        switch ($item.Kind) {
            'started' { $status.Text = "$($item.Label)…" }
            'result'  { Add-Row $item.Result; $script:Results += $item.Result }
            'done'    { Complete-Phase; return }
        }
    }
})

$btnOpen.Add_Click({
    # Start-Process returns at once, so this one is safe on this thread.
    $open = [pscustomobject]@{ Path = (Join-Path $PSScriptRoot 'procedures\start\50-open.ps1'); Label = 'open' }
    Add-Row (Invoke-MtbProcedure -Procedure $open -Ctx $Ctx)
})

$btnRefresh.Add_Click({ Update-Identity })

$btnFinish.Add_Click({
    if ([System.Windows.Forms.MessageBox]::Show(
            'Бекап, објава на pCloud и гасење на серверот. Да продолжам?',
            'Заврши го денот', 'YesNo', 'Question') -ne 'Yes') { return }
    $list.Items.Clear()
    Add-Heading 'Затворам го денот'
    Start-Phase -Kind 'stop' -StopOnFail $false      # излезот никогаш не застанува
})

# The whole reason this is a window: X can be answered instead of obeyed.
$form.Add_FormClosing({
    param($sender, $e)
    if ($script:Phase) {
        $e.Cancel = $true
        $status.Text = 'Почекај да заврши тековниот чекор.'
        return
    }
    if ($script:DayClosed) { return }
    $answer = [System.Windows.Forms.MessageBox]::Show(
        ("Денот не е затворен." + [Environment]::NewLine + [Environment]::NewLine +
         "Да — бекап, објава на pCloud, гасење на серверот." + [Environment]::NewLine +
         "Не — само затвори; серверот останува и објава нема."),
        'MTB', 'YesNoCancel', 'Warning')
    switch ($answer) {
        'Yes' {
            $e.Cancel = $true
            $script:CloseAfter = $true
            $list.Items.Clear()
            Add-Heading 'Затворам го денот'
            Start-Phase -Kind 'stop' -StopOnFail $false
        }
        'Cancel' { $e.Cancel = $true }
        default  { }
    }
})

$form.Add_Shown({
    $form.Activate()
    Add-Heading 'Отворам го денот'
    Start-Phase -Kind 'start' -StopOnFail $true
})

[void]$form.ShowDialog()
