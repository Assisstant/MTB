# server-control.ps1 — turn the therapy server on and off from this PC.
#
#   powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 restart
#
# Or use the desktop shortcuts that scripts\create-shortcuts.ps1 puts there.
#
# Stopping has to deal with three things, not one: the scheduled task, the
# supervisor loop in run-server.ps1, and the node process itself. Kill only node
# and the supervisor starts it straight back — which looks exactly like the stop
# button not working.

param(
    [ValidateSet('status', 'start', 'stop', 'restart')]
    [string] $Action = 'status',

    [int] $Port = 3000,

    [switch] $Wait     # keep the window open at the end (used by the shortcuts)
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

function Get-ListenerPid {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Test-Health {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 4
        return [bool]$r.ok
    } catch { return $false }
}

function Get-Supervisors {
    # The supervisor is a PowerShell process whose command line mentions
    # run-server.ps1. There is no other way to tell it from any other console.
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-server.ps1*' }
}

function Show-Status {
    $listener = Get-ListenerPid
    $healthy = Test-Health

    if ($healthy) {
        Write-Host "Серверот работи." -ForegroundColor Green
        Write-Host "  http://localhost:$Port/api/health   (базата одговара)"
        $serve = & "C:\Program Files\Tailscale\tailscale.exe" serve status 2>$null | Select-Object -First 1
        if ($serve) { Write-Host "  $serve   (за другите уреди)" }
    } elseif ($listener) {
        Write-Host "Нешто слуша на порта $Port, но не одговара како сервер (PID $listener)." -ForegroundColor Yellow
        Write-Host "  Ако е стар процес: scripts\server-control.ps1 stop, па start."
    } else {
        Write-Host "Серверот е исклучен." -ForegroundColor DarkGray
    }
    return $healthy
}

function Start-It {
    if (Test-Health) { Write-Host "Серверот веќе работи." -ForegroundColor Green; return $true }

    $stale = Get-ListenerPid
    if ($stale) {
        Write-Host "Порта $Port е зафатена од PID $stale — ослободувам ја." -ForegroundColor Yellow
        Stop-Process -Id $stale -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $script = Join-Path $root 'scripts\run-server.ps1'
    if (-not (Test-Path $script)) { Write-Host "Не го наоѓам $script" -ForegroundColor Red; return $false }

    Write-Host "Го стартувам серверот…"
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NonInteractive', '-WindowStyle', 'Minimized', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"" `
        -WorkingDirectory $root | Out-Null

    # npm + tsx take a few seconds; poll rather than guess.
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Health) { Write-Host "Серверот работи." -ForegroundColor Green; return $true }
    }
    Write-Host "Серверот не одговори за 30 секунди. Види backups\server-log.txt" -ForegroundColor Red
    return $false
}

function Stop-It {
    $stoppedSomething = $false

    # 1. The scheduled task first — otherwise it is free to start a new one.
    $task = Get-ScheduledTask -TaskName 'TherapyServer' -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName 'TherapyServer' -ErrorAction SilentlyContinue
        Write-Host "Запрена е закажаната задача TherapyServer."
        $stoppedSomething = $true
    }

    # 2. The supervisor loop, before node — kill node first and the supervisor
    #    simply restarts it.
    foreach ($s in Get-Supervisors) {
        Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Запрен е надзорникот (PID $($s.ProcessId))."
        $stoppedSomething = $true
    }

    # 3. Now the server itself.
    Start-Sleep -Milliseconds 500
    $listener = Get-ListenerPid
    if ($listener) {
        Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
        Write-Host "Запрен е серверот (PID $listener)."
        $stoppedSomething = $true
    }

    Start-Sleep -Seconds 2
    if (Get-ListenerPid) {
        Write-Host "Порта $Port е сè уште зафатена. Пробај повторно." -ForegroundColor Yellow
        return $false
    }

    if ($stoppedSomething) { Write-Host "Серверот е исклучен." -ForegroundColor Green }
    else { Write-Host "Серверот и онака не работеше." -ForegroundColor DarkGray }

    Write-Host ""
    Write-Host "Апликациите продолжуваат да работат — само нема да се синхронизираат" -ForegroundColor DarkGray
    Write-Host "додека серверот е исклучен. Ништо не се губи." -ForegroundColor DarkGray
    return $true
}

switch ($Action) {
    'status'  { Show-Status | Out-Null }
    'start'   { Start-It | Out-Null }
    'stop'    { Stop-It | Out-Null }
    'restart' { Stop-It | Out-Null; Start-Sleep -Seconds 1; Start-It | Out-Null }
}

if ($Wait) {
    Write-Host ""
    Write-Host "Притисни било кое копче за да затвориш…" -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
