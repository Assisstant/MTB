# MTB — therapy apps for ОУРЦ „Кочо Рацин", Битола

Read this first. It is the shared memory between machines: sessions on other
PCs have none of the earlier conversation.

## What this is

Two single-file HTML applications used daily by a speech therapist, plus a
local PostgreSQL database they sync to.

| File | Purpose |
|---|---|
| `Rasporedi-Unified-Sync-v5.0.html` | weekly schedule for all ten therapists |
| `S-Dnevnik-Blagoj-Unified-Sync-v4.html` | one therapist's diary: attendance, plans, dossiers, assessments, audiograms |
| `Pregled-Baza.html` | read-only overview of the database |
| `server/` | Fastify + TypeScript API over PostgreSQL |

The apps are published through GitHub Pages at
`https://assisstant.github.io/MTB/` and used from there.

## Architecture, and why

**Local-first.** Every edit is saved immediately to the browser's own storage
(localStorage in Rasporedi, IndexedDB in S-Dnevnik). The apps work with no
network and no server. Nothing is ever sent automatically.

**The server is opt-in.** Pressing „Зачувај на сервер" sends the whole state
to `PUT /api/state/:app`, which stores it as a jsonb blob **and** projects it
into relational tables. Pressing „Вчитај од сервер" pulls it back.

**Sync decides direction, it never merges.** The apps are used in one place at
a time, so the safe question is not "which is newer" but "which side changed
since the two last agreed". Each app stores that agreement as a pair of content
fingerprints; `sync-peer` stores it in `sync_watermark`. One side changed →
copy it. Both changed → refuse and ask a human. A timestamp comparison alone
would silently discard a whole session's work, which is why it is only ever the
fallback for a first sync. See `docs/SYNC.md`.

**Do not replace the apps' local reads with API calls.** The original plan
said to, but that predates the local-first design; doing it would make the
apps require a server and lose offline editing. The relational tables exist
for cross-cutting questions (`Pregled-Baza.html`, `/api/*`), not to feed the
editing screens.

**One database per machine at most.** Ideally exactly one machine runs
PostgreSQL + the API and the rest are browsers pointed at it over Tailscale.
Where a second database genuinely exists (work and home, each offline from the
other for most of the day), `scripts\sync-peer.ps1` carries state between them
in whichever direction changed. It still cannot merge — nothing can — and it
refuses rather than guessing when both sides moved.

## Rules that must not be broken

1. **No student names in this repository.** It is public (GitHub Pages serves
   from it). Names belong in the local database only. Test fixtures and
   migrations use invented names.
2. **Never guess an identity match.** Students are reconciled across the two
   apps by bridge id → exact name → bare name → name+grade. Ambiguity is
   reported and left unlinked, never merged.
3. **An empty payload must never erase stored data.** An app opened on a fresh
   device holds nothing until it pulls; saving first would wipe the year.
   Safeguards in `import-core.ts` refuse it and say so.
4. **Real data stays local.** `backups/` is gitignored. Never commit exports,
   dumps or `.env`.

## Layout

```
server/src/lib/import-core.ts   identity + projection (shared by API and CLI)
server/src/routes/state.ts      blob save/load, projects into tables
server/src/routes/data.ts       read endpoints
server/scripts/                 import-json, export-json, rollover-year, sync-peer
database/migrations/*.sql       applied in filename order, tracked in schema_migrations
scripts/                        setup, backup, supervisor, verify, sync-peer, scheduled tasks
docs/HOME-SETUP.md              setting up another machine
docs/CLIENT-SETUP.md            a machine that installs nothing
docs/SYNC.md                    how staying in sync works, and what to do when it complains
```

## Commands (from `server/`)

```
npm run dev          server with reload          npm test     20 tests
npm run start        server                      npm run export
npm run import -- <files>            dry run; add --apply to write
npm run rollover -- --to 2026/2027   dry run; add --apply
npm run sync -- --peer <url>         dry run; add --apply to write
```

From the repo root:

```
powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1        health check
powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1 new machine
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1           dump + JSON
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1          supervised server
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1           report; -Apply to sync
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1   server, weekly backup, sync
```

Credentials are the same on every machine: `therapy` / `therapy_local` /
`therapy_dev`, localhost only.

## Traps already hit — do not repeat them

- **Dates.** `node-postgres` returns `DATE` as a JS `Date` at *local*
  midnight; `toISOString()` then moves it to the previous day. `src/db.ts`
  parses oid 1082 as a plain string. Row counts matched while every clinical
  date shifted — verify content, not counts.
- **`CREATE OR REPLACE VIEW` cannot change columns.** Drop the view first, or
  a later migration fails (hit twice: 004 and 007).
- **Cyrillic migrations** need `PGCLIENTENCODING=UTF8`, or a Windows console
  codepage corrupts them.
- **S-Dnevnik ids are `Date.now()`** — `bigint`, never `integer`.
- **Attendance marks** are a bare `"present"` string in some exports and
  `{status}` in others. Blank marks carry no information.
- **Two students can share a name.** There are two „Јана Петровска" in
  different grades. Grade disambiguates; without it, do not link.
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
- **Volatile fields must stay out of change detection.** `exportedAt`, `revision`,
  `_meta.savedAt` change on every save with no edit behind them. Hash content
  fields only.
- **"Is this device new?" must be asked at page load.** Building the payload
  writes to localStorage, so asking later always answers "not new" — and a fresh
  device would push its built-in defaults over a year of real work instead of
  pulling. But for "may I create the server state?", ask whether the *payload has
  content* — otherwise someone who starts entering data on a new machine can
  never save it.

## Conventions

App code and UI text are Macedonian; server code and comments are English.
Comments explain *why*, not *what*. Scripts are dry-run by default and need
`--apply` to write.

## State (21 Aug 2026)

Plan stages 0–9 complete: local PostgreSQL, API, blob sync in both apps,
identity reconciliation, full relational model, school years with rollover,
verified backups, Tailscale access. Supabase sync was removed.

Since then: automatic sync in both apps (one „🔄 Синхронизирај" button, on open
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

See `docs/STATUS-2026-08-19.md` and `therapy_app_postgres_local_plan_v2.md`.
