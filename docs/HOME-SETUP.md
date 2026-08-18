# Working at home with the work PC switched off

Read this from GitHub at home:
<https://github.com/Assisstant/MTB/blob/main/docs/HOME-SETUP.md>

With the work PC off, nothing at work is reachable — no database, no API. So
the home PC needs its own copy of everything: the code (from GitHub) and the
data (carried on a USB stick).

**The one rule:** only one machine is "live" at a time. Whichever machine you
work on holds the newest data, and you carry it to the other. Editing in both
places without carrying the file across leaves two versions that nothing can
merge for you.

---

## PART A — Before you switch off the work PC (5 minutes)

Your newest data is in the **browser**, not in the database: you work in the
published apps, which save to browser storage. So export from the apps.

### A1. Export from Распореди

1. Open <https://assisstant.github.io/MTB/Rasporedi-Unified-Sync-v5.0.html>
2. Tab **Алатки** → **💾 Внес и извоз**
3. Press **🔄 Извези Unified Sync JSON**
4. A file lands in Downloads: `UnifiedSync-Rasporedi-SDnevnik-….json`

### A2. Export from S-Dnevnik

1. Open <https://assisstant.github.io/MTB/S-Dnevnik-Blagoj-Unified-Sync-v4.html>
2. Tab **Податоци** → **⬇ Експортирај Backup (JSON)**
3. A file lands in Downloads: `SDnevnik_….json`

### A3. Copy both files to a USB stick

Both files. Without them the home PC has no data.

> Optional but wise: also copy the whole `backups\` folder from the project
> (it holds database dumps and previous exports). It is your safety net if an
> export turns out to be incomplete.

Now you can switch the work PC off.

---

## PART B — One-time setup at home (about 20 minutes)

### B1. Install the three tools

Open **PowerShell** and run:

```powershell
winget install PostgreSQL.PostgreSQL.18
```

```powershell
winget install OpenJS.NodeJS.LTS
```

```powershell
winget install Git.Git
```

During the PostgreSQL install you are asked to set a password for the
`postgres` user. **Write it down** — you need it in step B3.

Then **close and reopen PowerShell** so it picks up the new commands.

### B2. Get the code

```powershell
cd $HOME\Documents
```

```powershell
git clone https://github.com/Assisstant/MTB.git
```

(If you prefer no Git: open <https://github.com/Assisstant/MTB>, press
**Code → Download ZIP**, and unpack it to `Documents\MTB`.)

### B3. Create the database

```powershell
cd $HOME\Documents\MTB
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1
```

It asks for the `postgres` password from step B1. It then creates the
`therapy` user and the `therapy_dev` database with **the same credentials as
at work**, applies every migration, writes `server\.env`, and installs the
server's dependencies.

Expect it to finish with `================= DONE =================`.

### B4. Start the server

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1
```

Leave that window open — it keeps the server running and restarts it if it
stops. To check it works, open <http://localhost:3000/api/health>; you should
see `{"ok":true,...}`.

> To make it start by itself at every logon, see PART E.

### B5. Load your data

Copy the two files from the USB stick into the project's `backups\` folder,
then (adjusting the file names to match yours):

```powershell
cd $HOME\Documents\MTB\server
```

```powershell
npm run import -- "..\backups\UnifiedSync-Rasporedi-SDnevnik-XXX.json" "..\backups\SDnevnik_XXX.json"
```

That is a **dry run** — it only prints a report. Read it: how many students
were found, how many were linked, and anything listed under *problems*.

If it looks right, run it again with `--apply`:

```powershell
npm run import -- "..\backups\UnifiedSync-Rasporedi-SDnevnik-XXX.json" "..\backups\SDnevnik_XXX.json" --apply
```

### B6. Check it landed

Open <http://localhost:3000/Pregled-Baza.html> — the overview should show your
students, therapists and terms.

---

## PART C — Working day to day at home

You have two ways to open the apps. **Pick one and stay with it**, because
each address keeps its own separate browser storage.

**Option 1 — through your own server (recommended at home):**

- <http://localhost:3000/Rasporedi-Unified-Sync-v5.0.html>
- <http://localhost:3000/S-Dnevnik-Blagoj-Unified-Sync-v4.html>

The server address fills in by itself.

**Option 2 — the published copy**, as you do at work:

- <https://assisstant.github.io/MTB/Rasporedi-Unified-Sync-v5.0.html>

Here you must type the address once, in the **🖥️ Локален сервер** panel:
`http://localhost:3000`

Then the rhythm is always the same:

1. **📥 Вчитај од сервер** when you sit down
2. work
3. **📤 Зачувај на сервер** when you finish

A save should say *„базата е ажурирана"*. If it warns that the database was
**not** updated, load from the server first, check, then save again.

---

## PART D — Going back to work

Home is now the live machine, so carry the data back the same way:

1. At home: **Извези** from both apps (as in PART A), copy to the USB stick
2. At work: **Вчитај JSON** in both apps, then **📤 Зачувај на сервер**

Same rule in reverse. Whoever holds the newest export is the source of truth.

> When both machines are on and you have Tailscale on each, this carrying
> disappears: both point at one server and the USB stick is no longer part of
> the routine.

---

## PART E — Optional extras at home

**Start the server automatically at logon:**

```powershell
$s="$HOME\Documents\MTB\scripts\run-server.ps1"; $a=New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$s`""; $t=New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"; $set=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName "TherapyServer" -Action $a -Trigger $t -Settings $set -Force
```

**Back up the home database:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```

**Reach the home PC from your phone:** install Tailscale on the home PC, sign
in with the same account, then run once:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
```

It prints an `https://<name>.ts.net` address; use that on the phone.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| „Серверот не е достапен" | server not running | rerun B4 and leave the window open |
| Health page does not load | server not running, or wrong port | check the window from B4 for errors |
| App opens empty | new address = new browser storage | press **Вчитај од сервер** |
| Import reports 0 students | wrong file chosen | use the Unified export from Распореди |
| „базата НЕ е ажурирана" | you saved before loading | **Вчитај од сервер**, check, save again |
| `setup-home-postgres.ps1` cannot find psql | PostgreSQL missing or PowerShell not reopened | redo B1, open a new PowerShell |

Your data is never only in one place: the browser keeps its own copy, the
database keeps another, and the exports on the USB stick are a third. If one
goes wrong, the others are still there.
