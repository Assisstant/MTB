# MTB — therapy apps for ОУРЦ „Кочо Рацин", Битола

**Read [`SOSTOJBA.md`](SOSTOJBA.md) before this file.** It is short and it says
where the work actually stands — what is open, what happened last, which
machine you are on. This file holds the rules, the layout, the commands and
the traps that have already been paid for. The WHY behind each feature — the
long per-feature sections and the dated State notes — moved unchanged to
[`docs/HISTORY.md`](docs/HISTORY.md) on 23 Sep 2026, because this file had
grown past what an agent loads whole. Consult it before changing a feature;
add new feature history there, and keep this file short enough to be read in
full.

This file is the shared memory between machines: sessions on other
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

The owner's 8 September clarification is recorded in the contract's domain
section. Read it before the historical notes below: external pupils can attend
local preparatory/modified teaching; programmes, boarding and recommendations
are distinct facts; not every professional associate provides treatments;
simultaneous groups are distinct from consecutive 20-minute sessions. Preserve
the tested personal S-Dnevnik. The shared annual list is administered in
Podatoci; the diary archive's remaining global-retirement coupling is a known
integration gap, not authority to make the personal diary the school register.
README.md is the short user-facing map; this file is technical history.

Current private-access and two-PC work is tracked in
[`docs/PLAN-private-mtb.md`](docs/PLAN-private-mtb.md). The user confirmed that
both installations must work offline and colleagues normally share WORK during
the shift; preserve the manual handover. Physical location does not change an
installation's `SYNC_NAME`. On 7 September HOME was healthy and populated,
while WORK's live reinstall remained unverified. The old automatic legacy
import tasks on HOME were disabled with their definitions preserved locally;
do not re-enable them as a substitute for verified manual snapshot acceptance.

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
| `Kolega.html` | the colleagues' door: sign in with your own name, your own week — the one page the cloud shows without the owner's Google sign-in |
| `start.html` | launcher: finds whichever machine is on, sends you to it |
| `Sinhronizacija.html` | where the data stands: this browser's diary ↔ its server, WORK ↔ HOME, the cloud — reads, never syncs |
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

**Direction chosen 23 Sep 2026: the cloud becomes the source of truth.** The
owner decided that daily work is written in Supabase (the Render app) and that
each PC may also hold a read-only `*_mirror` copy (`docs/SUPABASE-MIRROR.md`).
Refined the same day: the local `therapy_dev` is NOT made read-only — it stays
a writable fallback mode, chosen by which address is opened. Work entered
locally is never sent to the cloud automatically; it is re-entered there by
hand, so local mode is for a reason (no Internet), not a daily alternative.
Nothing has been converted yet: every rollout step needs its own approval, and until a PC's mirror is live
the manual sync below still describes how it works. Never build two-way sync
toward the cloud — local numeric ids collide. See `docs/APP-CONTRACT.md`.

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
5. **One owner per fact.** The shared annual school/service list is administered
   in Podatoci; the therapist's annual caseload is a separate relationship;
   the personal diary owns its records. Legacy S-Dnevnik archives still project
   global retirement into the database. Preserve that compatibility until a
   reviewed change separates personal archival from shared eligibility; do not
   claim it is the intended school-enrolment owner. Before adding a field, name
   its owner and account for the existing writer.
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
server/src/routes/sync-status.ts     read-only: the sync manifests, migrations, last backup; exports and accepts nothing
server/src/routes/form-replies.ts    the review queue for offline form answers: stored first, the administrator decides
server/src/routes/portal.ts          the colleagues' door (/api/portal/*): every route checks its own session
server/src/lib/staff-accounts.ts     the username is the person's name in either script; the initial password; sessions
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
docs/HISTORY.md                 why each feature is built the way it is, and the dated State notes
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
                                be asked. The document-overwrite guard is implemented;
                                see the dated status before reopening the remaining proposals.
docs/HANDOVER-03-09-2026.md     what each database was on 3 Sep, and the twelve assertions
                                the evidence audit left failing
docs/HANDOVER-07-09-2026.md     sanitized HOME→WORK technical steps; names stay local
docs/PONEDELNIK-PCW.md          putting the current main into service on PCW:
                                migrations 028-032 with the pre-check that says
                                whether 028 will pass BEFORE the installer runs,
                                restart, and what each failure actually means
docs/PLAN-rabotna-konzola.md    what can still be plugged into MTB-Workspace to make
                                it the one console, in order of usefulness — and the
                                short list of CRUD that must never be added there
docs/PLAN-kolegi-online.md      colleagues online: an account per employee, a personal form,
                                clashes that reach the other person (owner, 25 Sep 2026)
docs/PLAN-formulari.md          offline forms for colleagues (кабинет, одделение) and the
                                review queue their answers wait in before anything is written;
                                the forms are mtb-schedule-form.js and mtb-class-form.js (class + teacher);
                                clean answers are written on import in the sender's name
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
npm run import:cabinets -- <x.xlsx>  the CENTRE's own cabinet timetable; dry run
                                     --map <file.json> says which column is whose
                                     --names <file.json> ties a spelling to a pupil, once
                                     --caseload also links pupil↔therapist
npm run test:cabinets                that importer against the database, needs the server
npm run import:roster -- <list.docx> --year 2025/2026   the school's pupil list; dry run
npm run check:lists -- --staff <a.docx> --programme <b.docx>   read-only, no --apply
npm run check:names                  refuses if a real name is in a tracked file
npm run check:consistency            is it one system? read-only, no --apply
                                     --mask hides the names, --year picks a year
npm run copy:teaching -- --from 2025/2026   last year's timetable as this year's start; dry run
npm run demo:teaching                a GENERATED demo timetable, so the screens have
                                     something to show; dry run, add --apply
                                     --plan "Оштетен слух" picks another teaching plan
npm run timetable:snapshot           save a year's lessons to backups/ before the demo
npm run timetable:list               what has been saved
npm run timetable:restore            put the same timetable back; dry run, add --apply
npm run test:crossing                the overlap model and the workbook parser (no server needed)
npm run test:teaching-edit           editing the timetable, needs the server running
npm run test:uredi                   NastavaUredi.html in a browser, needs the server running
npm run test:podatoci                Podatoci.html in a browser, needs the server running
npm run test:forms                   the one pupil form (`mtb-forms.js`, ✏️) in a browser, needs the server
npm run test:order                   the order a year’s four lists are read in, needs the server
npm run test:purge                   the typo delete, including the concurrent booking
npm run test:evidence                евидентен лист against the database, needs the server running
npm run test:evidence-ui             the same page in a browser, two therapists at once
npm run test:sync-page               Sinhronizacija.html in a browser; serves itself, every API call invented
npm run test:form-replies            the form review queue, in-process with its own MTB_ADMIN, invented year
npm run test:forms-queue             Податоци → Формулари in a browser; every API call invented
npm run test:one-change              a write in one window reaches every other one; every API call invented
npm run test:class-cards             a class reads the same in every picker, whole row on hover; every API call invented
npm run test:back-forward            Back/Forward walk tabs, views and workspace windows; every API call invented
npm run test:portal                  the colleagues' sign-in against the database, in-process, invented year
npm run test:kolega                  Kolega.html in a browser; every API call invented
npm run test:schedule-form           the cabinet form (all therapists) offline, then into the queue
npm run test:class-form              the class form AND the teacher's own week from Уреди настава, offline, then in
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
  and still be enrolled. Global retirement still follows the legacy diary
  archive; shared annual membership is administered separately. So
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

- **A recovery schema name belongs to ONE reviewed batch, and reusing it stops
  the deploy dead.** `workspaceRelease` copies every table into a private
  schema before applying pending migrations, and it `CREATE SCHEMA`s that name
  rather than reusing it — correctly, because a second batch writing into the
  first batch's snapshot destroys the only copy of the state before the first
  upgrade. But the name is a DEFAULT PARAMETER, so a new batch inherits the
  previous one's unless somebody changes it. Render then prints
  `Workspace upgrade refused (42P06); transaction rolled back` and exits 1,
  over and over. `42P06` is duplicate_schema, which reads like a bug in the
  release runner rather than the one-line fix it is. Seen on 22 Sep 2026: 037
  deployed successfully in the morning under
  `mtb_workspace_recovery_staff_20260922`, and 038 was refused that afternoon
  because it was handed the same name. The refusal now names the schema and
  says to give the new batch its own; the test deletes the top ledger row to
  make one pending again and asserts that sentence, checked to fail first.

- **`sync-peer` used to report a failed fetch as a divergence, then recommend
  `--force`.** The loop that runs each app is `try { … } catch { results.push('refused') }`
  — so a network error, a stopped local server or a missing mailbox file all
  land in the SAME bucket as "both sides changed, a human must decide". The
  PowerShell wrapper then prints *"The two machines have diverged… rerun with
  -Force"*, and `--force` exists to override the clock-skew and shrink guards.
  In the one situation where it knows least, it points at the switch that turns
  the protections off. Seen on 31 Aug 2026: both apps answered `fetch failed`
  because the local server was down, and it was reported as a divergence. A
  failure to LOOK is not a disagreement. Fixed on 7 September: operational
  failures are counted separately and exit 1, safety refusals exit 2, and
  failure takes precedence in mixed results. Corrupt or unexpectedly missing
  mailbox files fail visibly. The wrapper no longer offers generic Force
  advice or claims that nothing changed when another app may have synced.
  Offline CLI and Windows PowerShell regression tests cover these outcomes.

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
- **The school calendar is a RULE, not a list, and the server has neither.**
  `S-Dnevnik.html` holds the year's start and end, nine national holidays in a
  `FIXED` array, and hand-entered breaks and activities. The database knows
  none of it. But the list is the smaller half. The rule beside it is
  „Само распуст ја вади неделата од броењето. Празник и активност не." — an
  excursion is a working day, marked differently. That distinction lives in one
  JavaScript function, so anything counting weeks outside S-Dnevnik has no way
  to apply it and will quietly count differently. Two maps of this system in a
  row described it as „34 holidays" and „0 in the database", which is both wrong
  as a number and wrong as the point.
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
- **The scratch-database guard never once fired, and its refusal pointed at the
  real data.** Four browser suites delete `app_state WHERE app = 'sdnevnik'` —
  the diary as the server holds it — and asked one question first: does
  `current_database()` match `/dev|test/`? **Both machines' real database is
  named `therapy_dev`**, which the State (31 Aug) section has said all along.
  So the guard passed on the one database it existed to stop, every time. Its
  refusal then read *"Point DATABASE_URL at therapy_dev"*, and the default
  connection string when `DATABASE_URL` is unset is also `therapy_dev` — so
  running one of these files with no environment at all went straight at the
  live school. In the moment it knew least it named the data it protects, which
  is the `sync-peer --force` mistake in a second place.
  A name cannot answer "is this disposable?", so it asks for INTENT:
  `MTB_SCRATCH_DB=1`. Found because another agent ran seven browser suites
  against the real database on WORK and reported it as routine — it happened to
  run none of these four, which is luck, not a guard. They have no npm script
  either; that is a mitigation, not a boundary, because an agent enumerating
  `test/*.mjs` reaches them by path.
- **A `<button>` does not inherit `color`, and the light theme hid it.** Making
  the pupil chips clickable turned them from `<span>` into `<button>`. `.chip`
  set `background` and `border` and never `color`, so the browser applied its
  own `buttontext` — BLACK. In the light theme black on `#f0edfb` measures
  18:1 and looks deliberate; in the dark theme the name fell to **2.0:1** on
  `#3d3a68` and the owner reported it as „пак темни букви". A visual review of
  the same commit called the screen good, because it was read in light mode.
  Two lessons. Any element that carries text must state its own `color` when
  it also states a `background` — inheritance is not a promise across element
  types. And „is this readable?" is a MEASUREMENT: `podatoci-classes.browser.mjs`
  now computes the WCAG ratio for the chip's name and its `· одд. X` note in
  BOTH themes and fails under 4.5:1, because the eye that looks is usually
  looking at whichever theme it already had open.
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
- **A grandchild `powershell.exe -File` can fail before printing its first
  line, and say nothing about why.** `git-sync.ps1` spawns
  `manual-db-sync.ps1` as a nested process. Run standalone it worked every
  time; run nested from inside `git-sync.ps1` it failed silently and
  immediately — not even its `=== EXPORT ===` header appeared — while the
  identical command, identical arguments, identical working directory
  succeeded seconds earlier as a single-level call. The difference was depth:
  a host with no real console of its own (which is what any automation tool
  gives a script it runs with redirected/piped stdio) can let ONE nested
  `powershell.exe -File` child through, because it inherits enough to write,
  but a child's OWN Write-Host can still need to query a console device it
  does not actually have, and that query is what breaks — reproducibly, not
  intermittently, once the exact depth and hosting were matched. Redirecting
  the child's streams to a file (`*> $logFile`) needs no console at all; the
  parent — which had a working console throughout every test — reads the
  file back and relays it with its own `Write-Host`. `Invoke-ManualSync` does
  this now. Proven the slow way: a minimal two-file repro (outer calls inner,
  both just `Write-Host`) did NOT reproduce it — the failure needed the real
  script's real nesting depth, so do not trust a simplified repro to clear a
  fix here; instrument the real call.

- **A screen that reads the lists once is a copy, and copies disagree.**
  Every page read its classes, pupils and staff when it opened. The workspace
  keeps five of them open at once — „Администрација", „Заеднички податоци",
  Податоци, Уреди настава, Кабинети — so a class added in one did not exist in
  another's dropdown, and the admin panel's own note told the owner to refresh
  the other windows by hand. Only the ✏️ form told the others, for its own
  saves. The owner (24 Sep 2026): „ако нешто се промени на едно место, треба
  да биде истото и во паѓачкото мени и на другите места". The announcement
  now lives in the ONE place every write passes, the `fetch` wrapper in
  `app-navigation.js`; a screen registers how it re-reads with
  `MTBAppNavigation.onDataChange(reload, { busy, mine, sameWindow, ignore })`.
  Do not move it into save functions — a rule each new screen must remember to
  call is how this happened. `busy` is not optional politeness: a redraw
  under an unsaved row or an open picker is lost work, so the reload waits
  and says why. The workspace shell passes changes on to frames of another
  origin, where the channel does not reach. `test:one-change` removes the
  channel to prove that path.

- **A label stored as text must move with a rename.** Lessons point at a
  class by id; a pupil's class is `student_enrollments.grade` and
  `students.grade`, the LABEL as plain text (roster-purge.ts). Renaming the
  class renamed only the row, so its children held a name no class had: the
  pupil list showed them „— без одделение —", the class showed nobody, and
  „Зачувај" on such a row wrote the blank back. The rename now moves both
  texts in the same transaction, every year, exact match only. Any NEW place
  that stores a class label as text must be added there — or, better, be a
  `class_id`.

- **A class is one sentence, written in one place.** The school knows a class
  by its teacher and by the words of its own table („Комбинирана II, III, IV",
  „ученици со аутизам"), not by the label derived from the timetable — „каде
  учи? — кај наставничката" (owner, 25 Sep 2026). Every class picker writes
  `label · homeroom · class_years.description` and hovers the whole row
  (teacher, words, count by generation, the children), through
  `MTBAppNavigation.classes` (`index`, `text`, `hover`, `optionsHtml`); mark
  the `<select>` `data-class-picker`. The value saved stays the label. Do not
  build class options by hand in a new screen: that is how five pickers
  ended up saying five different things.

- **A view the person chooses is a step in the browser's history.** Tabs,
  views and workspace windows used to change in place, so Back left the
  application (owner, 25 Sep 2026). A screen now declares its view keys with
  `MTBAppNavigation.views({ keys, show })` and calls `step({...})` after a
  change the PERSON made — never on first load or while showing a view that
  Back brought. The keys live in the address, so a reload keeps the view.
  Inside the workspace a frame's steps join the window's history. Playwright's
  `goBack` waits for the top page only, so a test of a frame's step uses
  `history.back()`.

- **The colleagues' door is the only thing the cloud shows without the owner.**
  `cloud-auth.ts` lets through `/Kolega.html`, `/kolegi` and plain
  `/api/portal/<segments>` — after the same-origin checks — and nothing else.
  So every `/api/portal/` route must check its own session first
  (`signed()` in routes/portal.ts) and must answer only what that colleague
  may see: their own week, their own pupils, and for a clash the other name
  and the term. Anything for the administrator goes OUTSIDE `/api/portal/`
  (`/api/staff-accounts`), where the gate still holds. The page is
  self-contained so no other file has to pass. Tokens are hashed at rest and
  travel in a header, never a cookie. The initial password
  (`ResursenCentar`) stays valid until the colleague changes it — the owner's
  decision, made knowing the username is only a name.

## Conventions

App code and UI text are Macedonian; server code and comments are English.
Comments explain *why*, not *what*. Scripts are dry-run by default and need
`--apply` to write.

**`AGENTS.md` and `CLAUDE.md` are the same file under two names**, because
different tools look for different ones and this is one shared memory. Write
the change into one and copy it over the other in the same commit; they have
already drifted once, and a memory that disagrees with itself is worse than a
short one.

## Од каде се работи (9 Sep 2026, одлука на сопственикот)

**Се работи на `main`. Нема гранки за функционалности додека сопственикот не побара
една.** Работата на интегрираниот работен простор и неделниот приказ на наставата е
споена во `main` и `ux/integrated-workspace-v1` е потрошена. Целта е една точка од
која се почнува, без размислување за верзии.

**Состојбата на базата е ПРИФАТЕНА каква што е.** Снимката од 8 септември (27
миграции, `therapy_dev`) е појдовната точка. Сопственикот ја исправал рачно и не
бара повторна проверка сега. **Синхронизацијата ДОМА/РАБОТА е паркирана за време на
оваа работа** — таа создаваше проблеми што не му припаѓаат на проблемот што се
решава, а тоа е UX/UI и функционалноста. Ништо од сето тоа не е откажано: ракачките
и `manual-db-sync.ps1` стојат недопрени. Кога интерфејсот ќе биде на место, тогаш
се враќаме на податоците и на синхронизацијата.

Практично, за агент што чита ова: не предлагај спојување снимки, не предлагај
исправки на податоци и не отворај гранка, освен ако не е побарано.

**Списокот на наставници се читаше од распоредот, не од списокот.** „По
наставник" во `Nastava.html` ги градеше редовите од `cells` — значи од ЧАСОВИТЕ
— па наставник што е на годишниот список, но сè уште нема ниту еден час, воопшто
не се појавуваше. `Podatoci.html` покажуваше 27, оваа страница 21, и разликата
беа точно оние на кои никој уште не им доделил час. Тоа изгледа како изгубени
податоци, а не е.

`/api/teaching/crossing` сега враќа и `teachers` — активниот годишен список — а
`teacherRows()` во страницата ги спојува двете: секој од списокот добива ред
(празен ако нема часови), плус секој што распоредот го именува а не е на
списокот, обележан. Едно место ја прави таа унија, па дневниот и неделниот
приказ не можат да се разидат. Прашањето „кои се луѓето" и прашањето „што е
распоредено" се различни прашања, и читањето на првото од второто е грешката.

**Почетен PIN е `0000`.** Колега што прв пат седнува пред екранот мора да може
да влезе без администратор до себе; „Смени PIN" потоа е обичниот начин да го
направи свој. Првата најава ГО ЗАЧУВУВА, па тоа е стандардна вредност, не
заобиколување — потоа сметката има PIN ред како секоја друга. Одбиено е кога
`MTB_REQUIRE_SIGNIN=1`: таму првиот PIN е администраторски намерно, а јавно
познат почетен PIN би ја претворил целата граница во украс.

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
