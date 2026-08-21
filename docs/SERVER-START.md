# zenpc-1 — starting the server (home PC)

This machine is the server. It holds PostgreSQL and the database. The laptop
(`ink`) and the phone are clients — they install nothing and hold nothing.

---

## The two commands

Open PowerShell in the project folder (where `CLAUDE.md` is).

**1. Start the server.** Leave this window open — it restarts the server if it
stops.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1
```

Check it on this machine before going further — open
<http://localhost:3000/api/health>. You want `{"ok":true,"db_time":...}`.

If that fails, stop. Tailscale cannot fix a server that is not running.

**2. Open it to your other devices.** Second PowerShell window:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
```

It prints an address like `https://zenpc-1.tailXXXXX.ts.net`. **That address is
the whole client setup.** `--bg` means it survives reboots — you only do this
once.

Lost the address later?

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve status
```

---

## Then, from the laptop or the phone

```
https://zenpc-1.tailXXXXX.ts.net/api/health
```

`{"ok":true,...}` means that device is a working client. No login, no account,
no password — the address is the access.

The apps:

```
https://zenpc-1.tailXXXXX.ts.net/Rasporedi-Unified-Sync-v5.0.html
https://zenpc-1.tailXXXXX.ts.net/S-Dnevnik-Blagoj-Unified-Sync-v4.html
https://zenpc-1.tailXXXXX.ts.net/Pregled-Baza.html
```

**On a fresh browser, press 📥 Вчитај од сервер first.** It holds nothing until
it pulls. Pressing 📤 Зачувај на сервер first sends an empty state.

---

## Optional: start automatically at logon

So you never have to remember step 1:

```powershell
$s="$PWD\scripts\run-server.ps1"; $a=New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$s`""; $t=New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"; $set=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName "TherapyServer" -Action $a -Trigger $t -Settings $set -Force
```

Run it from the project root, so `$PWD` is correct.

---

## The one open problem — the work PC

`zenpc` at work has its own database. This machine has one too, made yesterday.
**Two live databases cannot be merged, only carried.**

Testing the connection from a client is safe. What is not safe is pressing
📤 **Зачувај на сервер** from a client before you have decided which database is
the real one. That is the moment the choice becomes permanent.

When you are ready to settle it, the honest way is: export JSON from both apps
on whichever machine has the newest work, and import it here. Do not assume
this one is newer just because it is the one that is on.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| `localhost:3000/api/health` fails here | server not running — rerun command 1, read that window for errors |
| `serve` says HTTPS is not enabled | Tailscale admin console → DNS → enable MagicDNS and HTTPS Certificates, rerun |
| Health works here, not on the laptop | `serve` not running or wrong port — rerun command 2, check `serve status` |
| Laptop app opens empty | normal on a fresh browser — press 📥 Вчитај од сервер |
| „базата НЕ е ажурирана" on save | load from the server first, check, then save |
