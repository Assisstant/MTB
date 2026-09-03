# Database sync and backups

## Current work/home setup: independent and manual

WORK and HOME intentionally keep independent databases. Their Windows hostname
may be the same, so `SYNC_NAME=work/home` names the role. They never restore
each other at startup and no scheduled task accepts data automatically. Each
machine publishes only its own weekly verified pCloud snapshot; a person must
run Compare and explicitly choose a legacy JSON area or a complete snapshot.

See [MANUAL-DB-SYNC.md](MANUAL-DB-SYNC.md) for the desktop menu, exact commands,
safety checks and the normal work-to-home/home-to-work routine.

The sections below document older transport modes that remain available for
recovery and compatibility. They are not installed on the two current PCs.

## Legacy browser/server sync

The old routine was: export JSON, carry it, import it, remember which copy was
newer. This replaces it. Nothing here changes what the apps *are* — they still
work offline and still keep their own copy of everything. What changes is that
they now agree with the server by themselves.

## The rule everything follows

The apps are used in one place at a time — work, then home, then work. That is
what makes this safe. There is no merge anywhere in this system and there must
never be one: the state is stored as a single blob, so combining two versions is
not something code can do correctly.

Instead, three things are remembered: what this browser holds, what the server
holds, and **what the two held the last time they agreed**. From that, the
direction is not a guess:

| this side changed | other side changed | what happens |
|---|---|---|
| no | no | nothing |
| no | yes | pull |
| yes | no | push |
| **yes** | **yes** | **stop and ask** |

The last row is the whole point. A timestamp alone would pick the later one and
silently discard the other — which is exactly how a week of work disappears. The
same table governs the browser↔server sync and the work↔home database sync, so
there is only one rule to understand.

## In the apps

In **🖥️ Локален сервер** there is now one button, **🔄 Синхронизирај**, and an
**автоматски** checkbox (on by default). With it on:

- opening the app syncs it
- editing syncs about five seconds after you stop
- leaving the page flushes anything still waiting (S-Dnevnik)

The old **📥 Вчитај** and **📤 Зачувај** buttons are still there, below, for when
you deliberately want to force a direction — including to resolve a divergence.

What the status chip means:

| chip | meaning |
|---|---|
| 🟢 синхронизирано | this browser and the server agree |
| ⚪ серверот не е достапен | working offline; edits are kept locally and go up when it is back |
| 🟠 разидување | both sides changed — nothing was sent, you must choose |
| 🔴 состојбата не е валидна | the local state cannot be exported (e.g. duplicate student names); **sync is stopped until you fix it** |

That last one matters. Previously an invalid state failed quietly and the panel
blamed the server, so you could work for days believing everything was syncing.

## Between the work and home databases

Each machine runs its own PostgreSQL. When both are reachable:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1
```

That is a **report** — it prints both sides and what it would do, and changes
nothing. Add `-Apply` to actually sync:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1 -Apply
```

Put the other machine's address in `server\.env` once, so you never type it:

```
PEER_URL=https://zenpc-1.tailXXXXX.ts.net
```

It follows the same table above. When both databases changed since their last
agreement it refuses and tells you both timestamps, and `-Force` is the only way
past — which is correct, because that case genuinely needs a human.

It also refuses two other ways: an empty state can never replace a full one, and
a state more than 50% smaller than the one it would replace is treated as a
wrong-direction sync rather than an edit.

**Both machines must be awake at the same moment** — only briefly, for the few
seconds the transfer takes. This is the one real constraint on the direct route.

## When they are never on together

### Optional single-writer setup: full PostgreSQL handoff

`RasporediFusion.html`, `Podatoci.html`, the teaching pages and the row-level
parts of S-Dnevnik now write relational tables directly. The older
`sync-peer.ps1` carries only `app_state`, so it is not a complete machine copy
for this setup. Do not run it alongside the full handoff.

The work/home machines exchange a verified PostgreSQL dump through pCloud.
Only one machine is used at a time. On startup the machine waits for pCloud,
checks the lineage, generation, archive SHA-256, database fingerprint and
migration list, makes a local pre-restore dump, and only then restores a newer
generation. If both the local database and pCloud changed, the server is not
started and nothing is overwritten.

Initialise a new lineage once on the chosen primary machine:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\db-handoff.ps1 `
    -Mode Initialize -Dir "P:\MTB-sync" -Me work -PeerName home `
    -Primary work -Apply -ResetLineage
```

Install startup pull plus periodic publishing:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 `
    -FullDbHandoff -Dir "P:\MTB-sync" -Me work -PeerName home -Primary work
```

On HOME use `-Me home -PeerName work -Primary work`. Its first successful
startup preserves its old database under `backups\handoff\pre-restore\`, then
accepts generation 1 from the primary. Afterwards either machine publishes the
next generation only when its database changed. Publishing runs every 30
minutes by default; weekly dumps remain independent recovery backups.

Useful read-only report:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\db-handoff.ps1 `
    -Mode Status -Dir "P:\MTB-sync" -Me work -PeerName home -Primary work
```

The startup gate runs `git pull --ff-only` only on a clean working tree. It then
completes the database handoff before starting the API. If pCloud is unavailable
or a conflict is found, Task Scheduler retries and the API stays off rather
than exposing a stale database.

### Legacy app_state mailbox

If the work PC is off every evening and the home PC is off every day, that
moment may simply never arrive. A folder both machines already synchronise —
pCloud, or any other — solves it, because the cloud is the thing that is always
up:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1 `
    -Dir "D:\pCloudDrive\MTB-sync" -Me work -Apply
```

and on the other machine, the same with `-Me home`. Set it once in `server\.env`
and you never type it again:

```
SYNC_DIR=D:\pCloudDrive\MTB-sync
SYNC_NAME=work
```

Each machine writes **only its own folder** and reads **only the other's**:

```
MTB-sync/
  work/sdnevnik.json     ← written by the work PC, read by home
  work/unified.json
  home/sdnevnik.json     ← written by the home PC, read by work
  home/unified.json
```

so two machines can never write the same file, and there is nothing to merge at
the file level either. The name is required because Windows reports the *same*
hostname on both of these PCs — it cannot be guessed.

The decision rule does not change: the same table above runs, and both sides
changing is still refused. Two things are different, and both matter.

**A push is not a delivery.** Sending through a folder leaves the state in the
mailbox; the other machine has not seen it. So no agreement is recorded at that
moment — otherwise the next run would read the other machine's *stale* file,
conclude it had changed, and pull it back over the work just published. The
agreement is recorded only when both sides are seen holding the same thing.

**A file can arrive half-written.** Every file carries a hash of its own
payload; one that does not match is reported as incomplete and skipped rather
than applied. Files are written under a temporary name and renamed, so the cloud
never uploads a partial one in the first place.

Direct and mailbox are not alternatives — you can install both, and each sync
uses whichever is possible that hour. Direct is faster and confirms delivery on
the spot; the mailbox works when nothing else can.

## Legacy automatic installation

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 -Peer https://zenpc-1.tailXXXXX.ts.net
```

Add `-Dir "D:\pCloudDrive\MTB-sync" -Me work` to install the mailbox sync as
well; giving both means each run uses whichever route is available.

Installs the server at logon, a weekly dump + JSON export, and a sync every two
hours that stays silent when the other machine is off
(it appends one line to `backups\sync-peer.log`, so a quiet week is provably
quiet rather than merely unreported).

Add `-WhatIf` to see what it would do first, `-Remove` to take them all out.

## Кој го држи распоредот — Распореди или дневникот

S-Dnevnik е записот за работата: присуство по датум, досие, проценки,
аудиограми, планови. Распореди е план за кабинетот. **План не смее тивко да
прегази запис**, па правилото е истото како насекаде:

| што се променило | што станува |
|---|---|
| ништо | нема прашање |
| само Распореди | се презема автоматски — тоа е поштедата на време |
| и дневникот и Распореди | застанува и **прашува** тебе |

Учениците и одделенијата секогаш се ажурираат од Распореди. Ученик што постои
**само во дневникот не се брише** при синхронизација, а архивиран не се враќа.
Присуството, проценките, досиејата, аудиограмите и плановите не се допираат во
ниту еден случај, и минатите недели никогаш не се менуваат.

## Turning the server on and off

The server does **not** need to run all the time. The apps work offline; the
server only matters at the moment something syncs. Turn it off overnight and
nothing is lost — the next sync catches up.

Put three buttons on the Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
```

**Сервер — Вклучи**, **Сервер — Исклучи**, **Сервер — Состојба**. The status one
also prints the tailnet address your other devices should use.

The same thing from a console:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 stop
```

Stopping deals with all three layers — the scheduled task, the supervisor loop
and the server process, in that order. Killing only the server would let the
supervisor start it straight back, which looks exactly like the button not
working.

There is no on/off switch inside the app itself, and there cannot be: a web page
is not allowed to start or stop programs on your computer. The scheduled task is
the practical version of that — the server comes up at logon on its own.

## Backups

Weekly is enough now: the database is no longer the only copy. Every browser
that opens the apps holds a full copy, and the two machines hold each other's.
The weekly dump exists for the case where all of that is wrong in the same way —
a bad import, a mistaken bulk edit — and you need to go back to a known week.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```

Fourteen dumps are kept by default.

## When something looks wrong

**A device shows old data.** Look at the chip. If it is ⚪, the server is not
reachable from there. If 🟢, that device really is in agreement with the server —
so the newer work is on a machine that has not synced, not lost.

**Divergence you did not expect.** Something saved on the other side while this
one was offline. Nothing has been thrown away: both versions still exist. Decide
which one to keep, then use the explicit button, or `-Force` on the script.

**The chip is 🔴.** Read what it says. It is a problem in the data, not the
connection, and syncing stays stopped until it is fixed — deliberately, because
sending a state that cannot be exported would put a broken copy everywhere.

**Pregled-Baza shows nothing.** Unlike the two apps, that page has no copy of
its own — it reads the database live, so it always needs the server. Opened from
`assisstant.github.io` it now asks for the server address once and remembers it
(the same address the apps use; they share it on that site). Opened through the
server itself it needs no address at all.

**Two browser addresses.** `https://assisstant.github.io/...` and
`https://<machine>.ts.net/...` are different origins with separate storage. Work
in one of them consistently. If something is missing, check the other address
before concluding anything was lost.
