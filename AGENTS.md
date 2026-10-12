# MTB — therapy apps for ОУРЦ „Кочо Рацин", Битола

Read [SOSTOJBA.md](SOSTOJBA.md) first: current work, remaining tasks and deployment.
This is the shared entry point for all agents. CLAUDE.md imports this file;
edit the rules here, never maintain a second copy. Do not load the whole archive
or all reference documents at startup: follow the routes below for the task.

The owner's decisions in [docs/APP-CONTRACT.md](docs/APP-CONTRACT.md) are the
product authority. Correct code to match the contract, not the other way round.
Work on `main`; create a branch only when the owner requests one. Do not infer
permission to repair live data, sync databases or deploy from a coding request.
Daily work uses the cloud (owner, 9 Oct); local/offline work is a separate later
project. Preserve the existing local installations without making them default.

This file is the shared memory between machines: sessions on other
PCs have none of the earlier conversation.

Whatever local memory your tool keeps is **per machine** and diverges — one
copy at HOME, another at WORK, and they never meet. This file and `docs/` are
the only memory that crosses. So anything worth remembering goes into a commit,
not into local memory, and where the two disagree **this file wins**. A global
per-machine instructions file (`~/.codex/AGENTS.md` and its equivalents) should
say nothing beyond "follow the repository's AGENTS.md": instructions that
accumulate there ARE the divergence, because only one machine ever sees them.

## Read before changing the relevant area

| Before changing… | Read… |
|---|---|
| UI, navigation, schedules, server selection or sync | [APP-CONTRACT](docs/APP-CONTRACT.md); the matching feature in [HISTORY](docs/HISTORY.md) |
| Schedules and diary/Cabinets agreement | [Schedule/week plan](docs/PLAN-rasporedot-i-nedelata.md), [Conflict rules](docs/PLAN-kabineti-konflikti.md), matching traps below |
| Sync, attendance merging, imports/exports or storage | [SYNC](docs/SYNC.md), [Architecture, and why](docs/AGENT-REFERENCE.md#architecture-and-why), matching traps below |
| Annual lists, pupils, identity or September transitions | APP-CONTRACT domain section, [SCHOOL-YEAR](docs/SCHOOL-YEAR.md), matching traps below |
| Public access, colleagues, authentication or static files | APP-CONTRACT, [Colleagues online](docs/PLAN-kolegi-online.md), security/privacy traps below |
| `vezbi/` or ComuniBoard | [VEZBI](docs/VEZBI.md); it has no pupil data or database |
| WBACC or stamps | [WBACC](docs/PLAN-wbacc.md), [Stamps](docs/PLAN-wbacc-pecati.md), [Content/editor plan](docs/PLAN-sodrzini-karticki-i-planovi.md) |
| Scripts, migrations, backup or deployment | [Operating reference](docs/AGENT-REFERENCE.md), [WORKSPACE-RELEASE](docs/WORKSPACE-RELEASE.md), matching traps below |
| Old decisions or previous machine state | Search [HISTORY](docs/HISTORY.md) and [state archive](docs/SOSTOJBA-archive.md), read only matching sections |

File owners and entry points: [Layout](docs/AGENT-REFERENCE.md#layout).
Commands and test prerequisites: [Commands](docs/AGENT-REFERENCE.md#commands-from-server).
Run relevant checks; database-writing suites use their guarded scratch schema,
never live pupil records. Generated WBACC.html comes only from `wbacc/` build.

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
   **Owner exception, 7 Oct 2026:** a conflicting schedule import is refused
   completely, including roster/document changes. Nonconflicting legacy JSON
   remains accepted; see `docs/PLAN-kabineti-konflikti.md`.
5. **One owner per fact.** The shared annual school/service list is administered
   in Podatoci; the therapist's annual caseload is a separate relationship;
   the personal diary owns its records. Legacy S-Dnevnik archives still project
   global retirement into the database. Preserve that compatibility until a
   reviewed change separates personal archival from shared eligibility; do not
   claim it is the intended school-enrolment owner. Before adding a field, name
   its owner and account for the existing writer.
6. **Real data stays local.** `backups/` is gitignored. Never commit exports,
   dumps or `.env`.

## What this is

One connected set of work screens used daily by a speech therapist, backed by
PostgreSQL; daily use is the cloud, as clarified above.

| File | Purpose |
|---|---|
| `RasporediFusion.html` | canonical DB-first schedule for the therapy cabinets |
| `Rasporedi.html` | legacy JSON compatibility/recovery only; never advertise it as an app |
| `S-Dnevnik.html` | one therapist's diary: attendance, plans, dossiers, assessments, audiograms |
| `Pregled-Baza.html` | read-only overview of the database |
| `Nastava.html` | who is missing from which lesson — reads the server; its unlocked teacher week (🔓) writes lessons; it keeps no data of its own |
| `NastavaUredi.html` | the school timetable, editable cell by cell — writes the server, stores nothing |
| `Podatoci.html` | **„Списоци и пристап“** (named „Податоци“ until 5 Oct 2026; the file keeps its name): the lists a year is made of — students, teachers, therapists, classes — and who gets into Колега how. S-Дневник's own tab of that old name is now „⚙️ Сервер и резерви“. New text names the app „Списоци и пристап“ |
| `AkciskiPlan.html` | евидентен лист: one pupil's development record, filled section by section by the whole team |
| `Kolega.html` | the colleagues' door: sign in with your own name, your own week — the one page the cloud shows without the owner's Google sign-in |
| `vezbi/index.html` | **Вежби за изговор**: articulation exercises, 26 sounds, with ComuniBoard and WBACC Studio in its tabs. No database, no sign-in, nothing about a pupil; shares no code with the records side. Its memory is `docs/VEZBI.md` |
| `start.html` | launcher: finds whichever machine is on, sends you to it |
| `Obelezuvaci.html` | **„Обележувачи“**: the administrator's own links as collections, tags and cards — the one document of 047, also read by WBACC Studio's small panel; opened from the workspace's top bar and the strip of Вежби, never a window of the workspace |
| `Dokazi.html` | **„Докази“**: the administrator's evidence for the title of mentor — each piece of evidence once, tied to the indicators of the standards by links that carry the explanation; the one document of 059. The files stay in a folder on the owner's computer. A separate app: no button in the workspace; the owner keeps its address as a bookmark in Обележувачи |
| `Sinhronizacija.html` | where the data stands: this browser's diary ↔ its server, WORK ↔ HOME, the cloud — reads, never syncs |
| `server/` | Fastify + TypeScript API over PostgreSQL |

Publication/address history is in [Which address people open](docs/AGENT-REFERENCE.md#which-address-people-open);
the later cloud-only daily-use decision above takes precedence.

## Conventions

App code and UI text are Macedonian; server code and comments are English.
Comments explain *why*, not *what*. Scripts are dry-run by default and need
`--apply` to write.

**One word per action** (owner, 4 Oct 2026): + Додај, ✏️ Уреди, Тргни,
Испразни, Избриши, Зачувај / Откажи, Остави засега — each meaning one thing on
every screen. The table is in APP-CONTRACT.md („One word per action");
`ui-verbs.test.ts` refuses the retired „Додади", „Измени", „Отстрани",
„Исчисти" on the live screens.

Owner exception, 8 Oct 2026: the diary/group-schedule comparison uses the full
directions „Измени го распоредот во S-Дневник според групниот распоред“ and
„Измени го групниот распоред според S-Дневник“. No default choice or both-sides
clearing action; „Затвори“ applies nothing. See APP-CONTRACT.md and the 9 Oct
review fixes in HISTORY.md. A confirmed future week is server-owned
(`_serverConfirmed`), never locally promoted; an intentionally empty historical
week is a record (`_saved: true`), not a missing snapshot.

**Diary inner tabs, owner 7 Oct 2026:** the later Dota-style request applies
only to the inner diary row. Each tab has its own lit gradient and a fixed
42px button height (8px 16px padding), without selection lift. Scoped tokens
override the shared band treatment there; the workspace row is unchanged.

**How strict a procedure is depends on what a mistake costs.** Anything that
deletes, migrates or publishes is a SCRIPT that checks and refuses
(`mtb.ps1`, `cloud-migrate.ps1`, `cloud-cleanup.ps1`, `backup-db.ps1`, the
hooks), never a paragraph somebody has to follow correctly. Prose is for
judgement: what a screen should say, how a feature is shaped. When a rule in
this file is being broken by people who read it, that is the sign it should
become a check.

## Traps already hit — do not repeat them

Before changing an area below, read its WHOLE linked group in TRAPS.md, not
only a familiar title. For cross-area work, read all matching groups: diary
attendance needs Diary + Schedules; its save/import path also needs Sync.
Database-writing tests and deployment also need Scripts; handling real records
needs Identity. Tests still use invented data in guarded scratch schemas.
Every trap keeps its existing link and has one home group.

### Scripts, migrations and backups

Read this whole group before editing PowerShell, process launching, migrations, backup/restore, deployment or database-writing tests. [Open the whole group](docs/TRAPS.md#group-scripts).

- [`CREATE OR REPLACE VIEW` cannot change columns](docs/TRAPS.md#trap-02)
- [Cyrillic migrations](docs/TRAPS.md#trap-03)
- [Every `.ps1` needs a UTF-8 BOM](docs/TRAPS.md#trap-04)
- [PowerShell reads „ and “ as double quotes](docs/TRAPS.md#trap-05)
- [A suite that writes a row "once, and never again" must delete it](docs/TRAPS.md#trap-12)
- [A recovery schema name belongs to ONE reviewed batch, and reusing it stops the deploy dead](docs/TRAPS.md#trap-28)
- [PowerShell names ignore case, and a script's parameter is a script variable](docs/TRAPS.md#trap-39)
- [A migration guard must ask about the object it is going to change, not about its name anywhere in the cluster](docs/TRAPS.md#trap-41)
- [`IF NOT EXISTS` turns a superseded migration into a resurrection](docs/TRAPS.md#trap-42)
- [The rule you just quoted is the one you break](docs/TRAPS.md#trap-44)
- [The scratch-database guard never once fired, and its refusal pointed at the real data](docs/TRAPS.md#trap-45)
- [A PowerShell wrapper hides the tool it is checking](docs/TRAPS.md#trap-47)
- [Windows PowerShell eats the double quotes in an argument it hands to a native program](docs/TRAPS.md#trap-48)
- [A grandchild `powershell.exe -File` can fail before printing its first line, and say nothing about why](docs/TRAPS.md#trap-49)
- [A backup is a state, not a run (owner, 1 Oct 2026)](docs/TRAPS.md#trap-62)

### Identity, privacy and access

Read this whole group before changing pupil/staff matching, archive/delete/merge, authentication, public routes or screenshots containing records. [Open the whole group](docs/TRAPS.md#group-identity).

- [Two students can share a name](docs/TRAPS.md#trap-08)
- [Rasporedi must never delete a person from the database, and cannot](docs/TRAPS.md#trap-14)
- [Students are archived, never deleted](docs/TRAPS.md#trap-15)
- [A student has TWO unique keys, and `ON CONFLICT` only ever knew about one](docs/TRAPS.md#trap-25)
- [A shared name must not archive the wrong child](docs/TRAPS.md#trap-26)
- [Real names were in the public repository for months, and nobody was checking](docs/TRAPS.md#trap-27)
- [A database that cannot lower-case Cyrillic breaks every name match, and says something else](docs/TRAPS.md#trap-33)
- [A static root is a disclosure boundary](docs/TRAPS.md#trap-38)
- [The colleagues' door is the only thing the cloud shows without the owner](docs/TRAPS.md#trap-55)
- [The colleagues' door closes in ONE hook, and the owner holds the switch (1 Oct 2026, migration 052)](docs/TRAPS.md#trap-56)
- [A picture taken through the local server carries a real name (8 Oct 2026)](docs/TRAPS.md#trap-69)

### Sync, storage and API writes

Read this whole group before changing save/load, JSON import/export, projection, offline queues, retries, change detection or API write paths. [Open the whole group](docs/TRAPS.md#group-sync).

- [Missing from a payload is NOT the same as gone](docs/TRAPS.md#trap-11)
- [A whole-document save must not restate what now has its own endpoint](docs/TRAPS.md#trap-13)
- [Empty must never overwrite archived history](docs/TRAPS.md#trap-16)
- [`jsonb` reorders object keys](docs/TRAPS.md#trap-21)
- [`applyUnifiedPayload` mutates the object it is given](docs/TRAPS.md#trap-22)
- [Do not wrap an object property to observe a save](docs/TRAPS.md#trap-23)
- [Volatile fields must stay out of change detection](docs/TRAPS.md#trap-24)
- [`sync-peer` used to report a failed fetch as a divergence, then recommend `--force`](docs/TRAPS.md#trap-29)
- [A queue in memory is not a queue](docs/TRAPS.md#trap-30)
- [A dropped write needs re-queueing, not a `continue`](docs/TRAPS.md#trap-31)
- [A refused rename must stop the caller too](docs/TRAPS.md#trap-32)
- [CORS listed only GET, PUT and OPTIONS](docs/TRAPS.md#trap-37)
- ["Is this device new?" must be asked at page load](docs/TRAPS.md#trap-40)
- [A blob that saves is not a table that knows (2 Oct 2026)](docs/TRAPS.md#trap-59)

### Diary, clinical records and progress

Read this whole group before changing S-Dnevnik IDs, clinical text, attendance formats, session counting, plan progress or diary exports. [Open the whole group](docs/TRAPS.md#group-diary).

- [S-Dnevnik ids are `Date.now()`](docs/TRAPS.md#trap-06)
- [Attendance marks](docs/TRAPS.md#trap-07)
- [Never trim clinical free text](docs/TRAPS.md#trap-20)
- [A merged term is one session, and only the time says so](docs/TRAPS.md#trap-34)
- [The projection could only ever ADD progress](docs/TRAPS.md#trap-35)
- [`npm run export` used to drop the attendance time](docs/TRAPS.md#trap-36)
- [The diary has six hours, and an empty sixth is not a change (7 Oct 2026)](docs/TRAPS.md#trap-61)

### Schedules, dates and school years

Read this whole group before changing Cabinet/diary schedules, week snapshots, calendar/date handling, attendance dates, rollover or conflict guards. [Open the whole group](docs/TRAPS.md#group-schedule).

- [Dates](docs/TRAPS.md#trap-01)
- [The school year transition has an order — but it is no longer destructive](docs/TRAPS.md#trap-09)
- [`rollover` no longer retires anyone](docs/TRAPS.md#trap-10)
- [The school calendar is data, not code](docs/TRAPS.md#trap-17)
- [One Monday calculation, `mondayOf`](docs/TRAPS.md#trap-18)
- [Attendance cannot be written on a non-working day](docs/TRAPS.md#trap-19)
- [The school calendar is a RULE, not a list, and the server has neither](docs/TRAPS.md#trap-43)
- [The diary's plan and Кабинети are kept equal by asking, through ONE writer (owner, 1 Oct 2026)](docs/TRAPS.md#trap-58)
- [A copy of a week is written when the plan CHANGES, never when it is looked at (owner, 5 Oct 2026)](docs/TRAPS.md#trap-60)
- [A second writer with fewer rules is a hole, not a convenience (4 Oct 2026)](docs/TRAPS.md#trap-66)

### UI, navigation and shared lists

Read this whole group before changing themes, controls, tabs, Back/Forward, shared list rendering, labels/renames, print/PDF or Undo. [Open the whole group](docs/TRAPS.md#group-ui).

- [A `<button>` does not inherit `color`, and the light theme hid it](docs/TRAPS.md#trap-46)
- [A screen that reads the lists once is a copy, and copies disagree](docs/TRAPS.md#trap-50)
- [A label stored as text must move with a rename](docs/TRAPS.md#trap-51)
- [A class is one sentence, written in one place](docs/TRAPS.md#trap-52)
- [A view the person chooses is a step in the browser's history](docs/TRAPS.md#trap-53)
- [A strip, a header row or a section behaves the same on every screen, and one file decides how](docs/TRAPS.md#trap-54)
- [A subject's name is text in three places, and they move together](docs/TRAPS.md#trap-57)
- [The workspace opens S-Дневник after owner login (2 Oct 2026 clarification)](docs/TRAPS.md#trap-63)
- [A page cannot switch the browser's print header and footer off (4 Oct 2026)](docs/TRAPS.md#trap-64)
- [One flat look, opted into per page (1 Oct 2026)](docs/TRAPS.md#trap-65)
- [A list kept in two places is two lists (4 Oct 2026)](docs/TRAPS.md#trap-67)
- [„Врати" is a new write, never a rollback (6 Oct 2026)](docs/TRAPS.md#trap-68)

## Maintaining this memory

Keep this entry below 24 KiB and SOSTOJBA.md below 32 KiB (repository budgets,
not claims about any tool's loading limit). Move detail into the existing
reference documents; keep a pointer here. Keep recent state in SOSTOJBA.md and historical
state in the single archive, not new handover files. Add feature reasons to HISTORY.
Run `npm run docs:toc` and `npm run check:agent-docs` from `server/`.
The pre-commit hook checks imports, size budgets, trap links, indexes and privacy.
