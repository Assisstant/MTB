# MTB — therapy apps for ОУРЦ „Кочо Рацин", Битола

Read this first. It is the shared memory between machines: sessions on other
PCs have none of the earlier conversation.

Whatever local memory your tool keeps is **per machine** and diverges — one
copy at HOME, another at WORK, and they never meet. This file and `docs/` are
the only memory that crosses. So anything worth remembering goes into a commit,
not into local memory, and where the two disagree **this file wins**. A global
per-machine instructions file (`~/.codex/AGENTS.md` and its equivalents) should
say nothing beyond "follow the repository's AGENTS.md": instructions that
accumulate there ARE the divergence, because only one machine ever sees them.

## Canonical product contract

Read [`docs/APP-CONTRACT.md`](docs/APP-CONTRACT.md) before changing any user
interface, navigation, schedule, server-selection, or sync behaviour. It is the
short authoritative specification. In particular, extend
`RasporediFusion.html` in place; never expose or create a second schedule app.

## What this is

One connected set of work screens used daily by a speech therapist, backed by
the machine's local PostgreSQL database.

| File | Purpose |
|---|---|
| `RasporediFusion.html` | canonical DB-first schedule for the therapy cabinets |
| `Rasporedi.html` | legacy JSON compatibility/recovery only; never advertise it as an app |
| `S-Dnevnik.html` | one therapist's diary: attendance, plans, dossiers, assessments, audiograms |
| `Pregled-Baza.html` | read-only overview of the database |
| `Nastava.html` | who is missing from which lesson — reads the server, stores nothing |
| `NastavaUredi.html` | the school timetable, editable cell by cell — writes the server, stores nothing |
| `Podatoci.html` | the lists a year is made of: students, teachers, therapists, classes |
| `AkciskiPlan.html` | евидентен лист: one pupil's development record, filled section by section by the whole team |
| `start.html` | launcher: finds whichever machine is on, sends you to it |
| `server/` | Fastify + TypeScript API over PostgreSQL |

The apps are published through GitHub Pages at
`https://assisstant.github.io/MTB/` and used from there.

## Architecture, and why

**Mixed storage, deliberately.** `RasporediFusion.html`, `Podatoci.html`, and
`NastavaUredi.html` are DB-first and report success only after PostgreSQL
accepts a row-level write. S-Dnevnik remains local-first in IndexedDB and syncs
its saved state to the chosen local server. `Rasporedi.html` remains only as the
legacy export escape hatch.

**Sync decides direction, it never merges.** The apps are used in one place at
a time, so the safe question is not "which is newer" but "which side changed
since the two last agreed". Each app stores that agreement as a pair of content
fingerprints; `sync-peer` stores it in `sync_watermark`. One side changed →
copy it. Both changed → refuse and ask a human. A timestamp comparison alone
would silently discard a whole session's work, which is why it is only ever the
fallback for a first sync. See `docs/SYNC.md`.

The relational tables now feed the canonical schedule and the cross-cutting
screens (`Pregled-Baza.html`, `/api/*`). JSON remains an additive compatibility
contract and recovery export, not a reason to fork the live interface.

**Cross-machine database sync is manual.** WORK and HOME each run their own
PostgreSQL database. Their Windows hostnames may both be `ZenPC`; the ignored
`SYNC_NAME=work/home` setting is authoritative. Scheduled tasks may export each machine's own verified
snapshot, but startup never restores the peer and no task accepts peer data.
`scripts\manual-db-sync.ps1` compares first, then requires `-Apply` and the exact
snapshot id for either a legacy JSON area or a complete database replacement.

**Snapshots are not generic merge logs.** Several relational tables use local
numeric ids, so independent inserts can collide. The tool reports table-level
content differences and refuses to infer row identity. Legacy JSON remains the
deliberate selective path; exact full-snapshot acceptance is the complete path.

## Rules that must not be broken

1. **No student names in this repository.** It is public (GitHub Pages serves
   from it). Names belong in the local database only. Test fixtures and
   migrations use invented names. `npm run check:names` is the check and
   `.githooks/pre-commit` runs it before every commit — a clone must be told
   where its hooks live, which `scripts/setup-home-postgres.ps1` does, or
   `git config core.hooksPath .githooks` by hand. The leak surface is prose,
   not code: handovers, plans, TODO lists and commit messages are written
   fastest and read least.
2. **Never guess an identity match.** Students are reconciled across the two
   apps by bridge id → exact name → bare name → name+grade. Ambiguity is
   reported and left unlinked, never merged.
3. **An empty payload must never erase stored data.** An app opened on a fresh
   device holds nothing until it pulls; saving first would wipe the year.
   Safeguards in `import-core.ts` refuse it and say so.
4. **The JSON export is a compatibility contract.** The old single-file apps
   must keep loading what the current system exports, and the current system
   must keep accepting what they produce. That escape hatch is the only reason
   larger changes here are safe to attempt: if a rewrite goes wrong mid-year,
   the therapist opens the old HTML with yesterday's export and keeps working.
   New fields are therefore ADDITIVE and optional — never required, never a
   rename, never a change of shape. `readArchive` tolerating an `_archived`
   without `reason` is the pattern to copy.
5. **One owner per fact.** A fact that two components each decide is a fact
   they will eventually disagree about. Student enrolment is owned by
   S-Dnevnik's archive; the database and `rollover-year` read it. Before adding
   a field, name its owner.
6. **Real data stays local.** `backups/` is gitignored. Never commit exports,
   dumps or `.env`.

## Layout

```
server/src/lib/import-core.ts   identity + projection (shared by API and CLI)
server/src/routes/state.ts      blob save/load, projects into tables
server/src/routes/annual-roster.ts   who is on this year's four lists (active, not deleted)
server/src/routes/roster-purge.ts    the other бришење: a typo, and only when nothing points at it
server/src/routes/evidence.ts        евидентен лист: one score cell, one panel, one line of the form
server/src/routes/evidence-auth.ts   shared sign-in: authorship always, opt-in authorization
server/src/lib/evidence.ts           the catalogue, the year's columns and one sheet read whole
server/src/lib/public-static.ts      explicit allowlist for files published by the local server
server/src/routes/data.ts       read endpoints
server/src/routes/schedule-write.ts  one schedule cell at a time (Stage A, behind a flag that is off)
server/src/routes/roster-write.ts    students, therapists, caseload links (Stage B/C, same flag; no delete of people)
server/src/routes/diary-write.ts     one attendance mark, and one schedule slot, at a time (Stages D/E, its own flag, also off)
server/src/routes/record-write.ts    one clinical record at a time (Stage F, same flag)
server/src/lib/records.ts            the row-mapping for the five clinical collections, called by BOTH the projection and the endpoints
server/src/lib/progress.ts           plan progress, DERIVED from attendance — no endpoint writes it
server/src/lib/crossing.ts           therapy block → teaching period, by real minutes; the ONLY copy
server/src/lib/teaching.ts           reading the school's timetable workbook (pure, testable on invented data)
server/src/lib/teaching-write.ts     writing a parsed timetable into the tables, per school year
server/src/lib/teaching-edit.ts      one cell at a time, last year copied into this one, teacher↔class
server/src/routes/teaching.ts        read-only crossing: who is out of which lesson
server/src/routes/teaching-edit.ts   the writes Nastava.html deliberately does not have
server/scripts/                 import-json, export-json, rollover-year, sync-peer, copy-teaching-year
database/migrations/*.sql       applied in filename order, tracked in schema_migrations
scripts/                        setup, backup, supervisor, verify, sync-peer, scheduled tasks
docs/HOME-SETUP.md              setting up another machine
docs/CLIENT-SETUP.md            a machine that installs nothing
docs/SYNC.md                    how staying in sync works, and what to do when it complains
docs/SCHOOL-YEAR.md             the September routine, and the order it must happen in
docs/PLAN-start-stop.md         one front door for the whole system: what must run on
docs/PLAN-kadar.md              a name that changes, an absence, a stand-in: what the
                                staff directory cannot say yet, and the one thing
                                it must refuse to become
                                the way in, what must run on the way out, and why the way
                                out may never stop at the first failure
docs/PLAN-rasporedot-i-nedelata.md   READ BEFORE TOUCHING THE SCHEDULE. schedule_slots
                                has no week, so "from which week does this apply" cannot
                                be asked. Stage 0 in there is urgent and independent: a
                                document must not replace a schedule written per cell.
docs/HANDOVER-03-09-2026.md     what each database was on 3 Sep, and the twelve assertions
                                the evidence audit left failing
docs/HANDOVER-07-09-2026.md     sanitized HOME→WORK technical steps; names stay local
```

## Commands (from `server/`)

```
npm run dev          server with reload          npm test     20 tests
npm run test:roster  Stage B, needs the server running (see the file header)
npm run test:diary   Stage D, same (the browser ones need playwright)
npm run test:week    Stage E, including September tried both ways round
npm run test:records Stage F, including that both write paths agree
npm run start        server                      npm run export
npm run import -- <files>            dry run; add --apply to write
npm run import:teaching -- <x.xlsx>  the school timetable; dry run, add --apply
npm run import:roster -- <list.docx> --year 2025/2026   the school's pupil list; dry run
npm run check:lists -- --staff <a.docx> --programme <b.docx>   read-only, no --apply
npm run check:names                  refuses if a real name is in a tracked file
npm run copy:teaching -- --from 2025/2026   last year's timetable as this year's start; dry run
npm run test:crossing                the overlap model and the workbook parser (no server needed)
npm run test:teaching-edit           editing the timetable, needs the server running
npm run test:uredi                   NastavaUredi.html in a browser, needs the server running
npm run test:podatoci                Podatoci.html in a browser, needs the server running
npm run test:purge                   the typo delete, including the concurrent booking
npm run test:evidence                евидентен лист against the database, needs the server running
npm run test:evidence-ui             the same page in a browser, two therapists at once
npm run test:teaching                the crossing and the workbook writer, needs the server
npm run rollover -- --to 2026/2027   dry run; add --apply
npm run sync -- --peer <url>         dry run; add --apply to write
```

From the repo root:

```
powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1        health check
powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1 new machine
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1           dump + JSON
powershell -ExecutionPolicy Bypass -File scripts\manual-db-sync.ps1 -Mode Compare -Dir P:\MTB-sync -Me work -PeerName home
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1          supervised server
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1           report; -Apply to sync
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1   server, weekly backup, sync
powershell -ExecutionPolicy Bypass -File scripts\server-control.ps1 status    start | stop | restart
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1         desktop on/off buttons
```

Database connection settings belong only in `server/.env`. Commands and tests
read `DATABASE_URL`; never add literal credentials to this public repository.

## Traps already hit — do not repeat them

- **Dates.** `node-postgres` returns `DATE` as a JS `Date` at *local*
  midnight; `toISOString()` then moves it to the previous day. `src/db.ts`
  parses oid 1082 as a plain string. Row counts matched while every clinical
  date shifted — verify content, not counts.
- **`CREATE OR REPLACE VIEW` cannot change columns.** Drop the view first, or
  a later migration fails (hit twice: 004 and 007).
- **Cyrillic migrations** need `PGCLIENTENCODING=UTF8`, or a Windows console
  codepage corrupts them.
- **Every `.ps1` needs a UTF-8 BOM.** Windows PowerShell 5.1 — which is what
  `powershell -File …` runs, even when the shell you typed it in is pwsh 7 —
  reads a BOM-less file using the system ANSI codepage. UTF-8 bytes then decode
  into characters that PowerShell's lexer treats as *string delimiters*: under
  CP1251 an em dash `—` becomes `вЂ”`, `ѓ` becomes `С“`, `Г` becomes `Р“`. The
  script dies with "The string is missing the terminator" and a cascade of
  unclosed braces, pointing at a line whose real syntax is fine. `pwsh` reads
  UTF-8 without a BOM and so hides the bug — always test with `powershell`.
- **S-Dnevnik ids are `Date.now()`** — `bigint`, never `integer`.
- **Attendance marks** are a bare `"present"` string in some exports and
  `{status}` in others. Blank marks carry no information.
- **Two students can share a name.** There are two „Јана Пробева" in
  different grades. Grade disambiguates; without it, do not link.
- **The school year transition has an order — but it is no longer destructive.**
  Everything the apps save projects into whichever `school_years` row is
  `is_current`, so roll the DATABASE over first (`npm run rollover`), then close
  the year in S-Dnevnik. Doing it the other way round now MIS-FILES the new
  year's work under the old label; it does not destroy anything.
  This was measured, not assumed: closing the year first and saving both apps
  left 8/8 schedule slots, 24/24 attendance marks, 16/16 progress rows and all
  enrollments intact, because the empty-payload guard refuses it and says
  *"Payload carries an empty schedule while N slots exist for this year —
  schedule left untouched."* The older wording claimed last year's schedule was
  overwritten. That has not been true since the guard landed, and a warning that
  is not true teaches people to ignore the ones that are.
- **`rollover` no longer retires anyone.** It used to set `students.active =
  false` for whoever it judged to have graduated, while S-Dnevnik kept its own
  archive — two deciders for one fact, so the next save from the app listed
  those students as enrolled and switched them straight back on. It now names
  them in its report and leaves the flag alone. The archive is what retires a
  student; `applyStudentStatus` carries it into the database.
- **Missing from a payload is NOT the same as gone.** An app that has not pulled
  yet is also missing everyone. Only an explicit `archivedStudents` entry
  deactivates a row — never absence.
- **A suite that writes a row "once, and never again" must delete it.**
  `diary-schedule.e2e.ts` asserts that a week snapshot is created the first time
  and ignored the second — correct behaviour, and it left the row behind. So the
  suite passed on a fresh database and failed on every run after, with
  `created: false` on a line that reads like a broken endpoint. Third time this
  shape of bug has appeared here. Anything a test asserts about FIRST-ness has
  to be cleaned up with the rest of the fixture.
- **A whole-document save must not restate what now has its own endpoint.**
  Stage A stopped the blob carrying the schedule but left it deciding the
  roster, and that was still an overwrite waiting to happen: a browser holds the
  names as they were when its tab opened, so a colleague's rename made at 10:00
  through `PATCH` was undone by anyone pressing „Зачувај на сервер" at 10:05 —
  with no `expected` to check, because a document has nothing to check against.
  Under `unifiedMeta.slotWrites` the projection is now ADD-only: new students
  and therapists are created, `sdnevnik_id` is still linked (S-Dnevnik's fact,
  not Rasporedi's), and name, grade, enrolment grade and caseloads are left to
  the endpoints that own them. Without the marker everything projects as before
  — the old apps must keep working (rule 4), and there is a test asserting that
  control, without which the guard tests prove nothing.
  The same applies in the other direction, and it is easy to miss: the app's own
  auto-sync APPLIES the whole document, so with per-row writes on it silently
  restored the pre-Stage-A roster on every page load. Measured — every name
  added through the new paths disappeared. `localSrvSync` now stops at the door
  when the flag is on, and the manual „Вчитај од сервер" keeps the roster and
  the week from the database (`RSlots.keepOwned`). A JSON FILE import is
  untouched: that is the escape hatch of rule 4 and must restore everything.
- **Rasporedi must never delete a person from the database, and cannot.**
  Removing a student from its list means "not on my schedule", which is a
  different fact from "left the school": a child can be untimetabled for a term
  and still be enrolled. Enrolment has one owner, S-Dnevnik's archive. So
  `roster-write.ts` has no DELETE at all — and the roster diff ignores whoever
  is absent locally rather than reporting it as a departure. It also refuses to
  re-activate: a browser that has not pulled still lists last year's roster, and
  treating that as evidence would switch archived children straight back on —
  exactly the two-deciders failure `rollover-year` already had to give up.
  What Rasporedi DOES clear is their terms, cell by cell, so nobody is left
  booked into a slot for ever. The tests assert the absence: a `DELETE` on
  either roster route must answer 404.
- **Students are archived, never deleted.** `deleteStudent` used to remove the
  student, the schedule entry and their progress, leaving dossier, assessments
  and audiograms in the file but unreachable, because every list is built from
  the student list. Archived students move to `archivedStudents`; nothing else
  had to change. A Unified export taken before the year end still lists them, so
  `applyPayload` filters them out rather than resurrecting them.
- **Empty must never overwrite archived history.** Progress is filed into
  `progressArchive[year]` and reset each September. Running the transition twice
  would otherwise write the now-empty progress over last year's — so only
  non-empty entries are archived, and an existing entry is filled in, not replaced.
- **The school calendar is data, not code.** It used to be hardcoded for
  2025/2026, which meant that from September the diary reported "week 36 of 36,
  outside the school year" forever and knew no further holidays. It now lives in
  the payload and is edited in Податоци → Учебна година.
- **One Monday calculation, `mondayOf`.** Two forms existed side by side:
  `d.getDate() - d.getDay() + 1` maps Sunday to NEXT Monday, while
  `dow === 0 ? -6 : 1 - dow` maps it to the previous one. On Sundays the grid
  drew one week while the week number and the attendance dates meant another.
  Never hand-roll it again.
- **Attendance cannot be written on a non-working day.** A `praznik` or a
  `raspust` blocks the toggle in both the normal and the merged-cell path;
  an `aktivnost` only marks the day, because an excursion is still a workday.
- **Never trim clinical free text.** Trailing whitespace is what the therapist
  typed. `asRawText` for the dossier, `asText` for identifiers.
- **`jsonb` reorders object keys.** What the server returns is never byte-for-byte
  what was sent, though the content is identical. Any fingerprint used to answer
  "did this change?" must sort keys (`stableStringify`), or the app reports a
  divergence with itself seconds after a successful save.
- **`applyUnifiedPayload` mutates the object it is given** — the payload becomes
  the live `scheduleData`. Fingerprint the server's state *before* applying it,
  never after, or every check disagrees with the last one and the app pulls in a
  loop.
- **Do not wrap an object property to observe a save.** The auto-sync in
  S-Dnevnik learned "something changed" by replacing
  `window.SdnV3.saveFullPayload`. Nothing ever called that property: every save
  path — all 37 of them — goes through `window.saveData`, which calls the inner
  closure `saveFullPayload` directly. So the wrapper never ran, the debounced
  push after an edit and the flush on leaving the page silently did not exist,
  and the only thing that ever synced was opening the app. It looked like it
  worked because the on-open sync then pushed whatever had accumulated.
  Wrap the **global entry point** (`window.saveData`, `window.manualSave`), or
  do what `Rasporedi.html` does and call the notifier from *inside* the save
  function. A test that asserts the wrapper was called proves nothing; assert
  that a `PUT /api/state/…` actually happens after an edit.
- **Volatile fields must stay out of change detection.** `exportedAt`, `revision`,
  `_meta.savedAt` change on every save with no edit behind them. Hash content
  fields only.
- **A student has TWO unique keys, and `ON CONFLICT` only ever knew about one.**
  The projection was `INSERT … ON CONFLICT (public_id)`. A clash on
  `sdnevnik_id` is not a conflict that statement was told to expect, so
  PostgreSQL raises `students_sdnevnik_id_key` — and because the whole
  projection is one transaction, EVERY table rolls back. The blob still saves,
  so both apps report success while the relational side silently stays at
  yesterday. **This happened on a real machine before it was found in review.**
  It fires whenever the same child arrives under a different `public_id`: the
  app regenerated the id from the name because `studentMeta` had no stored one,
  while S-Dnevnik's bridge id still matched. Within one payload `reconcile`
  already refuses to let two students share an `sdnevnikId`; nothing was
  checking it across saves. `upsertStudentRow` now resolves by both keys, moves
  the `public_id` only when the incoming one was STORED rather than generated,
  and refuses outright when the two ids sit on different rows.
- **A shared name must not archive the wrong child.** `alsoArchived` was
  "matched by id OR by name". Archive one pupil from a same-name pair and the
  other one — a different child, different grade, still enrolled — matched on the name: kept
  out of the list that restores active students, and reported to the therapist
  as archived-but-still-listed. When a student's identity is known the id
  decides and the name adds nothing; the name is evidence only for someone with
  no diary link, and then only if it cannot mean two people.
- **Real names were in the public repository for months, and nobody was
  checking.** Rule 1 has said "no student names in this repository" since the
  beginning, and on 31 Aug 2026 the tip of `main` held two real children's
  names in `CLAUDE.md`, `AGENTS.md` and two test fixtures, six real staff names
  in comments, a migration and the memory files, and three `LegacyFiles/`
  годишен одмор applications carrying thirteen employees each. None of it was
  malice: a comment about why two children with one name must never be merged
  reads better with the actual pair in it, and that is exactly how a child's
  name reaches the public internet. **A rule with nothing enforcing it is a
  wish.** `npm run check:names` now greps every tracked file against the names
  in the local database — the one blocklist that already exists and can never
  itself be committed — and refuses. It prints a masked form, never the name,
  because the report is the next thing to get pasted somewhere. Run it before
  any push that touches documentation or fixtures.
  On 5 Sep 2026 the reachable history was rewritten with `git-filter-repo`
  2.47 after a verified local bundle was made. Both current branch trees were
  checked byte-for-byte, `main` was force-pushed, the repository had zero
  forks, and the masked `--history` guard found no database name. GitHub
  correctly refused its two read-only closed-PR refs; Support still has to
  dereference those cached views. HOME's refs/reflogs were cleaned. **WORK must
  discard its pre-rewrite clone and re-clone before any pull or push** — merging
  from that clone can put the removed history back. The recovery bundle is
  local and gitignored; it must never be uploaded.

- **`sync-peer` reports a failed fetch as a divergence, and then recommends
  `--force`.** The loop that runs each app is `try { … } catch { results.push('refused') }`
  — so a network error, a stopped local server or a missing mailbox file all
  land in the SAME bucket as "both sides changed, a human must decide". The
  PowerShell wrapper then prints *"The two machines have diverged… rerun with
  -Force"*, and `--force` exists to override the clock-skew and shrink guards.
  In the one situation where it knows least, it points at the switch that turns
  the protections off. Seen on 31 Aug 2026: both apps answered `fetch failed`
  because the local server was down, and it was reported as a divergence. A
  failure to LOOK is not a disagreement; it needs its own outcome, counted
  apart, and must never advise forcing. Not yet fixed.

- **A queue in memory is not a queue.** Cells waiting to be sent lived in a
  plain array. The app said „промените чекаат", a refresh threw them away, and
  `hydrate` then replaced the local week with the server's — so an edit made
  while the server was down vanished, having been reported as safe. It is on
  disk now (`rasporedi_pending_slots_v1`).
- **A dropped write needs re-queueing, not a `continue`.** A 404 or a 5xx for a
  cell was a `continue`, and the cell had already been spliced out of the queue:
  one edit gone for good, behind a message that reads like a warning rather than
  a loss. Also `flushRoster`'s return value was discarded, so when the roster did
  not land the cells were sent anyway and 404'd — for the exact reason Stage B
  exists to prevent. Both now hold the cell, count attempts, and complain loudly
  after three.
- **A refused rename must stop the caller too.** `renameLocally` correctly
  refuses to merge two students when the new name is already taken — and the
  caller ran on regardless, writing the OTHER student's `studentMeta.studentId`
  and recording agreement in `seen`. Two people quietly folded into one row,
  which is the one thing rule 2 exists to prevent. It returns a boolean now, and
  the caller reports the clash instead of proceeding.
- **A database that cannot lower-case Cyrillic breaks every name match, and
  says something else.** Every name lookup in the API is
  `lower(btrim(name)) = $1` against a value lower-cased in JavaScript. Postgres
  `lower()` follows the DATABASE's collation, and a cluster created with
  `--locale=C` — the default in a container and on a minimal Linux install —
  leaves Cyrillic untouched. `lower('Ѓ')` is then still `'Ѓ'`, "does this
  therapist already exist?" answers no every time, and the insert dies on the
  unique constraint: **HTTP 500, `duplicate key`**, which reads as a bug in the
  endpoint. Six of the roster tests failed in six different-looking ways before
  the cause was one line. The server now checks at startup and on
  `/api/health`. Create the database as
  `CREATE DATABASE therapy TEMPLATE template0 ENCODING UTF8 LC_COLLATE 'C.utf8'
  LC_CTYPE 'C.utf8';` — the setup scripts do not pin this yet, which is open
  work.
- **A merged term is one session, and only the time says so.** Two adjacent
  slots worked as one long session are written as two slot keys carrying the
  SAME time string (`"09:40-10:20 + 10:25-11:05"`), and the diary's own rebuild
  de-duplicates on date + time. Two genuinely separate consecutive terms look
  identical in (day, position) and differ only in that string, which
  `attendance` did not store until migration 012. Anything counting sessions
  from marks alone credits an extra activity per merged term, for ever, and the
  number looks plausible. The migration backfills the times out of the blob
  rather than waiting for the next save, because "remember to save first" is the
  kind of ordering trap this project keeps being bitten by.
- **The projection could only ever ADD progress.** `student_plan_progress` was
  upserted and never trimmed, so unticking a session in the diary shrank the
  app's list and left the row in the database — the overview then reported more
  completed activities than the therapist's own screen. Now a document that
  carries a list for (student, plan) also takes away what that list no longer
  claims, scoped to that pair. Absence still says nothing: an app that has not
  pulled yet is missing everything.
- **`npm run export` used to drop the attendance time.** It emitted the bare
  `"present"` string — the older of the two shapes the diary accepts, and
  lossless right up until progress started being counted in sessions. It now
  emits the object with the time when there is one, and the bare string when
  there is not, so nothing is invented. Not a change of shape in the sense rule
  4 forbids: the diary has always read both and its own export writes the object.
- **CORS listed only GET, PUT and OPTIONS** long after roster-write started
  using POST, PATCH and DELETE. It worked by accident — the apps are served BY
  this server, so those calls are same-origin and never preflighted. The
  published GitHub Pages copy is not, and would have been refused the moment
  anyone pointed it at a tailnet address.
- **A static root is a disclosure boundary.** The local server used to mount
  `@fastify/static` at the repository root without an allowlist. A tailnet/LAN
  caller could therefore request `server/.env`, Git metadata, migrations,
  scripts or ignored local handoff data. Plugin dotfile settings are not enough:
  ordinary private files still sit below that root. `lib/public-static.ts` now
  permits only named top-level app assets, and `public-static.test.ts` plus a
  live HTTP smoke test prove private paths return 404. Never replace that list
  with a wildcard or publish a directory merely because one file in it is safe.
- **"Is this device new?" must be asked at page load.** Building the payload
  writes to localStorage, so asking later always answers "not new" — and a fresh
  device would push its built-in defaults over a year of real work instead of
  pulling. But for "may I create the server state?", ask whether the *payload has
  content* — otherwise someone who starts entering data on a new machine can
  never save it.

- **A migration guard must ask about the object it is going to change, not
  about its name anywhere in the cluster.** `pg_tables`, `pg_indexes`,
  `pg_constraint` and `information_schema` answer for the whole database, while
  the `ALTER TABLE` under the guard resolves through `search_path`.
  `projection.test.ts` applies every migration into a disposable schema whose
  `search_path` is that schema alone, so the moment `public.specialist_categories`
  existed, 024's guard read PUBLIC's copy, concluded the rename was already done,
  skipped it, and the next statement failed on a table that was never renamed —
  twelve tests red in one file, and nothing wrong with the code they test. Use
  `to_regclass('x')` for a table or index and `conrelid = to_regclass('x')` for a
  constraint: both resolve the name exactly as the statement will.
- **`IF NOT EXISTS` turns a superseded migration into a resurrection.** 023
  creates `cabinets` and two `cabinet_id` columns; 024 renames all three. Because
  every statement in 023 says `IF NOT EXISTS`, applying it by hand after 024 does
  not fail — it recreates the old table beside the new one and the old columns
  beside the new ones, all empty, and 024 can then never run again. `schema_migrations`
  is the thing that normally prevents this, which is the whole argument for
  `scripts/setup-home-postgres.ps1` over pasting a file into psql: it applies each
  migration once, with its ledger row, in one transaction. 023 now refuses out
  loud instead, and `database/repair/023_rerun_drift.sql` cleans a database where
  it already happened.
- **The rule you just quoted is the one you break.** A handover document
  written for the next working day carried three real names — two pupils and a
  colleague — into this public repository, hours after its author had quoted
  Rule 1 out of this very file. Code does not leak names; it calls things
  `student_id`. Prose does, because a document explains itself with the person
  in front of you, and a handover is written fast and reviewed by nobody.
  Removing them cost a history rewrite plus a ticket to GitHub Support: a
  force-push leaves the old commits reachable through `refs/pull/*` and
  GitHub's cached views until Support dereferences them and runs `gc`. The
  check had existed the whole time — `check:names` takes its blocklist from the
  local database, so all three names were in it — and nothing ran it.
  `.githooks/pre-commit` now does, and refuses rather than warns;
  `scripts/verify-name-guard.ps1` proves that it still refuses, in both
  directions, instead of asserting it.
- **A PowerShell wrapper hides the tool it is checking.** Two separate ways,
  both hit while proving the hook above actually refuses. First, a native
  command's output is decoded with the *console* codepage, so a Cyrillic name
  read out of `psql` into a variable arrives as mojibake — the guard then
  correctly finds nothing and looks broken; `psql -o <file>` writes it straight
  to disk and never touches the console. Second, `2>&1` on a native command
  turns its stderr into ErrorRecords, and under `$ErrorActionPreference =
  'Stop'` those THROW — so a guard that works kills the script that verifies
  it, and the failure reads like a crash rather than a catch. Set
  `$ErrorActionPreference = 'Continue'` around the call and read `$LASTEXITCODE`.

## Moving Rasporedi onto the database

Rasporedi cannot be shared as it stands: every save replaces the whole week, so
two therapists editing DIFFERENT cells still destroy each other's work, silently.
There is nothing to merge because the unit of change is the entire document.

The map, from reading it: students and therapists are plain global arrays (3 and
2 mutation sites), `studentMeta` is touched in 32 places, and every schedule edit
funnels through ONE function — `applyAssignment(day, time, therapist, value)` —
whose signature is already an API call. `saveScheduleToLocal()` is the single
persist point, called from 24 places. `GET /api/schedule` already returns exactly
the shape `scheduleData.schedule` holds, so reads need no translation.

Staged, each shippable alone:

- **A. the weekly grid, per cell — DONE, behind a flag that is off.**
  `PUT /api/schedule/slot`; a cell is (day, time, therapist), so two therapists
  never touch the same row and there is no conflict to resolve. Same-cell edits
  pass `expected` and get a 409 naming what is actually there — baseVersion, per
  row instead of per document.
  In the app: `RSlots` (end of `Rasporedi.html`). `applyAssignment` queues the
  intent — that one function is the choke point for all eleven edit paths — and
  `saveScheduleToLocal` flushes the queue, because it already runs after every
  edit. Turn it on with `RSlots.enable()` in the console, off with
  `RSlots.disable()`; the default is off and nothing changes until it is set.
  **When it is on the blob must stop carrying the schedule**, or a whole-document
  save would replace everyone's week with one browser's view. The app sets
  `unifiedMeta.slotWrites` and the projection skips the schedule section entirely.
  Proven with two browsers editing at once: with the flag off one therapist's
  cell is destroyed, with it on both survive, the blob does not undo them, and a
  refresh shows each therapist the other's work.
- **B. the roster, one person at a time — DONE, behind the same flag.**
  `POST /api/students`, `PATCH /api/students/:publicId`, `POST /api/therapists`,
  `PATCH /api/therapists/:name` (`server/src/routes/roster-write.ts`).
  Stage A had left a hole: with per-cell writes on, the blob no longer carries
  the schedule, so a cell naming a student the database had never heard of came
  back 404 and the term was silently missing on the server. Adding a name had no
  path of its own — it rode inside the whole-document save, which is what
  Stage A stopped doing.
  In the app: RSlots **diffs** the roster rather than instrumenting call sites.
  The key is `studentMeta[name].studentId`, which the server computes with the
  same formula — so a rename is a PATCH on the same row and every term,
  attendance mark and dossier follows it, and one diff covers all of quick-add,
  the CRUD panel, the roster editor, merge and the year rollover without
  touching any of them. `seen` (localStorage `rasporedi_roster_seen_v1`) is
  seeded from the server on first use so the first save does not resend 82
  students. Roster flushes BEFORE cells, or a new student's term 404s.
  **There is no delete, deliberately** — see the rule below.
  Two things a diff cannot see, so they are stated: a therapist rename
  (no stable id — dropping „Ана" and adding „Ана С." is indistinguishable from
  renaming) via `RSlots.renameTherapist`, and a bulk restructure
  (`installState`: new school year, merging a colleague's schedule) via
  `RSlots.noteBulkChange`, which re-seeds from the server and pushes the whole
  week. "This reviewed state wins" is correct there and only there — the person
  just approved a preview that rewrites the year.
  Proven three ways: `test/roster-write.e2e.ts` (14 server assertions),
  `test/roster-write.browser.mjs` (13 in a real browser, all read from the
  database, never the app's own opinion), `test/roster-write-off.browser.mjs`
  (5: flag off → not one write leaves the browser, and the app still keeps
  everything locally).
- **C. read from the server on open — DONE, same flag.** `RSlots.hydrate()` on
  load pulls students, therapists and the week, and the blob stops being a sync
  channel.
  The merge rule is the project's rule applied per student instead of per
  document, with `seen` as the watermark: one side moved → take it; both moved →
  keep local and say so; absent locally but present in `seen` → it was removed
  here on purpose, do not bring it back. Guards: an empty database never empties
  the app, and neither does one holding less than half the local roster.
  **`seen` records what BOTH sides hold, not what the server holds.** Seeding it
  from the server alone was a bug with a real symptom — every server-only
  student looked deliberately-removed, so a student added on the other machine
  never arrived. Entries that differ are left out, which makes hydrate report
  them as a divergence rather than guess.
  Caseloads got their own path too: `PUT`/`DELETE /api/therapists/:name/students/:publicId`.
  That DELETE is not a contradiction of the no-delete rule — the rule protects
  people; unticking a box means "I no longer work with this child", which is
  Rasporedi's own decision.
  Proven by `test/hydrate.browser.mjs` (9 assertions).

Do NOT deploy A before September: the payoff only arrives when colleagues get
access, and the app is needed to build the new year's schedule first.

## Moving S-Dnevnik onto the database

Same move, different reason. S-Dnevnik has one user, so this is not about two
therapists colliding — it is about one therapist and two machines. The diary is
saved as a whole document, so each sync has exactly one safe answer: whichever
side changed since the two last agreed wins the WHOLE year. Mark Tuesday at
school and Wednesday at home before the two ever meet and there is nothing to
merge; `sync-peer` refuses, correctly, and a human has to throw one day away. At
the granularity of a row that situation stops existing.

The collections, and where each stands:

- **D. attendance, one mark at a time — DONE, behind a flag that is off.**
  `PUT /api/diary/attendance` (a mark is student + date + slot key), plus
  `GET /api/diary/attendance` and `GET /api/diary/progress` in the app's own
  shapes, and `POST /api/diary/progress/rebuild`
  (`server/src/routes/diary-write.ts`). `expected` gives a 409 naming what is
  really there.
  In the app: `SDiary` (end of `S-Dnevnik.html`). Turn it on with
  `SDiary.enable()` in the console, off with `SDiary.disable()`; default off.
  Like Stage B it **diffs** rather than instrumenting call sites — attendance is
  written in two places and progress in four, and one diff covers the ordinary
  click, the merged-cell path, import and the year rollover without touching any
  of them. The flush hangs off `window.saveData`, the global entry point.
  `seen` (localStorage `sdnevnik_attendance_seen_v1`) is the watermark, seeded
  only from marks BOTH sides already hold.
- **E. the diary's own week, one slot at a time — DONE, same flag.**
  `PUT /api/diary/schedule/slot`, `GET /api/diary/schedule`,
  `DELETE /api/diary/schedule` (the September one, below), and
  `PUT`/`GET /api/diary/schedule/history` for the week snapshots.
  A slot is (day, position) and holds an ORDERED LIST of students, not one —
  two children can share a term and the order is the therapist's. That is what
  migration 009's `ordinal` is for. The position is not decoration either:
  `attendance.slot_key` is literally `day || '-' || position`, so a slot's index
  is part of the identity of every mark filed under it.
  Sharper than attendance, because the week was REPLACED wholesale by a save
  (delete the year, re-insert). A save from the machine that had not pulled did
  not merely fail to add — it took the other machine's terms out and put its own
  back, in one statement.
  `scheduleHistory` moves with it rather than having its own marker: a snapshot
  is a copy of the week, so leaving the document in charge of the copies while
  the original is written per slot puts the two back in disagreement. First
  write wins, because that is what the diary itself does
  (`if (!scheduleHistory[weekKey])`) and what a snapshot means.
- **F. the clinical records, one record at a time — DONE, same flag.**
  Dossier, assessments, scale templates, triage tests, audiograms.
  `PUT`/`DELETE /api/diary/record/*` and one `GET /api/diary/records`
  (`server/src/routes/record-write.ts`).
  These five are the diary's alone — Rasporedi never sees them — so there is no
  second owner to protect against, and **DELETE exists**. That is not a
  contradiction of the roster rule: the rule protects PEOPLE. An assessment
  entered against the wrong child is a document the therapist created and can
  uncreate. Nothing here can delete a person, and nothing here can create one —
  an audiogram naming someone off the roster is kept with the name and no link.
  Deleting a scale template does NOT delete the assessments made with it
  (`template_id` is ON DELETE SET NULL); the answer says how many it cut loose.
- G, not started: plans, plan activities and `links`. The smallest of them, and
  the last of the diary's collections.

### Audiograms had no identity, and that was the whole problem

Every other clinical record carries an id the diary gave it. Audiograms carry
nothing: they arrive from standalone exports and merged files and are described
only by whose hearing it is, when it was measured, and the curves. That is why
the projection **deleted every audiogram row and re-inserted the list on every
single save** — the only thing possible without an identity, and the thing that
made a per-record write impossible.

So the id is derived from the content, computed identically in the app and the
server (migration 013, `audiogramId` in `lib/records.ts` and in `S-Dnevnik.html`)
— the same arrangement `stableStudentIdForName` uses, for the same reason: two
machines must reach the same id without talking. Curve keys are sorted as
STRINGS, so "1000" sorts before "250"; not the order a person would pick, but
the one both sides get right without agreeing how to parse a number.

Two consequences worth knowing:

- Two audiograms with the same subject, date, kind and identical curves are ONE
  record. They are indistinguishable in the data, so keeping both would keep a
  difference nobody can see.
- A changed curve is a DIFFERENT record, not the same one edited. That is what
  content-addressing means, and the hydrate merge is written accordingly.

Migration 013 empties the table rather than backfilling. That costs nothing and
it is a measurement, not a hope: the projection has replaced every audiogram row
on every save since the table existed, so its entire content is already a copy
of the blob, and the next ordinary save puts it back — this time with ids.

### One mapping, two callers

Stage F did not write any new row-mapping code. It moved the existing mapping
out of the projection into `server/src/lib/records.ts` and pointed both the
projection and the new endpoints at it.

That was the point. A second caller writing the same rows a slightly different
way is the failure this project keeps paying for, and it stays invisible until
two numbers disagree. `test/records.e2e.ts` asserts it directly: a record
written through its endpoint and the same record projected from a whole document
must produce a byte-identical row.

### September is now a question the server can answer

„Заврши учебна година" empties the week in place. Under per-slot writes that
becomes twenty-five individual "this slot is now empty" writes — and if the
database has not been rolled over first, those are twenty-five deletions from
the year that is still running. The empty-payload guard cannot help: each one is
an explicit intent, not an absence.

So the app states it once instead. `SDiary.clearWeek(label)` sends
`DELETE /api/diary/schedule` naming the year it believes it is CLOSING (not the
one it is opening — at that moment the diary's calendar still says the old year;
the therapist updates it in the next step). If the database still calls that
year current, the server refuses with `rollFirst: true` and the command to run,
and the app says so rather than reporting a clean transition. The documented
ordering trap is now a sentence instead of a year of terms.

### Progress is not a collection

It looks like one — `studentProgress[studentId][planId]` is a list, it is in the
payload, it has a table. It is not. Every progress checkbox in S-Dnevnik is
rendered `disabled`: there is no way to tick an activity by hand, at all. The
list is produced by `checkNextActivity` when a session is marked present, undone
by `uncheckLastActivity`, and `rebuildStudentProgress` exists to throw it away
and recompute it from attendance. **Attendance is the fact; progress is a view
of it** (rule 5), so there is deliberately no endpoint that writes progress.

Giving it one would create the second owner the rule forbids, and the failure is
concrete: two machines that have not seen each other each compute "the next
unfinished activity is #3" and each write #3 with their own date. The second
wins the row and one session's progress is gone — leaving a plausible number,
which is worse than an obviously missing one. Derived from attendance, both
marks are rows and both count.

`server/src/lib/progress.ts` derives it, in the same transaction as the mark.
It follows the app exactly, including what look like quirks, because the
therapist's screen is what the numbers must agree with. Two deliberate
differences, both corrections: it is scoped to the current school year (the app
walks every date it holds, which after the September reset would rebuild last
year's progress from last year's attendance — the thing `progressArchive[year]`
exists to prevent), and it refuses rather than clearing when it cannot see
enough.

### `_meta.rowWrites`

Rasporedi announces per-row writes with `unifiedMeta.slotWrites`, a boolean,
because it moved in one step. S-Dnevnik moves collection by collection, so the
marker is a LIST of what has moved: `_meta.rowWrites: ['attendance']`. The
projection skips exactly those sections; absent means nothing has moved and
everything projects as before, which is what keeps the old apps working
(rule 4). It lives in `_meta` because the app already strips `_meta` before
fingerprinting, so the marker cannot make the app think its own state changed.

It is stamped in `putState`, NOT in `currentPayload` — the same builder makes
the JSON export file, and a file import must restore *everything*. `import-json`
strips the marker for the same reason and says so.

Proven by `test/diary-write.e2e.ts` (34 server assertions, including migration
012's backfill run from the migration file itself),
`test/diary-schedule.e2e.ts` (30, including the September transition tried both
ways round), `test/diary-write.browser.mjs` (21) and
`test/diary-schedule.browser.mjs` (15) in a real browser, every write assertion
reading the database and never the app's opinion, and
`test/diary-write-off.browser.mjs` (12: flag off → not one per-mark or per-slot
write leaves the browser, the diary keeps both locally, and the whole-document
save still decides everything). The browser tests refuse to start unless the
database name looks like a scratch one, because they clear `app_state`.

### For the next collection

- The single persist point is `window.saveData`. Not `SdnV3.saveFullPayload` —
  that is the inner closure and wrapping it does nothing.
- The two whole-document apply sites are `SdnLocalSrv.pull()` and `doPull()`.
  Both now route the server payload through `SDiary.keepOwned` first. Anything
  that moves to rows must be added there too, or the auto-sync will put the old
  copy back on every page load — measured for Rasporedi, and worse here because
  the diary travels between machines.
- Ask what the September transition does to the collection before moving it. The
  week had to gain an endpoint of its own purely because the year-end empties it,
  and twenty-five explicit deletions are not the same thing as an empty document.
  Progress has the same shape (reset each September, archived per year) and is
  already handled by deriving inside the current year only.
- The diary does not create students; a mark for an unlinked one answers 404 and
  names the cure. Leave `students` in the blob until something is ready to own
  it, or Stage A's hole reopens in a new place.
- The blob still CARRIES what has moved. It has to (rule 4). It simply stops
  being what the tables believe. `npm run export` reads the tables, not the
  blob, so the escape hatch stays truthful.

## Настава ↔ терапии — the crossing

Rasporedi has always known that a therapist takes a child at 09:40. It never
knew what the child was taken OUT of. The school keeps that in its own
workbook, and the two had never met.

Migration 014 gives the timetable tables of its own — `bell_periods`,
`school_classes`, `teachers`, `lessons` — filled by
`npm run import:teaching -- <workbook.xlsx>`. The workbook itself stays outside
the repository: it carries real teacher names (rules 1 and 6). The parser is a
pure function over a 2-D grid precisely so the tests can use an invented
timetable instead.

**The bells are data, not constants, and that is the whole point.** Teaching
rings at 07:30 and the cabinet at 08:00, so a 40-minute session does not sit
inside a 40-minute lesson — it straddles two:

| cabinet block | overlaps |
|---|---|
| I · 08:00 | 2. час **25 мин** · 1. час 10 мин |
| II · 08:45 | 3. час **15 мин** · 2. час 10 мин |
| III · 09:40 | 4. час **25 мин** · 3. час 10 мин |
| IV · 10:25 | 5. час **25 мин** · 4. час 10 мин |
| V · 11:10 | 6. час **25 мин** · 5. час 10 мин |
| VI · 11:55 | 7. час **25 мин** · 6. час 10 мин |

Block II is the one that proves the point: the long break after the second
lesson is 55 minutes rather than 45, so it reaches only 15 minutes into the
third. A rule of thumb ("block N is lesson N+1") would get that one wrong.

An earlier experimental fork matched by ORDINAL — block I to lesson 1 — and it
looked right in every screenshot while naming the wrong lesson everywhere.
`lib/crossing.ts` intersects real minutes instead. If the school and the
cabinet are ever brought onto one bell, the same code returns a single exact
40-minute overlap and nothing has to change.

`minShare` (default 0.5) is the judgement, in one place: ten minutes of a
lesson is not an absence, twenty-five is. A session that reaches half of
nothing still reports its largest overlap, because a child who is out is out.

**A session is assembled before it is measured, and that is not tidying.** The
schedule stores one row per TWENTY-minute half, so a forty-minute session is
two rows — and with the bells thirty minutes apart the two halves fall in
different lessons: 08:00–08:20 is mostly the first, 08:20–08:40 the second.
Measured apart, one child out of one session is reported missing from two
lessons, from neither of which they are away for long. `mergeAdjacent` joins
touching spans per (day, therapist, student) first; a gap is left alone,
because a gap means the child went back to class.

The first version matched a slot against a table of cabinet period STARTS, and
that lost the whole second half of the week: 08:20 is nobody's period start, so
every second half was reported unplaceable — and a child booked ONLY in a
second half vanished from the crossing entirely while sitting in the schedule.
`slotBell` now reads the slot's own label (`"08:00-08:20"`, or
`"09:40-10:20 + 10:25-11:05"` for a merged term: first clock to last). The
cabinet bell table survives only to explain the mapping in the page's legend.

**Timetables are archived by year, like everything else** (migration 015).
`lessons` carries a `school_year_id`, the unique key and `teaching_clashes`
include it, and `/api/teaching/timetable` and `/api/teaching/crossing` take
`?year=`, defaulting to the current one. Without it an archived crossing was
impossible: last year's therapy could only be read against today's class
timetable, which is a different school. The crossing also reads the class from
`student_enrollments` for THAT year rather than from `students.grade`, so a
child who moved up is shown in the class they were actually in.

`Nastava.html` has a year picker that mirrors into `?year=` in the address bar,
and labels an archived view as one so nobody mistakes it for today.

**It is a page, not a tab, and not an app.** `Nastava.html` reads
`/api/teaching/crossing` and draws it. It has no roster, no localStorage, no
sync and no writes — so it cannot disagree with anything, and it can be handed
to a teacher or to the director without handing them the screens that edit the
schedule. `Rasporedi.html` is untouched, which matters while it is mid-migration
onto the database.

That is the lesson from the experimental fork: a second APP means a second
roster, a second sync path and a second copy of every identity decision — the
fork had all three, and had lost `RSlots` entirely. A second PAGE that owns no
data has none of that cost.

**One owner for the arithmetic.** Unlike `audiogramId`, the sums are not copied
into the browser at all: they depend on the bell table, the bell table is in the
database, and a second copy could drift by a minute unnoticed. The cost is that
the page needs the server — which is honest, since without it there is no
timetable to cross against either. It says so, and points at `start.html`,
instead of drawing an empty school.

**Nothing is folded.** VI and VI-а are different rooms with different children.
`normalizeClassLabel` folds FORMATTING only — spacing, separator, and the Latin
and Cyrillic letters that look identical (`VI-a` → `VI-а`, `ІХ` → `IX`). A class
that does not match is listed under „Неповрзани третмани" with a reason, as work
for a person (rule 2). On the real data that list is long, and the root cause is
in the roster rather than here: the class is embedded in the student's NAME
("V-а - Бојана Пробена") instead of in `students.grade`. Fixing that is the
single change that would clear most of it.

The workbook cannot say everything. A subject teacher who also leads a class is
listed by their class, never by their subject, so those seven subjects are typed
in once through `PUT /api/teaching/teacher/:id` — and `writeTeaching` only ever
FILLS a blank subject, never clears one, so re-importing the workbook does not
undo it.

Two views, because the staff already read one of them: „По одделение" is the
heat map, „По наставник" is the shape the school's own workbook prints.

Proven by `test/crossing.test.ts` and `test/teaching.test.ts` (25 unit, no
server), `test/teaching.e2e.ts` (30 against a real database) and
`test/nastava.browser.mjs` (18 in a real browser, every number read back from
the database).

Three faults the tests found before a person did. The browser suite: changing
the day while the first fetch was in flight was silently dropped, leaving
yesterday's grid under today's label — requests carry a ticket now and only the
newest one draws. The e2e suite, on a POPULATED machine, found the other two,
and both are about a suite that shares a database with a real school:

- asserting day totals met 76 real sessions where it expected one, which is why
  every assertion is now scoped to the suite's own therapists;
- the twenty-minute-half fault above, invisible on a scratch database because
  the fixtures booked whole blocks.

**The e2e now works in a school year of its own** — created at the start,
dropped at the end, cascading away its own lessons, slots and enrollments. It
had been writing its eight-lesson fixture into the CURRENT year, where the real
451-lesson timetable already sat; `writeTeaching` refuses a timetable that
shrinks by more than half, correctly, so the fixture silently did not land and
every later assertion read the real school. Nothing is snapshotted and put back
any more, and the school's timetable is never touched at all. Two things that
had to be got right: `cleanup` must NOT drop the year (it runs inside `seed`,
after the timetable is written, and cascaded it away), and teachers are global
rather than per-year, so the fixture's three are cleared BEFORE the timetable is
written — a subject typed in by one run is otherwise still there in the next,
and the suite passes once and fails ever after.

### The timetable had one way in, and it was the wrong shape for a year

Until now the only way to write a timetable was `npm run import:teaching`,
which REPLACES a whole year from the school's workbook. That is right for
September and wrong for the other nine months, when what actually happens is
one change at a time — a teacher leaves in November, two classes swap a period
in February, somebody notices in March that Tuesday's fourth is wrong.
Re-importing a corrected workbook for a single cell throws away every hand
correction made since the last import.

So there is now a cell-by-cell path (`lib/teaching-edit.ts`,
`routes/teaching-edit.ts`) and a page for it.

**A second PAGE again, not an edit mode.** `Nastava.html` can be handed to a
teacher or to the director precisely because it owns nothing and writes
nothing, and that property ends the moment the same page can change the
timetable. `NastavaUredi.html` is a different address; the read-only page and
its eighteen assertions are untouched.

**No local copy, deliberately.** Rasporedi and S-Dnevnik keep their own copy
for historical reasons; the timetable never had one, so a write either lands or
is reported as failed. There is no queue, nothing kept "for later", and the
browser suite asserts it directly — `localStorage.length` is 0 after a full
editing session. That is the one claim in the page's own header that could rot
silently, so it is a test rather than a comment.

Three things are deliberately impossible:

- **Deleting a class or a teacher.** A class with no lessons this year is a
  class that is not timetabled, which is a different fact from "does not
  exist" — and archived years point at both rows and must keep reading
  correctly for ever. Same reasoning as `roster-write.ts` having no DELETE;
  the tests assert the absence (both routes must answer 404). Clearing a class
  out of a year is done by deleting its lessons.
- **Writing over a cell that holds two lessons.** That is a real clash from the
  workbook, and "the" lesson does not exist to be written — one of them would
  be picked silently. The caller is told what is there and deletes one first,
  which makes the editor the tool that FIXES clashes rather than one that hides
  them.
- **Copying a year onto a year that already has lessons**, unless the caller
  says so in as many words. "Copy last year" and "throw this year away" are two
  intentions and one button must not mean both, so `apply` and `replace` are
  separate words.

**Copying does NOT promote the classes**, and this is the decision most likely
to be "fixed" by someone later. IV-б stays IV-б. A school timetables a
CLASSROOM — last year's IV-б timetable belongs to this year's IV-б, a different
set of children one year younger, and not to the children who moved up.
Promoting the label would put the new fourth-graders on the fifth grade's
timetable and it would look entirely plausible. (The test that asserts this is
documentation, not a trap that springs: nothing in the code promotes anything,
so it passes either way. It is there so that whoever adds promotion has to
delete an assertion that says why not.)

`expected` is the same row-level check as everywhere else — the caller says what
it believes is in the cell and gets a 409 naming what really is. It matters less
here than in Rasporedi (one person edits a timetable, not ten) and it still
earns its place: a tab left open since morning is a stale view of a table
somebody may have re-imported since.

**Bells belong to the selected year.** `bell_periods` is the default pattern;
`bell_period_overrides` stores only a year's differences. This became necessary
when morning teaching moved from 07:30 in 2025/2026 to the same 08:00 blocks as
S-Dnevnik in 2026/2027. The editor always writes an override for the selected
year, archived crossings keep their historical bells, and rollover carries the
effective overrides into the next year. Never update the base row from the UI.

Proven by `test/teaching-edit.e2e.ts` (against a real database, in school years
of its own) and `test/nastava-uredi.browser.mjs` (30 in a real
browser, every write read back from the database). The e2e's guards were checked
to FAIL first: removing the `expected` check and the `day_order` computation
breaks five assertions, which is what a regression test is for. The browser
suite writes **no screenshot** — this page lists real teacher names, and a PNG
of it has no business near a public repository (rule 6).

The last assertion is the one the whole thing is for: a hand-entered lesson is
crossed exactly like an imported one. It is easy to write a row that exists,
draws correctly in the editor, and never appears in the crossing because
`day_order` is 0 or the day is spelled with a capital — and nothing would ever
say so.

### A teacher has classes, plural, and they belong to a year

`teachers.homeroom_class_id` held exactly one class and had no year. Both are
wrong for this school, and the third consequence is the one that would have
gone unnoticed:

- **Комбинирани паралелки.** A class teacher can hold two or three classes
  taught together as one group. One column cannot say that, and the workbook's
  „ОДД." cell really does list more than one.
- **A subject teacher belongs to several classes by definition** — every class
  they enter. The old column was only ever filled for the one class they also
  led, so the question "which classes does this teacher have?" had no answer at
  all for most of the staff.
- **A homeroom is a fact about a YEAR.** Without one, importing 2026/2027
  silently overwrote what 2025/2026 said, and an archived crossing then named
  the wrong teacher against last March. Nothing on any screen would have shown
  it.

Migration 016 moves it to `teacher_classes (school_year_id, teacher_id,
class_id, role)` and drops the column. `role` separates the two senses the
school separates: `homeroom` is одделенски раководител, `subject` is a teacher
who enters that class. One teacher can be both, in different classes, in one
year.

It is backfilled twice on purpose: from the old column, and from the timetable
itself — teaching a class IS belonging to it, so the list is useful the moment
a workbook has been imported instead of a blank screen somebody fills in twice.
`writeTeaching` keeps doing the same, and only ever ADDS: a class typed in by
hand is not contradicted by a workbook that happens not to mention it.

**The list is replaced as a set, not written row by row**, which is the
opposite of a schedule cell and deliberately so. A cell is contended — two
people editing one week is the failure Stage A exists to prevent. A teacher's
class list is three or four labels on one screen, edited by one person, and a
set has no `expected` that means anything. What it does have is a pre-check:
every label is verified BEFORE anything is written, because a list where one
name is mistyped must not half-apply and leave a teacher holding three of their
four classes with nothing on screen to say which one went missing.

### The lists a year is made of

`Podatoci.html` — students (with their class for that year), teachers (kind,
subject, classes), therapists (and whose caseload they are on), classes.

It exists because the teaching half became fully editable while the people half
was reachable only through Rasporedi with `RSlots` on, and that flag is off
until September. So in practice a student's class — the single field that
decides whether a therapy session can be attached to a lesson at all — could
not be corrected anywhere.

Same shape as `NastavaUredi.html`: writes straight to the database, no flag, no
local copy, no queue. The browser suite asserts `localStorage.length` is 0
after a full editing session, because that is the claim most able to rot.

What it will NOT do, and the reason each time:

- **Archive or restore a student.** S-Dnevnik's archive owns who is enrolled
  (rule 5). An archived child is SHOWN here, locked, with no save button —
  hiding them would look like data loss and editing them would be a second
  owner.
- **Add a student to a year that is over.** `POST /api/students` enrols into
  the current year and there is no honest meaning for anything else. Corrections
  to an archived year's classes are allowed, because reading an old crossing
  correctly is exactly what they are for.
- **Replace a caseload.** Ticks are sent one at a time through the endpoints
  that already own them, so two people ticking different boxes cannot undo each
  other.

A rename of a therapist is a `PATCH`, never a delete-and-add: a therapist has no
id in the schedule — the NAME is the key there — so the foreign key is what
carries a week of terms across, and stating the intent is the only way to say it.

`GET /api/roster?year=` is one read for all four lists. Four separate fetches
would let the page draw a teacher holding a class its own class list has not
heard of yet, which looks exactly like data loss. It is deliberately not
`/api/teaching/timetable`, which carries every lesson of the year.

### The school's own list of pupils

Every September the resource centre writes the year's lists into its годишна
програма: which classes it formed, and who is in them. That document is the
source for a year — the previous year is a starting point, not the truth, and
about four entries in five carry over unchanged or by a rule the system already
knows.

The database had never seen it. A child's class only ever arrived embedded in
their NAME („V-а - Име Презиме"), typed into an app that had nowhere else to
put it, which is precisely why most therapy sessions could not be attached to a
lesson. `npm run import:roster -- <list.docx> --year 2025/2026` reads the Word
table and reports it against the database; `--apply` writes the class into the
ENROLMENT where it belongs and cleans the prefix out of the name.

The file never enters this repository (rules 1 and 6), so the reading is split
the way the timetable workbook's is: `docxTables` turns a .docx into grids of
strings and has no opinions about schools, and everything above it works on a
grid — so `roster-doc.test.ts` tests the rules against a school that does not
exist.

**Renaming is safe by construction, not by inspection.** A pupil is MATCHED on
`bareName`, which already ignores the class prefix, the trailing parenthetical,
the case and the spacing — so those are the only things that can differ between
the two spellings, and a genuinely different name never reaches the rename at
all: it is reported as unknown. `public_id` never moves, so every term, mark and
dossier follows without being touched.

**It creates nobody and removes nobody.** A name on the list the database has
never heard of is reported; adding a child is `POST /api/students` from
`Podatoci.html`, where a person can see the whole list while doing it. A child
in the database the list does not mention is reported too, and is usually
екстерен rather than gone. Two children with one name are reported and left
alone (rule 2) — there really are two „Јана Пробева".

#### The other two documents the school keeps

`npm run check:lists` reads them against the database and **writes nothing at
all — it has no `--apply`.** It exists to answer "how far apart are these?"
before anybody decides what the database should hold.

- **`список со вработени`** is 34 names and nothing else. No post, no subject,
  so it can say who the school employs and not what they do; наставник /
  специјален едукатор / помошен кадар is typed in `Podatoci.html`, by somebody
  who can see the whole list while deciding.
- **`Табела по одд МКФ и програма`** is per PUPIL, not per employee:
  попреченост, програма, class + teaching plan, and the **одделенски
  раководител by name**. It is the only place the комбинирани паралелки are
  written down, and the only place a homeroom teacher is stated per child.

Three things that document forced into the reader, each of which silently
loses data without it:

- **A vertically merged cell is filled from the row above.** Word writes
  `<w:vMerge w:val="restart"/>` on the first row of a merged block and a bare
  `<w:vMerge/>` on the rest, with the text only in the first. That table merges
  the class and the homeroom teacher down each class group — 65 pupils and 17
  filled class cells — so reading the cells literally leaves 48 children with
  no class, and the parse looks half empty rather than wrong.
- **The class and the teaching plan share one cell with no separator**
  („1-аНП со ОС"), so the split is by the known plan codes, longest first, or
  „НП со ППР" is read as „НП" and rubbish.
- **The class labels are ARABIC here („4-а") and ROMAN in the pupil list
  („IV-а").** `romanClassLabel` pairs them FOR THE REPORT and
  `normalizeClassLabel` is deliberately left alone — that function is the one
  copy every read path depends on, and widening it would change what the whole
  crossing folds together on the strength of one document. A комбинирана
  паралелка („1-ва комб. 2 и 3") is never translated at all: there is no Roman
  label for it and inventing one would invent a room.

### Годишната програма is the source for a year, and what it cannot say

Every August the school publishes ГОДИШНА ПРОГРАМА ЗА РАБОТА — a ~260 page
document whose **form and content are prescribed by a Правилник**
(бр. 08-3714/3, 29.05.2024, cited in its own preamble). That matters more than
it sounds: the section numbering and the tables are not one person's habit, so
a reader written against them has a real chance of still working in 2028.

Where the year lives in it:

| section | what it holds |
|---|---|
| §3.1 | every employee with **Работно место** — the role, which nothing else has |
| §3.3 | воспитувачи |
| §3.7 | totals: 65 employees — 21 наставен кадар, 19 стручни соработници, 6 воспитувачи, 2 административни, 16 технички, 1 директор |
| §3.10 | the паралелки and how many children in each |
| §8.1 | the calendar |
| §8.2 | **Поделба на класно раководство** (homeroom per class) and the оддели |
| §8.3 | the bells |

**What it does NOT say: which child is in which class.** §3.10 gives counts,
not names. That is the separate `список на ученици` — so a year needs TWO
documents, and `import:roster` reads the second one.

#### 2026/2027, as the school actually formed it

16 паралелки, 60 pupils. Eleven are numbered — I-а, I-б, II-а, II-б, V-а, V-б,
VI-а, VI-б, VIII, IX-а, IX-б — and **five are комбинирани, holding 23 of the 60
children**: I комб. (II, III), II комб. (2, 3, 4), III комб. (3, 4, 5),
IV комб. (7, 8) and V комб.

In §8.2 all five are written as nothing but „комбинирана паралелка". The
numbered ones are described by who they serve — „I а – ученици со аутизам",
„II а – ученици со оштетен слух".

Two consequences, and they are the reason nothing has been written yet:

- **`school_classes.label` is UNIQUE text.** Five rows all called „комбинирана
  паралелка" cannot exist. Nearly 40% of this year's children currently have
  nowhere to be recorded, and no amount of moving `grade` to a `class_id`
  changes that on its own.
- **`grade` was never one fact.** A child in „II комбинирана 2,3,4" is *in the
  third grade* and *taught in the second combined паралелка*. For eleven
  classes those coincide, which is why nobody noticed; for five they do not.
  A паралелка needs a kind (numbered / combined / preparatory / modified
  programme) and a SET of grades; an enrolment needs the child's grade and
  their паралелка separately.

#### The bells are settled

§8.3 gives 2026/2027 as 08:00, 08:45, 09:40, 10:25, 11:10, 11:55, 12:40 — 40
minutes each. That is exactly what migration 020 wrote as overrides for years
starting on or after 2026-09-01, so the question that had been open since the
crossing landed is answered from the source: **from this year teaching and the
cabinet ring together.** A therapy block now maps to one lesson instead of
straddling two, and archived years keep their 07:30 sequence.

#### The оддели, and three things the schema has no room for

§8.2 lists the school by department: **индивидуална рехабилитација** (9 people,
each with their кабинет — слушно-говорни вежби, психомоторна реедукација,
сензорна интеграција, логопедски, биофидбек, Монтесори, ортооптичко-плеоптички,
асистивна технологија, психолошки), **стручни соработници** (8), **ран детски
развој / подготвителен** (1), **образование на ученици со комплексни потреби —
модифицирана програма** (1), **продолжена програма** (3), **ученички дом** (4).

The schema holds none of that:

```
teachers        id, name, kind ('odd'|'pred'), subject
therapists      id, name
school_classes  id, label, sort_key
```

So **работно место**, **кабинет** and **оддел** have nowhere to live. The
годишна програма has all three, and `Podatoci.html` is the natural place to
enter them — a form is a person stating a fact, where a document parse is
inference that fails silently.

One trap if that form is built: if a „position" screen carries a dropdown of
names while the class screen already assigns a homeroom, „who leads I-а" is
stated twice (rule 5). The split that works — a POSITION is the job
(„одделенски наставник", „логопед", „воспитувач"); WHICH CLASS stays in
`teacher_classes`; a кабинет belongs to a therapist.

#### The PDF is not a reliable input, and that was measured

The годишна програма arrives as PDF. Ruled-table extraction was tried on the
2026/2027 file: §8.2's homeroom table came out as 17 rows with 7 phantom
columns, the оддели tables came out clean — and **§3.10, the single most
valuable table in the document, extracted as two empty tables.** Its header
cells are merged across two rows and line-based detection cannot see it. The
staff list spans three pages, so it arrives as three fragments with one header
between them.

That is on a file that parses. A reader that silently returns eleven classes
instead of sixteen is worse than no reader, so **the PDF path was deliberately
not built.** Either the .docx (which `docxTables` already reads, merged cells
included), or the five tables that matter copied into one Word file once a
year, or the form above.

#### Names disagree between the documents and the database

„Дарко Пробински" in the годишна програма against `ДАРКО ПРОБИЊСКИ` in the
database. „Ева Огледна" against `ЕВА ОГЛЕДНОВА`. And „Жарко Измисленовски"
on page 45 against „Жарко Измисленоски" on page 46 — the same person, two
spellings, one document, one page apart. Which is the whole argument for
reporting every mismatch and merging none of them (rule 2), made by the source
itself.

#### Two kinds of teaching that are not a numbered class

Told by the owner, and neither is in the model yet:

- **Модифицирана програма** is a category of class in its own right. Teaching
  happens there, but the children come from OTHER schools — they are not
  enrolled internally and attend as service sessions.
- **Предшколско / подготвително** is also teaching, with its own teacher.

This contradicts something the crossing currently assumes. `kind = 'external'`
was introduced to mean "belongs to no class and attends no lessons", and
`/api/teaching/crossing` reports those children in a calm panel saying exactly
that. A child in модифицирана програма is external by enrolment and **does**
have lessons, so a therapy session that collides with their teaching is
invisible today — reported as "attends no lessons" rather than as a clash.
Nothing has been changed for it yet; the fix is a class whose kind is not a
numbered grade, and it needs the lesson model that holds several classes.

#### How the school names a class, and what that costs

One class in a grade is a bare numeral („II"); two are „II-а" and „II-б"; three
add „II-в". So a bare numeral standing BESIDE lettered sections of the same
grade is a contradiction, and it is reported rather than folded — turning „IV"
into „IV-а" would move a child into a room they are not in, and every screen
afterwards would look entirely plausible. The 2025/2026 list contradicts itself
this way twice, for IV and for VI.

The same rule is why **promotion cannot be finished by a program.** The numeral
is arithmetic and certain; the letter is not, because the classes are formed
afresh each September and this year's two fourth classes may be one fifth class
or three. `--promote` therefore prints the two apart — certain and SUGGESTED —
and **writes nothing at all**. Who is on a year's list is owned by
`PUT /api/roster/memberships` and confirmed as reviewed suggestions in
`Podatoci.html`; a script writing the same fact would be the second owner this
project keeps having to undo (rule 5). Ninth-graders come out as finishing, not
as promoted.

### One spelling per person

The school's workbook types the staff in capitals, so all twenty-one teachers
were stored as „АНА ТЕСТОВА" and every screen that shows a name shouted.
`Podatoci.html` meanwhile title-cases a name as it saves it — so the one
teacher somebody had edited was stored differently from the twenty nobody had
touched. Two renderings of one fact, decided by which screen last pressed a
button (rule 5).

The second consequence is the one that would have cost data: the unique key on
`teachers.name` is the exact string. Edit a teacher in Podatoci, re-import the
workbook, and „АНА ТЕСТОВА" no longer conflicts with „Ана Тестова" — a
SECOND row for the same person, with the new year's lessons hanging off it
while `teacher_classes` still points at the old one, and both of them listed
on screen. Nothing would have said so.

`personName` in `server/src/lib/import-core.ts` is the rule, applied wherever a
teacher is written: the workbook importer and `POST /api/teaching/teacher`.
Migration 021 is the one-off for what was already stored, and `writeTeaching`
now resolves a teacher **case-insensitively** — the two close the same hole
from both ends. It also never writes the NAME back on a re-import: a workbook
that still shouts must not undo a correction somebody made on a screen, which
is the same rule the subject has had since the beginning.

**Only an entirely uppercase name is changed.** Any lower-case letter at all
means a person wrote it, and a person's spelling wins — „Ѓорѓи МОЈСОВ" stays as
typed, and so does an acronym somebody meant. Therapists and students are left
alone: none of them is in capitals, they do not come from the workbook, and a
student's name is the one field this project has already been burned touching.

`Podatoci.html` carries its own copy of the function, because a single-file app
cannot import from the server (rule 4). `reconcile.test.ts` pins the cases the
two have to agree on, including that running it twice cannot drift.

### „Бришење" means two things, and only one of them removes a row

Each year's lists come from the school's own official document — годишната
програма за работа на ресурсниот центар, which assigns the staff to positions
and forms that year's classes. So the lists are ENTERED fresh each September
rather than inherited, and last year's are a starting point: roughly four
entries in five carry over unchanged or change by a rule the system already
knows — a child moves up a class, the first-graders arrive, the ninth grade
leaves. `GET /api/roster?year=` offers exactly that: the previous year's
directory as candidates, each student with a `suggested_grade` from
`nextGrade`, and `graduated: true` for whoever has finished.

That is what makes the delete button two different requests wearing one word,
with opposite consequences and the same appearance on screen:

- **Not on this year's list.** A child who moved schools in October, a
  therapist who left in June, a class not taught this year, and every
  ninth-grader every June. This is the common case by a wide margin, and it is
  `PUT /api/roster/memberships` (`routes/annual-roster.ts`): `active = false`
  on that year's membership. Nobody is removed, last year still reads
  correctly, and September puts them back with a tick.
- **A name typed with a slip of the hand five minutes ago.** That is
  `DELETE /api/roster/{student|teacher|therapist|class}/…?year=&expected=`
  (`routes/roster-purge.ts`), and it is all that file does.

This is not a contradiction of the rule that Rasporedi may not delete a person.
That rule is about ADDRESSES as much as about capability: `/api/students` and
`/api/therapists` still have no DELETE at all and must keep having none,
because a browser holding a list from this morning must not be able to remove
anybody whatever it believes. The purge lives at its own path, used by one
screen with a person in front of it — the same reasoning that made
`NastavaUredi.html` a second page rather than an edit mode in `Nastava.html`.
`roster-purge.e2e.ts` asserts the absence at the old addresses too, because its
own reader is the one tempted to unify them.

**A year is required, and it is the sharpest guard of the lot.** Because the
lists are typed year by year from that document, a typo belongs to the year
being typed and to no other. A row that appears on ANY other year's list is
therefore not a typo — it is somebody who was there — and the answer is 409
naming those years, whether or not a single lesson was ever recorded against
them. Without this the sweep below would take an archived membership with it,
and for a teacher who taught no timetabled lesson that membership row is the
ONLY trace migration 018 keeps of their having been on the staff. An `active =
false` membership counts as much as an active one: being taken off a year is
not the same as never having been on it.

**Everything that records what somebody DID refuses; only the act of adding is
swept, and only for the year named.** Creating a person also puts them on that
year's list, so `student_enrollments` and the three `*_years` tables go with
the row — refusing on those would make the endpoint useless in the only case
it exists for. A student refuses on two further things that are not references
at all: an archived row (`active = false`) belongs to S-Dnevnik, which owns who
is enrolled (rule 5), and an `sdnevnik_id` means the diary already knows them,
so they were never a slip of the hand typed here.

**The caller must say which row it thinks it is deleting.** `expected` is the
same row-level check as everywhere else in this project, and it earns its place
precisely here: correcting a misspelling is what turns a typo into a person, so
a screen still showing the old spelling must be told the name has changed
rather than allowed to delete the corrected row by id.

Getting the blocker list wrong is not a 500 — it is silent destruction behind
an HTTP 200, because `lessons` CASCADES on a class and `schedule_slots`
CASCADES on a therapist, while `lessons.teacher_id` and
`schedule_slots.student_id` are ON DELETE SET NULL and would blank a year of
teaching rather than fail. So the suite derives the referencing tables from
`pg_constraint` and fails if the lists in the source have drifted — **and one
level below the swept tables too**, since the sweep is itself a DELETE and
anything referencing an enrolment or a membership would be cascaded away by it.
Nothing does today; the day something does, that is a conversation to have
rather than an extra deletion nobody notices.

**A class is held by the children recorded in it, and that is not a foreign
key.** The label is kept as plain text in TWO places — `student_enrollments.grade`
and `students.grade`, which `roster-write.ts` still writes — and both are
counted through `normalizeClassLabel`, the single copy of "these two labels are
the same room", because `IV-а` and `iv / a` are one class to a person and two
strings to `=`.

**Two locks, and each covers what the other cannot.**

- `SELECT … FOR UPDATE` on the directory row makes count-then-delete atomic for
  everything that IS a foreign key: PostgreSQL takes `FOR KEY SHARE` on a
  parent when a row referencing it is inserted, and that conflicts. A term
  booked while the endpoint is counting waits, and is then counted.
- It does nothing for the class label, because there is no foreign key to lock:
  an `UPDATE student_enrollments SET grade = 'IV-а'` can land between the count
  and the delete and neither statement blocks the other. The class path takes
  `LOCK TABLE students, student_enrollments IN SHARE MODE` instead, which
  conflicts with the `ROW EXCLUSIVE` every writer takes automatically. No
  cooperation is required from the write paths — an advisory lock that each
  future write path must remember to take is a rule that will be forgotten
  exactly once.

Two orderings in that are load-bearing and will look like tidying to whoever
reads them next. The table lock is taken **before** the row lock, because
`annual-roster.ts` writes `student_enrollments` and then touches
`school_classes`; the other order makes the two transactions wait on each other
and PostgreSQL aborts one as a deadlock. And `students` is locked **before**
`student_enrollments`, because that is the order every writer takes them —
`POST /api/students` inserts the person and then enrols them, and so does the
projection. `SET LOCAL lock_timeout` turns a wait behind somebody's open
transaction into a 503 the caller can retry rather than a hung request.

The right long-term answer to the label is a `class_id` on the enrolment. It is
deliberately not done here: `grade` is what every read path uses, so a second
column would be a second owner of "which class is this child in" (rule 5). That
migration has to move the readers too, and that is a change of its own.
### What the „clashes" in the imported timetable actually are

Measured on the real 2025/2026 import: 22 cells hold two lessons, and **17 of
them are one lesson written twice** — the одделенска half of the workbook names
the SUBJECT that class is doing in that period, and the предметна half names the
CLASS that subject teacher is with. Same lesson, seen from both sides of the
sheet. The pattern is `odd/с предмет + pred/без предмет` (15 cells) and
`pred/с предмет + pred/без предмет` (2).

Three consequences, none of them visible on a screen:

- `teaching_clashes` cries wolf 22 times, so a real clash would be lost in it;
- the crossing's `summary` counts those lessons twice (`cells` has one entry per
  ROW, and both rows key to the same absences);
- `NastavaUredi.html` refuses to edit those cells, because it correctly treats
  two rows in one cell as something a person must resolve.

And the genuinely useful clash is not computed at all: a teacher in two places
at once. On this data that is 0 — but nothing is looking.

The model that fixes all of it is one lesson holding several TEACHERS and, for
комбинирани паралелки, several CLASSES. That is agreed and not yet built; the
owner said the current timetable is a placeholder to be rebuilt from the new
teacher↔class mapping, so nothing was spent collapsing the existing rows.

### A child with no class is two different things

The school keeps three lists, not one: интерни ученици (grouped by class and
numbered within it), the интернатски children inside that list, and екстерни
ученици — children who belong to no class at all and come in only for therapy.

Nothing recorded which was which, so an external child was simply a student
with no class — indistinguishable from an internal child whose class nobody
had typed in. The crossing therefore reported every one of them as an
unattached session with the reason „ученикот нема запишано одделение": twenty
entries in a list of things to fix, none of which can ever be fixed, sitting
next to the ones that can. **A backlog that cannot shrink is one nobody reads,
and the real omissions hide in it.**

Migration 017 puts `kind` on the ENROLMENT — `internal` / `boarding` /
`external` — because a child can arrive as external and enrol the following
September, and last year's answer has to stay true. Three values rather than
two flags: интернатски is a boarding child, who is by definition also internal,
and a boarding EXTERNAL child is not a thing.

`/api/teaching/crossing` returns them in their own `external` list with their
own count, and `Nastava.html` draws them in a calm panel that says what they
are rather than what is missing. **The class still decides placement; the kind
only decides how a MISSING class is reported** — so correcting somebody's kind
can never change a number that was already right.

The backfill reads the existing data rather than guessing about people: a child
with no class in a year is external, which is exactly what the school's own two
lists mean. An internal child who really is missing a class is then the case
somebody corrects — they set the kind back and type the class in.

### The setup script asked for a password nobody has

`setup-home-postgres.ps1` needs the `postgres` superuser for exactly two
things: `CREATE ROLE` and `CREATE DATABASE`. On a machine that has been running
for a year both exist — and the superuser password is one nobody has typed
since the day PostgreSQL was installed. It died at the prompt, before reaching
the migrations it was run for, on the machine holding the real data. Twice.

It now probes as `therapy` first and asks for the superuser only when something
actually has to be created. The migrations were always applied as `therapy`
anyway; only the two creation steps ever needed more.

### The server decides who owns the roster, not the app

Stage A's guard was announced BY the app: Rasporedi sets `unifiedMeta.slotWrites`
and the projection then treats the roster as add-only. That worked while the
only screens that wrote a roster were the two apps themselves.

`Podatoci.html` broke it. It writes names, classes, kinds and caseloads straight
to the database, and the apps cannot announce a screen they have never heard of
— so with their flags off, every correction made there was undone by the next
„Зачувај на сервер" from a tab that had been open since morning. Not refused,
not reported: silently put back. **This shipped for half a day before it was
found**, with a page inviting somebody to spend an afternoon typing.

So the decision moved to the server. `projectPayload` takes
`{ rosterOwned }`, `routes/state.ts` passes `true` on every save, and the
document may CREATE a person but never restate one. The two questions that used
to be one are now separate: `scheduleOwned` (the app writes cells itself, so
skip the week) is still announced by the app; `rosterOwned` is not.

**A JSON FILE import is exempt, deliberately.** `import-json.ts` calls
`writeAll` without the flag, so opening the old app with yesterday's export and
importing it still restores everything, names included. That is rule 4's escape
hatch and it is the one place a document is still allowed to be the truth.

**The caseload is left out of a document entirely, not merely protected from
being cleared by it.** Add-only sounds like the safe half and is not: a box
UNticked in `Podatoci.html` would be put straight back by the next save from a
tab that still remembers it, and an undone correction is worse than a refused
one because nobody is told.

The control test moved rather than disappearing. It used to assert that WITHOUT
the marker a document still owned the roster — the assertion that made the guard
tests mean something. Now the real distinction is between a save and a file
import, so `roster-write.e2e.ts` asserts that a save is protected even with the
marker off, and `projection.test.ts` asserts the other half: the same document,
imported as a FILE, puts every name, class and caseload link back.

## An experimental app cannot rewrite the roster

`PUT /api/state/:app` used to project EVERY payload into the shared tables,
because `projectPayload` decides what a payload is by its SHAPE. That was fine
while only the two real apps existed. It stopped being fine the moment a fork
appeared: a prototype carrying a test roster is Rasporedi-shaped, so one press
of „Синхронизирај" would have rewritten `students`, `therapists` and
`schedule_slots` — and the near-empty-payload guard does not catch it, because
a test roster of 77 is not near-empty.

The slug decides now (`appMayProject` in `routes/state.ts`): `unified`,
`rasporedi`, `sdnevnik`, plus anything ending in `-test` because that is what
the e2e suites save under and what they assert afterwards is the tables.
Everything else is stored, versioned and readable back — as a blob, with
`projection.kind: 'blob only'` and a sentence saying why, so a caller cannot
mistake it for a full save.

## Reports from the assessments

The 0–4 scale reports print each assessment as its own standalone table, which
is right for one assessment and useless for a year: progress had to be read by
leafing between four sheets. „📈 Напредок" (`printAssessmentProgress`) puts the
indicators down the page and the terms across it, with what moved spelled out
in words underneath — the grid gives numbers, and a number alone does not say
what 3 means for that indicator.

Four things the pivot decides rather than stumbles into, each because getting
it wrong looks plausible:

- **Two assessments in one term** — the later one is shown and the other is
  NAMED under the table. A quietly dropped assessment is work nobody will think
  to look for.
- **More than one scale** — one table each. Indicators from different scales in
  one grid would put unrelated rows under the same numbers.
- **More than one school year** — one table each, newest first, the year
  computed September→August exactly as `school_years` tiles it. Otherwise last
  year's T1 stands in the same column as this year's.
- **An indicator not scored in some term** — blank, and excluded from that
  term's average and from the change. Zero and "not assessed" are not the same
  claim. For the same reason a single measurement shows "—" and not "=": one
  reading is nothing to compare, not an absence of progress.

The averages shown are the ones each assessment already carries — the number
the therapist saw and signed off, not a recomputation that could differ.

Cell colours come from `SCALE_COLORS`, but the text colour on top is COMPUTED
from the background's luminance (`readableOn`). White on the yellow and green
was close to unreadable, and this is a page that gets printed — on paper nobody
can zoom in or switch theme.

Proven by `test/progress-report.browser.mjs`, which checks the four rules above
and then renders the page and screenshots it. A report nobody has looked at is
not finished.

## Евидентен лист — the record a whole team writes

`AkciskiPlan.html` was the last screen still keeping its data in a browser: one
`localStorage` array holding every pupil's ЕВИДЕНТЕН ЛИСТ ЗА СЛЕДЕЊЕ НА
РАЗВОЈОТ И ПОСТИГНУВАЊАТА, exported and re-imported by hand. Migration 022, an
API of its own and a rewritten page put it on rows.

**Why this one had to move, and it is not the reason the others did.** The form
is not one therapist's document. Every section names its own испитувач —
дефектолог, логопед, психолог, тифлолог, сурдолог, биофидбек терапевт — because
a different person fills it. Saved as one document, the psychologist pressing
save at 10:05 wrote back the whole sheet as their tab had it at 09:30, and the
logopedist's morning was gone with nothing on either screen to say so. A score
is `(sheet, item, period)` now, so two specialists filling different sections
never share a row. Proven with two browsers in `evidence.browser.mjs`.

**Signing in began as authorship and now has an opt-in authorization role.**
The record has to say WHO wrote each line, so a therapist or teacher picks their
database identity and unlocks it with a salted scrypt PIN in `evidence_logins`;
`evidence_sessions` holds the session. With `MTB_REQUIRE_SIGNIN` unset this is
still only a staff-room lock and authorship stamp. With it set to `1`, the same
session drives the default-deny write boundary and evidence pupil scope in
`lib/colleague.ts`. Initial PINs are then administrator/service-only; changing
one needs its current value, that person's live session or the administrator,
and ends sessions opened with the old PIN.

This is operational authorization, not confidentiality. A four-digit PIN is
low-entropy, shared schedule/roster/conflict reads deliberately stay open, and
Tailscale remains the reachability boundary. Nothing here justifies exposing
the API publicly or putting data into it that the deployment cannot protect.

**The catalogue is data, and that is what „додавај и бриши полиња" means.** The
eleven sections, their groups, their 112 items and the twelve examiner lines
were a JavaScript literal; they are `evidence_sections` / `_groups` / `_items` /
`_examiner_roles`, seeded from that literal so nothing was retyped. An item's
`ord` starts at **0** deliberately: it is the index the old app used in its
score keys (`s6_3_m`), so a legacy export is read back item for item.

Which matters because the old records are still in the therapist's browser:
replacing the page did not move them. „Печатење" offers them under
`localStorage['el2_db']` — a file first, then the same import path — and READS
that key only. Writing or clearing it would take away the copy of somebody who
has not moved their records yet, so `app-contract.test.ts` asserts that only
`getItem` ever names it.

**Deleting from the catalogue is the two „бришења" again.** A line nobody has
scored is a typo and is deleted outright. A line that carries marks is history:
it is hidden (`active = false`), so it leaves every screen and the next printout
while the years already filled in still read correctly. Deleting it would
shorten last year's record and silently change the average printed under it. The
409 says how many marks are behind it and offers the other verb.

**The columns belong to a year.** The prescribed form has three (почеток, I
полугодие, крај); this centre assesses four times. Both are true, at different
times, so `evidence_periods` is per `school_year_id` and editable, created on
first use rather than in the migration — a year made next September gets its
four without anybody remembering a step. The DOCX prints one column per active
period, so „сите ученици" and „тековниот ученик" follow whatever the year says.
A mark written into another year's column is refused: the primary key would
accept it and an archived printout would quietly change.

**The sheet does not own the child's class.** `student_enrollments` does. The
page shows the grade and paralelka disabled, pointing at `Podatoci.html`, and
`splitClass` cuts „IV-а" into the two halves the printed form asks for — a
split copy cannot drift, a second column would (rule 5). Date of birth and the
diagnosis ARE copied once, at creation, out of S-Dnevnik's dossier: what the
therapist then signs on this form on this date is this document's own text, and
nothing reads it back.

**And it cannot delete a person.** „🗑 Избриши го листот" deletes the DOCUMENT
and says so, with the pupil's name as `expected`; the pupil, their enrolment and
their place on the year's list are untouched. `POST /api/students` is how a
pupil is added, because that endpoint already owns creating one and a second
creator would compute a different `public_id`. `evidence.e2e.ts` asserts the
absence at the old address too, exactly as `roster-purge.e2e.ts` does.

Nothing is kept in the browser but the token, the chosen server and the theme —
`localStorage` is asserted empty of everything else, because that is the claim
in the page's own header and the one most able to rot quietly.

Found by the browser suite before a person met it: `.gate { display: flex }`
beats the browser's own `[hidden]` rule, so after a successful sign-in the
overlay stayed on top of the page, invisible, swallowing every click. The page
looked signed in and did nothing.

Proven by `npm run test:evidence` (48 assertions against a real database, in a
school year and a catalogue section of its own — the catalogue is GLOBAL, so a
suite that hid a real section to prove a point would pass and be a bug) and
`npm run test:evidence-ui` (33 in a real browser, every write read back from the
database). The `expected` and cross-year guards were checked to FAIL first:
removing them breaks four assertions.

## Категоријата, и вториот каталог

The евидентен лист catalogue described exactly one document: eleven prescribed
sections that every pupil's sheet carries. What the centre actually needs on
top of it is a QUARTERLY ACTION PLAN whose sections depend on which cabinets
the pupil attends — the logopedic goals for a pupil who goes to the logopedic
cabinet, and not for one who does not.

Nothing in the schema could express that, because a therapist had no cabinet.
`therapists` was `(id, name)`. The годишна програма names all nine of
индивидуална рехабилитација, and this file had recorded for weeks that the
cabinet "has nowhere to live". Migration 023 gives it one.

**The cabinet became a CATEGORY (migration 024), one migration later.** Two
reasons. The concept is wider than a room: what owns an action-plan section is
the KIND of specialist writing it — логопед, психолог, педагог — and the
school's TEACHERS hold such a profile as well, as special educators, often
without a room at all. A column called `cabinet_id` on a teacher reads as
nonsense. And `cabinet` was already taken: `bell_periods.kind = 'kabinet'` is
the therapy bell schedule, in `crossing.ts`, `teaching.ts` and migrations 004
and 014. One word meaning two things in one system is the shape of mistake
this project keeps paying for; it was renamed while the table held nine seeded
rows and no real assignments, which is the cheap moment.

A therapist's category reaches a pupil through the CASELOAD; a teacher has no
caseload, so theirs reaches the pupil through the CLASS — matched with
`normalizeClassLabel`, the single copy of "these two labels are the same room".
Everyone reads everything, by the owner's decision; only writing is signed.

The rows are SEEDS, not code. `POST /api/categories` adds one, `PATCH` renames
it against the name the caller believes is there, and `PUT /api/categories/active`
retires it. There is no DELETE — archived sections point at it.

**No new subsystem, and that is the point.** `evidence_sections` +
`evidence_items` + `evidence_periods` + `evidence_scores` is already a generic
catalogue of sections with scales and per-period scores — the „Подесувања" tab
is that engine with a screen on it. The action plan does not need a second
engine; it needs the existing one to know that there is more than one
CATALOGUE. That is one column, `evidence_sections.catalog`.

**Why the catalogue split is not cosmetic.** The евидентен лист is a PRESCRIBED
form. Sections added for category goals would print inside it, and in two years
nobody could tell which sections the Правилник requires and which the school
added. `catalog` is what keeps the printed form able to say what it is; a
CHECK constraint makes the two shapes that read as "the section just does not
appear" impossible — an action section without a category, and a prescribed
section with one.

**Why the category assignment is annual.** It lives on `therapist_years` and
`teacher_years`, not on either person table. A person's professional role can
change, and a plan printed for an archived year must keep saying what was true
then. `teacher_classes`, `therapist_students` and `lessons` each taught this
lesson AFTER being written as a global fact first. The section's category is
deliberately not annual: a goal belongs to a kind of professional work, while
which person holds that work is the fact that changes by year.

**The annual relationship decides, never the timetable.**
`categoriesForPupil` reads `therapist_students` for therapists and
`teacher_classes` for teachers, and never `schedule_slots`. In September the
caseload and classes exist while the week may not, so a timetable-driven answer
would produce EMPTY action plans in the one month they are written.

**A decision is stored, a computation is not.** Which action sections a sheet
carries is derived. A signed specialist can override it, and that choice has to
survive the next page load or the derivation quietly overwrites the person —
the one-owner-per-fact failure this project keeps paying for. So
`evidence_sheet_sections` stores ONLY deviations. An absent row means "follow
the annual relationships", which is why a category assigned in February still reaches a sheet
opened in September; storing every section instead would freeze each sheet at
the moment it was created. And when a manual choice lands back on what the
derived lists already say, the row is REMOVED rather than stored as agreement —
otherwise the sheet stops following the caseload from then on, silently.

**A prescribed section cannot be switched off.** It is the form. The endpoint
answers 409 and says so.

`lib/categories.ts` holds the derivation, and both the sheet read and the
"which categories" endpoint go through it — `lib/records.ts` exists for the same
reason, and a second caller working the same answer out slightly differently
is the failure that stays invisible until two printouts disagree.

Proven by `npm run test:categories` (needs the server running): the schema
guards, annual therapist and teacher assignments, caseload and class derivation,
section ownership, creating the first action section, scale locking, manual
override and its removal, and the refusal to score an excluded section. Every
one was written to fail against the old behaviour first.


### Кој смее да ја менува секцијата

Everyone READS everything — the owner's decision, and why none of the reads is
behind the sign-in. Writing is narrower: **the section for a profile is edited
and scored by whoever holds that profile**. Adding an item, rewording one,
changing the scale and writing a mark are one permission, because they are all
"what this specialist says about this pupil". `assertMayEdit` in
`lib/categories.ts` is the single copy, called from eight endpoints.

Two things it deliberately does NOT do, and the second is the one worth
remembering.

**Prescribed sections are not restricted.** They are the евидентен лист itself,
the form everybody fills in together. Restricting them was not asked for and
would break the screen that exists. `test:categories` asserts this as a
CONTROL: without it the ownership assertions would also pass if the endpoint
simply refused everybody.

**Teachers and therapists share one signed-person path.** Migration 025 gives
`evidence_logins`, `evidence_sessions` and section deviations separate nullable
foreign keys for the two person tables, with a CHECK that exactly one is set.
The picker keys every choice as `kind:id`, because a teacher and therapist can
have the same numeric id. The API accepts that form and still accepts the old
`therapistId` request unchanged. `assertMayEdit` then applies the same rule to
both: a person writes an action section only while they hold its category for
the sheet's year. `test:categories` asserts both the new teacher path and the
legacy therapist spelling.

A catalogue edit has no sheet behind it, so ownership is judged against the
CURRENT year; a mark is judged against the SHEET's year, because an archived
sheet is scored by whoever held the profile THEN.

### Still open

- **The real action-plan sections still need clinical content.** A category
  holder can create the first linked section in „Подесувања", choose its scale
  before any mark exists, and add goals in „Проценка". The application does
  not seed or invent those goals.
- **Real people still need annual category assignments.** Until they are set in
  `Podatoci.html`, pupils correctly derive empty action plans. A therapist's
  category reaches a pupil through the caseload; a teacher's reaches them
  through the class.

## Неутрална состојба во евидентниот лист

Одлучено, не изградено. Одлуките се тука за да не се преиспитуваат од почеток.

**Проблемот.** Денес три различни факти паѓаат во иста празна ќелија: не е
оценето уште; оценето и детето не постигнува (1); и не се однесува на ова дете.
Спојувањето на второто и третото е штетното — цел што никогаш не била за детето
изгледа како цел што детето ја паднало, и таа единица влегува во ОПШТА ПРОЦЕНКА,
зашто `level` секциите се просечуваат. Тоа излегува во извештај со потпис.

**ЕДНА неутрална состојба, не две.** Предложени беа две — „не се однесува"
(утврдено) и „сè уште не се проценува" (прерано). Втората дуплира нешто што
записот веќе го кажува: празна ќелија ВЕЌЕ значи „не уште". Значи трите значења
добиваат три претстави и ниту една не се преклопува:

| празно | не е оценето уште |
| неутрално | утврдено дека не се однесува на ова дете |
| 1 · 2 · 3 | оценето |

Тоа е најмалото полно множество. Ако работата покаже дека треба и „гледавме и не
можеме да утврдиме", тоа е четврто нешто и само ќе се јави — истото правило како
за `(под.)`.

**Се брои како ПОПОЛНЕТА, но НЕ влегува во просекот.** Направена е проценка, таа
има автор и датум во `evidence_scores`; тоа не е пропуст. Бројачот постои за да
каже „дали овој лист е завршен", а лист во кој секоја ќелија е или оценета или
свесно обележана Е завршен. Ако неутралното не се брои, бројачот вечно ќе кука за
ќелии што никој нема да ги пополни — а показател што сите го игнорираат е полош
од никаков.

Но во ОПШТА ПРОЦЕНКА не влегува. Таа е аритметика над постигнување, а „не се
однесува" не е ниско постигнување.

**ОБЕЛЕЖИ, НЕ КРИЈ — на ниво на ставка.** Обележаното носи автор; скриеното не
остава трага дека воопшто било одлучувано. Формата останува иста за сите, па два
листа може да се споредат и надворешен читател гледа дека образецот е ист а
одговорот различен. А кај кандидат за упис, „дали оваа цел се однесува" е токму
тоа што се утврдува — мора да е прашање на кое се одговара, не прашање што го
нема.

**Секцијата се изведува, ставката се обележува.** Секциите на акцискиот план веќе
се појавуваат само за категориите што го земаат детето — таму криењето е точно,
зашто цела област не е за него. Внатре во секција што Е за него, ставката стои и
добива одговор.

**Што е потребно во кодот.** За `mark` серверот веќе дозволува три симбола
(`['√','X','/']`), а интерфејсот нуди два — третиот само не е ставен во менито.
За `level` нема ништо, а тоа е скалата што се просечува.

## Записот и извештајот

Stated by the owner on 2 Sep 2026, and it governs more than the screen it came
from: **the documents are INTERNAL records. Reports for other institutions,
with signatures, are GENERATED from them.** For now everything here is the
centre's own record-keeping, for its own work.

Three rules follow, and they decide arguments that otherwise get decided by
whoever is typing.

**A field exists only if somebody has the data.** Not "the form has a column
for it" — somebody, named, who maintains it. A therapist has no phone number
in this schema; adding the column so the евидентен лист can print one would
produce a column that is empty for ever and therefore lies. Phone and e-mail
belong to the printed FORM, and the record leaves them blank until the centre
decides to own them.

**Nothing already in the database is copied into a record.** The therapists who
work with a pupil are `therapist_students`; the record derives them and does
not store its own list, because a stored copy goes stale the moment the
caseload changes and then two places disagree about who works with the child.
A manual row exists only for a person the database does not know — a
paediatrician, an audiologist from the clinic, somebody the parents brought.
That is the first rule applied: a hand-typed field is for a fact with no other
home.

**A report freezes; a record does not.** Generating an outward report takes the
derived people, the manual ones, the place, the date and the signatures, and
fixes them at that moment. The frozen thing is the report. The record carries
on changing, and that is not a contradiction — the report says what was true
when it was issued, which is exactly what a signature means.

The consequence worth designing for before it is needed: once reports leave the
building, somebody will eventually have to say WHICH report went WHERE and
WHEN. Nothing needs that today. But a report that is an event rather than a
print button costs nothing now and cannot be retrofitted cheaply — the same
shape of mistake as writing a fact globally and discovering it was annual.

Where the current code does not yet follow this: `evidence_sheets` carries
„Место и датум" and the examiner rows, which are report metadata sitting in a
record, and `evidence_contacts` stores people the database already knows. Both
predate the principle. Nothing has to move today; new work goes on the right
side of the line.


### Тестовите не беа типизирани

`tsconfig.json` has `"include": ["src"]`, so `tsc --noEmit` checked the server
and NOTHING in `test/`. The suites are TypeScript, run through `tsx`, and a
typo in one was only ever found by running it against a live server and a live
database — which is the slowest and least specific way to learn about a missing
comma.

This was found by accident and in the worst way: a SQL comment was pasted into
a `.ts` test file, `tsc` reported success, and only reading the file showed
that `-- cascades logins and sessions` was sitting in the middle of TypeScript.
A green check that checks nothing is worse than no check, because it is
believed.

`npm run typecheck` (`tsconfig.test.json`, which extends the main config with
`include: ["src", "test"]` and `noEmit`) closes it. It found eight real errors
on the first run, all in `projection.test.ts`, all `pool` possibly null — the
file already threw the same sentence in two places and reached `pool` directly
everywhere else. It has one `db()` accessor now, which is both the fix and the
honest version: a test that runs before `before()` should say so rather than
dereference null.

Run it before pushing anything that touches a suite.

## Кратенките во името, и што намерно не е решено

The owner writes a marker after some pupils' names -- `(над.)` for надворешен,
`(под.)` for подготвително -- and reads a list of eighty by it at a glance. Keep
it. `scripts/roster-2026-2027.ps1` matches without it and puts it back, and adds
it to any external that lacks it.

It is a duplicate of `student_enrollments.kind` and everybody involved knows it.
Change the kind and the name goes on saying otherwise. The clean form derives the
marker from the data when a list is drawn.

WHAT `(под.)` ACTUALLY IS, in the owner's words: not internal, candidates for
enrolment, closer to the externals than to anything else, and a child can be both
at once. That last part is the whole argument -- if one child is external AND a
candidate, those are two facts, not two values of one field. So a fourth `kind`
would be the wrong shape; an annual flag beside `kind` would be the right one,
annual for the same reason `kind` is: the status changes with the year and an
archived plan must keep saying what was true then. Which marker wins on screen is
then a display decision, changed in one line, losing nothing.

AND IT IS DELIBERATELY NOT BUILT. Asked directly, the owner said he does not know
yet and that the conflicts will show up in the work. That is a decision, not an
omission: the roster is being entered for a real year right now, and a model
invented ahead of the use it is meant to serve is how a field ends up holding
something it was not shaped for. Do not add a `candidate` column, a fourth kind,
or a derived marker until real use has produced the conflict. Write down what the
conflict was when it does.

ONE THING TO CHECK WHEN IT DOES. Some pupils are enrolled with the GRADE
`подготвителна`. Others carry `(под.)` in the name and have no grade at all.
If those are two different statuses, fine. If they are one status recorded two
ways, that is the thing to unify, and it is the same shape as every other drift
this project has found. Inspect the local database for examples; identities do
not belong in this file.

## Conventions

App code and UI text are Macedonian; server code and comments are English.
Comments explain *why*, not *what*. Scripts are dry-run by default and need
`--apply` to write.

**`AGENTS.md` and `CLAUDE.md` are the same file under two names**, because
different tools look for different ones and this is one shared memory. Write
the change into one and copy it over the other in the same commit; they have
already drifted once, and a memory that disagrees with itself is worse than a
short one.

## State (5 Sep 2026)

Branch `kolegi-pristap` now carries the complete opt-in colleague boundary and
the browser work that uses it. It is not active merely because the code is
pulled: every helper remains compatibility-open until
`MTB_REQUIRE_SIGNIN=1` and a server restart.

`lib/colleague.ts` is the ONE permission owner. A root `onRequest` hook
default-denies every mutating route not deliberately delegated, including
future routes. A therapist may change only their own annual caseload, canonical
schedule blocks/sessions and evidence for pupils in that caseload. A teacher's
evidence pupils come from their assigned annual classes. Action-catalogue
content belongs to its annual category holder; prescribed-catalogue structure,
year columns, the roster and other system writes are administrator-only.
`MTB_ADMIN` is kind-qualified (`therapist:name` / `teacher:name`), and a random
`MTB_SERVICE_KEY` of at least 32 characters lets local maintenance/sync cross
the boundary without storing a human PIN in automation.

Reads are intentionally split. Shared schedule, conflicts, roster and login
directory remain open to anyone who can reach the API, because hiding another
cabinet makes its conflict unactionable. Evidence sheet lists, direct sheet
reads and sheet-derived writes are scoped to the therapist's annual caseload or
teacher's annual class when enforcement is on. This is operational integrity,
not confidentiality: the exact four-digit PIN is low-entropy, five wrong
guesses lock that identity for five minutes, and Tailscale remains the network
boundary. With enforcement on, first-PIN setup is administrator/service-only;
a person signs in before changing their own PIN.

`app-navigation.js` attaches the shared session only to the selected MTB server
and revokes it on logout. Fusion now has the editable caseload checklist,
locks therapists to their own stable id, uses only those pupils in their
dropdown and refreshes colleague changes about every 20 seconds without
clobbering an active editor or queued write. AkciskiPlan now has exact grade-band
filters, keyboard score entry, one-second independent autosave with sheet-bound
stale-response protection and a direct schedule link.

The local server no longer exposes the repository tree. An explicit static
allowlist serves the application shell and refuses `.env`, `.git`, migrations,
scripts, docs, backups, local roster files and unknown paths.

No SQL migration was added for this hardening; it uses migrations 019, 022, 024
and 025. HOME already had 001–026 and the repository installer applied only
`027_schedule_source_default_api.sql`, leaving application-table counts
unchanged. Final verification is green: typecheck, 90/90 unit/contract tests,
all evidence/category/Fusion API suites, all 38 colleague-boundary checks and
the Fusion, evidence and shared-navigation browser suites. Before/after counts
match exactly, the live static smoke test keeps private paths at 404, and the
expanded name guard found no local database name in this branch's commit
candidates.

The privacy-blocking history rewrite is complete. The rewritten `main`, the
rollout branch and HOME's clone pass both the commit-candidate and reachable-
history name guards, and the rollout was merged into `main`. GitHub Support cleanup
of two read-only closed-PR refs remains operational follow-up; it does not
require changing either branch again. Do not identify the removed commits in
public documentation, and do not use WORK's pre-rewrite clone.

This remains one shared sign-in across the existing tools, NOT one merged app.
`docs/PLAN-kolegi-pristap.md` is the exact activation, rollback, migration and
verification handover. Евидентен лист stays in AkciskiPlan.

## State (2 Sep 2026)

`AkciskiPlan.html` draws both catalogues: a Документ switch in „Проценка",
a per-category panel showing which sections are on and whether that came from
the annual lists or from a person, and printing that never mixes them.
`printOne` follows the switch, `printAll` is always the prescribed form, and
the action-plan document never appends diagnosis, sensory panels or contacts.
With the category routes absent, the prescribed form still loads unchanged.

`RasporediFusion.html` carries the S-Dnevnik schedule look: the grid CSS ported
verbatim, the native select painted as a `.student-slot` with a 40′ / 1/2 / 2/2
badge, light and dark sharing S-Dnevnik's `theme` key, a clean print sheet and
a JPG export drawn onto a canvas the way the Аудиограми sheet is drawn. Slots
fill their block. Verified in a real browser against a stubbed API — day and
week views, the roster tab, print and JPG all render with no console errors.

Migration 023 introduced the second catalogue as cabinets. Migration 024
superseded that vocabulary and schema with `specialist_categories`, annual
`category_id` on both therapist and teacher memberships, and the `/api/categories`
routes. Migration 025 completed teacher sign-in. Do not rebuild the superseded
`lib/cabinets.ts`, `/api/cabinets/*` or a Кабинет column from this historical
entry. The current checks are `npm run test:evidence`, `npm run test:categories`
and `npm run test:evidence-ui`; all three exercise the PostgreSQL-backed paths.

## State (1 Sep 2026)

The user chose two independent databases with manual sync, matching the old
JSON export/import working habit. This replaces the planned automatic full-DB
handoff before ZenPC1 was seeded. Do not install `-FullDbHandoff` or the old
automatic `sync-peer` tasks on either current PC.

`scripts/manual-db-sync.ps1` exports an immutable per-machine pCloud snapshot:
a verified custom PostgreSQL dump, both legacy JSON exports, SHA-256 values,
logical table fingerprints and the exact migration list. `Compare` is read-only.
`LegacyPreview` is the old importer dry run. `LegacyImport` can accept
Rasporedi, S-Dnevnik or both. `Accept` replaces the complete DB. Both write
modes require `-Apply`, an exact current snapshot id and a local safety dump;
full restore verifies its fingerprint and rolls back on failure.

Install with `scripts/install-scheduled-tasks.ps1 -ManualDbSync`. Startup still
does a best-effort clean-tree `git pull --ff-only`, but explicitly skips all DB
handoff. `TherapyBackupWeekly` keeps the local Sunday backup and
`TherapyDbSnapshotWeekly` exports this machine's independent pCloud snapshot 30
minutes later. The menu shortcut comes from `create-shortcuts.ps1 -ManualSync`.
See `docs/MANUAL-DB-SYNC.md`.

Both logical roles have produced verified pCloud snapshots. Snapshot ids and
which machine is currently newer are runtime facts; inspect the sync dashboard
instead of recording them in source control.

Every connected screen now carries one shared, always-visible status bar with
TWO independent signals: `БАЗА` names the configured `РАБОТА` or `ДОМА` role,
while `ПОДАТОЦИ` says saving, server-confirmed, local-and-waiting, conflict or
error. `/api/health` gets the stable installation identity from
`MTB_SERVER_ID` plus `MANUAL_SYNC_NAME`/`SYNC_NAME`; hostname is display text,
never a fallback for deciding the role,
it is deliberately outside PostgreSQL so accepting a peer's complete dump
cannot rename this machine. Missing role configuration is a health warning.
This matters because both Windows installations may report the same `ZenPC`
hostname.

Direct DB screens (`RasporediFusion`, `Podatoci`, `NastavaUredi`) keep their
per-cell/per-form Save controls and report success only after the endpoint
accepts the write; do not add a second whole-page Submit. S-Dnevnik remains
local-first: local save is immediate, `sdn_local_server_pending_v1` survives a
reload, and only a confirmed push/pull clears it. A server-origin page is pinned
to `window.location.origin`; a stale saved URL is not allowed to make one
machine write to its peer. See `docs/MANUAL-DB-SYNC.md` for the daily workflow.

## State (31 Aug 2026)

**The two machines, plainly, because every command in this file assumes one.**
zenpc-1 has the repo at `C:\Users\Admin\Documents\GitHub\MTB`; zenpc has it
at `C:\Users\Admin\Documents\My Web Sites\Edu_Hub\MTB` — a path with a
space in it. **Both databases are named `therapy_dev`**, not `therapy`, so a
migration command written as `-d therapy` is wrong on both. The safe form reads
the connection string out of `.env`:

```powershell
$psql = (Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" | Select-Object -Last 1).FullName
$url  = ((Get-Content server\.env | Select-String '^DATABASE_URL=') -replace '^DATABASE_URL=','')
& $psql $url -c "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 3"
```

**The two databases have genuinely diverged, and neither is a superset.**
Measured from the two backups taken the same morning: students, therapists,
plans, attendance dates, assessments and triage are identical, but zenpc holds
**58 terms and a 5-day weekly plan** where zenpc-1 holds **0 of each**, and
zenpc-1 holds **16 audiograms and 113 history snapshots** where zenpc holds
**0 and 44**. So zenpc is where the new year's schedule was built and zenpc-1
is where S-Dnevnik has been saved. This is exactly the both-sides-changed case
`sync-peer` refuses on principle — forcing it either way destroys real work.
Unresolved; it needs a person to decide, not code.

(That also answers the audiogram question: migration 013 emptied the table
expecting the next save to restore them with content-derived ids. On zenpc-1 a
save has happened and there are 16; on zenpc it has not and the export — which
reads the TABLES — carries none.)

**A schema cutover was attempted and did not survive.** A long session moved
`student_enrollments.grade` to a `class_id` foreign key and dropped the scalar
columns: 28 files, +995/-314, including a `schema-upgrade.test.ts`. None of it
reached either machine's working tree, any branch, any stash, or `git fsck`
beyond two dangling commits. Both databases were checked and are clean —
`student_enrollments` is still `student_id, school_year_id, grade, active,
kind`, migrations top out at 021, no `class_id` anywhere.

Worth knowing WHY it cost a whole session, because the next attempt should not:
dropping `grade` in the same change forces nine readers to move at once
(`import-core`, `year-rollover`, `annual-roster`, `data`, `roster-purge`,
`roster-write`, `teaching`, `import-roster`, the export), so nothing passes
until everything does and there is no point at which a piece is finished. The
shape that works is expand → backfill → move readers one file per patch →
contract, each step green and revertible. And the target is one step further
out than that cutover assumed — see the годишна програма section: a class must
be able to be комбинирана before any of this can hold 2026/2027.

## State (29 Aug 2026)

Migration 018 makes teachers, therapists and classes annual memberships;
students already had the same fact in `student_enrollments.active`. A new year
created from `Podatoci.html` now starts with four blank working lists and offers
the previous directory as reviewed suggestions, including the student's
proposed next grade. Removing an entry from one year never deletes the person
or archived history. Global student retirement and restoration still belongs
to S-Dnevnik; annual operational inclusion belongs to Podatoci.

Every operational read path now filters through the selected year's active
memberships: Rasporedi hydration, schedule writes, teaching grids/crossing,
stats and Podatoci itself. A stale whole-document save cannot silently reactivate
someone removed from the year. Copying a teaching timetable activates the
classes and teachers it proves are present in the target year.

The current 2026/2027 data was preserved by the migration: 82 students, 10
therapists, 21 teachers and 18 classes. `test:annual-roster`, `test:podatoci`,
`test:hydrate`, the roster/teaching API suites and all teaching/navigation
browser suites cover the change.

Later the same day, the narrow other half: `routes/roster-purge.ts` removes a
row that should never have existed — a name typed by mistake, in ONE named
year, while nothing points at it and it has never been on another year's list.
See „Бришење" means two things above for why that is a separate endpoint at a
separate address from taking somebody off the year, why a year and an
`expected` name are both required, and why the blocker list is checked against
`pg_constraint` rather than trusted.

`test:purge` is 80 assertions, and every guard was checked to FAIL first:
dropping the other-years refusal deletes people who were on last year's list
and takes their archived membership with them (11 assertions break), dropping
`expected` deletes a name somebody had just corrected (3), dropping the
`LOCK TABLE` loses a child typed into a class while it is being counted (4),
dropping `FOR UPDATE` loses a term booked mid-count behind a 200 (4), not
counting `students.grade` or comparing labels with `=` instead of
`normalizeClassLabel` deletes a class out from under the children in it (3
each), dropping the archived/`sdnevnik_id` refusals removes a child S-Dnevnik
owns (3), removing one table from the blocker list deletes a class and cascades
its lesson away (9), and the deeper drift walk was proven by pointing a
throwaway table at `student_enrollments` and watching the suite refuse.

Not built here, and deliberately: the button for the removal itself.
`Podatoci.html` offers „Тргни од 2026/2027" as the ordinary action — the year
is IN the label now, because that button is the one place a person is told
which list they are taking somebody off, and „од годината" reads the same on
every year and next to an endpoint that really does delete. When the removal
gets a button it will say „Избриши" and stand apart, and the 409 already
answers with the years, the counts and the sentence to show.

Two smaller things from the same screen: the name column now asks for 240px,
because the class prefix embedded in the real roster („V-б - Јована …") made
every name longer than the space the therapist chips left it, and the table
already scrolls sideways — better a scrollbar than a name nobody can read. And
`test/teaching.e2e.ts` had no npm script, so nobody had run it since migration
018 made the crossing filter on `therapist_years`; its fixture created
therapists with no membership row and eight assertions had been failing
silently. It is `npm run test:teaching` now.

## State (28 Aug 2026)

The timetable is editable through the year, and September starts from last year
rather than from blank. `NastavaUredi.html` writes one cell at a time through
`routes/teaching-edit.ts`; `npm run copy:teaching -- --from 2025/2026` (or the
button in the page) carries a whole year across, dry-run first, refusing to
write over a populated year unless told twice. 101 new assertions, no new
migration — migration 015 had already made lessons per-year, which is the only
reason "copy last year, then correct" is expressible at all.

`Nastava.html` is unchanged and still writes nothing. `GET /api/teaching/timetable`
grew ids on its rows (the editor has to address a row, not describe it), which
is additive.

**The September order gained a step** — see `docs/SCHOOL-YEAR.md`: copy the
timetable after the calendar and before building the new week, so the crossing
has something to cross against from the first day.

Later the same day, the other half: **the lists became editable too.**
`Podatoci.html` and migration 016 (`teacher_classes`), because the teaching side
was fully editable while a student's class — the one field the whole crossing
depends on — could only be reached through a flag that is off. A teacher can now
hold several classes and they belong to a year, which is what комбинирани
паралелки and subject teaching have always needed and one column could never
say. `DELETE /api/teaching/year-lessons` empties a year on purpose, guarded by
the count the caller believes it is throwing away, because September starts from
nothing when the mapping has changed enough.

And migration 017: a student's enrolment carries `internal` / `boarding` /
`external`, so the twenty-odd external children stop being reported as classes
somebody forgot to type in. `setup-home-postgres.ps1` no longer asks for the
`postgres` password when the role and the database are already there.

Tests: 97 in `teaching-edit.e2e.ts`, 27 in `podatoci.browser.mjs`, and every
guard was checked to FAIL first — removing the year from the student write
breaks two assertions, removing the class pre-check two more, and removing the
external split five.

**And the roster changed owner.** `Podatoci.html` writes it, so a whole-document
save may no longer restate a name, a class or a caseload — see the section above.
Practically: add a student in Rasporedi and they reach the database; rename one
there and they do not. Renaming happens in „Податоци" now.

Still open, and now with somewhere to fix it: the class is embedded in student
NAMES in the real roster ("V-а - Бојана Пробена") rather than in the enrolment,
which is what leaves most therapy sessions unattached to a lesson. That is data
entry in `Podatoci.html` rather than code — and the external children are no
longer part of that number. Also open: whether the cabinet really
rings at 08:00 while the school rings at 07:30 — the bell table is editable from
`NastavaUredi.html`, so that is a decision and two clicks. And the lesson model
above, which is agreed but not built.

## State (27 Aug 2026)

The crossing landed as `Nastava.html` — a page that answers the teachers'
question: how many children are out of this class in this lesson, and with whom.
Migration 014, an importer for the school's workbook, a read-only API and 61 new
assertions. `Rasporedi.html` is not touched at all; the page reads and writes
nothing.

Two faults fixed on the way, both able to cost real data or real trust:
`PUT /api/state/:app` projected any payload into the shared tables regardless of
which app sent it, and the ordinal crossing named the wrong lesson.

**Open, and it needs a decision rather than code:** does the cabinet really ring
at 08:00 while the school rings at 07:30? Everything works either way — the
overlap is computed from the bell table — but if the two are meant to be the
same, edit `bell_periods` for `kabinet` to 07:30/08:15/… and every session then
maps to exactly one lesson instead of straddling two.

Also open: the class is embedded in student NAMES in the real roster
("V-а - Бојана Пробена") rather than in `students.grade`. That is what leaves
most therapy sessions unattached to a lesson.

## State (25 Aug 2026)

Stages D, E and F done and dormant. S-Dnevnik writes attendance one mark at a
time, its weekly plan one slot at a time, and the five clinical collections one
record at a time; plan progress is derived from attendance rather than stored
twice; the September year-end asks the server before emptying the week, and is
refused while the database is still in the year being closed. Migration 012 adds
`attendance.time_slot` and backfills it from the blob; migration 013 gives
audiograms a content-derived id, which is what ends the delete-everything-and-
re-insert projection they had. Not deployed — `SDiary.enable()` is off, like
`RSlots`, until September.

Only `plans` and `links` are still document-only. Everything else in the diary
now has a row of its own.

**Next, in order:** roll the database over (`npm run rollover -- --to 2026/2027`),
close the year in S-Dnevnik, enter the new calendar, build the new week — then
turn the flags on. The week is the right thing to have moved last: it is emptied
and rebuilt from scratch in September anyway, so nothing had to be migrated.

Found and fixed along the way, all independent of the flag: the progression
projection could only grow, `npm run export` dropped the attendance time, and
CORS did not list the methods the roster endpoints have used since Stage B.
Found and NOT fixed: the setup scripts do not pin a database collation, so a new
machine can get one that cannot lower-case Cyrillic (see the traps above).

Tests: 23 unit, roster e2e + 3 browser suites as before, plus 104 server and 65
browser assertions for Stages D, E and F, and 14 more in
`test/rslots-recovery.browser.mjs` for the three Rasporedi faults below.

Five faults were found by review on 25 Aug and fixed the same day — the
`sdnevnik_id` one had already broken a real machine's projection. Each has a
regression test that was checked to FAIL against the old code first; a test that
passes either way proves nothing. See the traps section.

## State (21 Aug 2026)

Plan stages 0–9 complete: local PostgreSQL, API, blob sync in both apps,
identity reconciliation, full relational model, school years with rollover,
verified backups, Tailscale access. Supabase sync was removed.

Since then: a school-year transition in S-Dnevnik (archive, progress reset with
history, editable calendar), automatic sync in both apps (one „🔄 Синхронизирај" button, on open
and after edits), `sync-peer` between the work and home databases, migration 010
(`sync_watermark`), and scheduled tasks for the server, a weekly backup and the
peer sync. Verified against a real database with a headless browser: 20 unit
tests, plus 20 end-to-end assertions covering fresh device, edit propagation both
ways, refused divergence, and invalid local state.

Real data loaded: 82 students, 10 therapists, 436 terms, 919 attendance
marks, 16 dossiers, 48 assessments, 21 triage tests, 16 audiograms.

Open, needing a human rather than code: 6 double-booked terms, 10 students
with no term, the 2026/2027 rollover, and the `postgres` superuser password
still being `qwerty`.

See `docs/STATUS-2026-08-19.md` and, for the original plan,
`LEGACY RASPOREDI I SDNEVNIK/therapy_app_postgres_local_plan_v2.md`.

## File names

The two apps are `Rasporedi.html` and `S-Dnevnik.html`. They were renamed from
`Rasporedi-Unified-Sync-v5.0.html` and `S-Dnevnik-Unified-Sync-v4.html`,
and **redirect pages still sit at the old names** so bookmarks and any link a
colleague was given keep working. Do not delete those two stubs, and do not put
real content back at those paths.

Browser storage is per origin, not per path, so the rename cost nobody their
data. That also means renaming again is cheap — but every rename adds another
stub to keep forever, so don't.

**The launcher hides them rather than the disk losing them.** `index.html`
(EduHub) discovers apps by listing the repository over the GitHub API, so every
root `.html` appeared in it — the two stubs next to the apps they redirect to,
and `Dnevnik-Rasporedi-SafeSync.html` / `РаспоредТерапевти.html`, the
previous generation of the same two apps, which are kept because they still
read old exports. Four ways to open last year's software by accident. They are
listed in `NOT_APPS` in `index.html` and left out of the grid; a search by name
still finds them, and nothing is deleted from anyone's saved list. Renaming or
deleting the files instead would break the bookmarks the stubs exist to serve.

`FILE_MAPPINGS` in the same file gives each real page its Macedonian name and
icon. It is applied to entries that were ALREADY scanned as well as new ones —
but only while they still carry the name the scanner made up from the filename.
A name typed by a person wins, or every scan would undo the renaming somebody
did on purpose.

## Which address people open

Per origin, not per path — so `https://assisstant.github.io/MTB/S-Dnevnik.html`
and `https://zenpc-1.tail….ts.net/S-Dnevnik.html` are two unrelated copies with
separate storage. Worse, the GitHub Pages one has auto-sync **off**: the apps
enable it only when `servedByApi()` sees a `localhost` or `.ts.net` hostname, so
that copy silently works offline forever and shows a calendar computed from
defaults, which looks convincing.

`start.html` exists to stop that. It is bookmarked on GitHub Pages (stable, works
anywhere), probes every known server's `/api/health` in parallel with an abort
timeout, and redirects to whichever answers. `#s-dnevnik` on the end skips the
picker.

The reason it redirects rather than teaching the apps to hunt for a server: one
browser copy talking to two databases on alternate days is the exact input that
produces „и двете страни се сменија" standoffs. Landing on the tailnet address
keeps each origin a clean cache of one server, and `sync-peer` keeps the two
servers in step. Do not "simplify" this by adding server discovery inside the
apps.
