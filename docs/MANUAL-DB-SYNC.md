# Independent databases and manual sync

WORK (`work`) and HOME (`home`) each have their own PostgreSQL database. Their
Windows hostnames may both be `ZenPC`; the role comes only from the local
`SYNC_NAME` setting. They start, read and write locally even when the other
computer is off. No startup task copies, restores or merges the other database.

The system automates only the safe part: each machine exports its own verified
snapshot to its own pCloud folder once a week. Comparing and accepting data is
always a deliberate manual action.

## The bar at the top of every app

The shared top bar answers two separate questions. Do not read one as the
other:

- **БАЗА** says which configured installation is answering: `РАБОТА · ...` or
  `ДОМА · ...`. The machine name after the dot may be identical on both PCs.
- **ПОДАТОЦИ** says whether this screen's work has reached that installation.

The data states mean:

| State | Meaning |
|---|---|
| `Зачувано во базата` / `Синхронизирано` | the server confirmed the write |
| `Се зачувува…` | wait; the request is still in flight |
| `Локално зачувано · чека сервер` | the browser has the edit, PostgreSQL does not yet |
| `Разидување`, `Одбиено`, or an error | stop and read the message; do not assume it saved |

`RasporediFusion`, `Podatoci`, and `NastavaUredi` write each deliberate action
straight to PostgreSQL. They do not need one large Submit button: the existing
cell/form Save action becomes green only after the server accepts it. A failed
write is rejected and stays visible as an error.

S-Dnevnik is still local-first. An edit is first made safe in IndexedDB, then
automatic sync sends it to the selected server. Its pending flag is stored too,
so closing or refreshing the tab cannot turn an unsent edit into a green state.
Use the retry icon in the top bar or `Синхронизирај` in its server panel when it
is waiting.

The installation identity is server configuration, not a row inside the
database. Accepting a complete WORK snapshot on HOME therefore changes the
data but cannot make HOME introduce itself as WORK. `/api/health` warns when
the role is not configured; it never guesses WORK or HOME from the hostname.

Always open the apps through `start.html`. A page served by ZenPC is locked to
ZenPC's server origin; an old browser setting cannot redirect its writes to
ZenPC-1. A copy opened directly from GitHub Pages has separate browser storage
and is labelled as a browser/local copy until a server is selected.

## The easiest way

Open the desktop shortcut **MTB Database - Manual Sync**. Its dashboard
automatically reads `work`/`home` and the pCloud folder from `server/.env`. It
shows both machines' latest published snapshot, verifies every checksum, and
marks a snapshot as ready only after all PostgreSQL and JSON files have arrived.

The guided choices are:

1. **Export** creates a complete PostgreSQL dump plus the two legacy JSON files.
2. **Compare** verifies the peer snapshot and lists every table whose content differs. It writes nothing.
3. **Accept** first runs Compare, then offers to replace this database with the exact peer database.
4. **Legacy preview** runs the old JSON import report without writing anything.
5. **Legacy import** runs Preview first, then accepts `Rasporedi`, `S-Dnevnik`, or both.

Both writing choices require typing the exact peer snapshot id. A wrong or stale
id is refused. A verified local safety dump is created before either write. The
menu requires `SYNC_NAME=work/home` (or an explicit `-Me`) because hostname is
not a safe identity on these two machines.

For a quick non-writing check, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync-menu.ps1 -StatusOnly
```

## Which acceptance to use

Use **Legacy import** when you deliberately want only the data represented by
the old app exports. It retains the familiar JSON workflow and can choose
`Rasporedi`, `S-Dnevnik`, or `All`. Always run **Legacy preview** first.

The legacy JSON contract does not represent every newer relational table. In
particular, it is not a complete copy of all `Podatoci` and `Nastava` history.
Use **Accept complete snapshot** when one machine should become an exact copy of
the other, including every relational table.

Do not attempt a generic row-by-row merge of full database dumps. Several
tables use local numeric ids. Two independent inserts can receive the same id
on the two PCs while describing different facts. `Compare` reports that the
tables differ and leaves the decision to the user instead of guessing.

## Normal routine

On the computer where work has just finished:

1. Close the application tabs or finish their server save.
2. Open **MTB Database - Manual Sync**.
3. Choose **Export** and note the snapshot id.
4. Wait until pCloud finishes uploading.

On the other computer:

1. Wait until pCloud finishes downloading.
2. Open the shortcut and confirm that the peer snapshot says **ПОДГОТВЕН**.
3. For an exact copy, choose **Accept**; the assistant runs Compare first.
4. For selective app data, choose **Legacy import**; Preview runs first.
5. Type the exact snapshot id shown by the assistant.

After an import, reopen the apps through that computer's server and use their
explicit **Load from server** action if an old browser tab still shows cached
data.

### Recommended work/home routine

WORK is the normal editing place:

1. Open the bookmarked `start.html` and confirm `РАБОТА` in the bar.
2. Work normally. Before leaving, make sure S-Dnevnik no longer says that local
   changes are waiting. Direct database screens have already confirmed each
   successful edit.
3. Export the WORK database snapshot and wait for pCloud.

HOME is normally for checking:

1. Compare and, when HOME should continue from WORK, accept the exact WORK
   snapshot before editing.
2. Open through `start.html` and confirm `ДОМА` in the bar.
3. Reading needs no hand-back. If anything is edited at HOME, HOME is now the
   newer working copy: export HOME and accept it at WORK before the next edit
   there.

The rule is still one active editing database at a time. The browser status bar
prevents accidental ambiguity inside an app; the manual snapshot workflow is
what transfers the complete database between machines.

## Commands

The shortcut runs these same commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 `
    -Mode Export -Dir "P:\MTB-sync" -Me work -PeerName home
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 `
    -Mode Compare -Dir "P:\MTB-sync" -Me work -PeerName home
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 `
    -Mode LegacyPreview -Area S-Dnevnik `
    -Dir "P:\MTB-sync" -Me work -PeerName home
```

Writing requires both `-Apply` and the exact snapshot id:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 `
    -Mode LegacyImport -Area S-Dnevnik -Apply `
    -Snapshot "home-YYYY-MM-DD-HH-mm-ss-xxxxxxxx" `
    -Dir "P:\MTB-sync" -Me work -PeerName home
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 `
    -Mode Accept -Apply `
    -Snapshot "home-YYYY-MM-DD-HH-mm-ss-xxxxxxxx" `
    -Dir "P:\MTB-sync" -Me work -PeerName home
```

On HOME swap the names: `-Me home -PeerName work`.

## One-time installation

Run on ZenPC:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 `
    -ManualDbSync -Dir "P:\MTB-sync" -Me work -PeerName home
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1 -ManualSync
```

Run the same on HOME with `-Me home -PeerName work`. Installation removes the
automatic full-DB publisher and the old automatic peer/mailbox tasks. The API
still starts at logon after a clean-tree `git pull --ff-only`. Local weekly
backup runs Sunday at 20:00 and the independent pCloud snapshot at 20:30.

Snapshots are stored separately, so neither machine writes the other's folder:

```text
P:\MTB-sync\manual-db-sync\
  work\current.json
  work\snapshots\work-...\
  home\current.json
  home\snapshots\home-...\
```

Checksums, database fingerprints and the exact migration list are verified
before a snapshot is compared or accepted. Safety dumps are local under
`backups\manual-sync\pre-import\`.
