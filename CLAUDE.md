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

**Do not replace the apps' local reads with API calls.** The original plan
said to, but that predates the local-first design; doing it would make the
apps require a server and lose offline editing. The relational tables exist
for cross-cutting questions (`Pregled-Baza.html`, `/api/*`), not to feed the
editing screens.

**One database.** With several machines, exactly one runs PostgreSQL + the API
and the rest are browsers pointed at it over Tailscale. Two live databases
cannot be merged — only carried, by exporting JSON and importing it.

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
server/scripts/                 import-json, export-json, rollover-year
database/migrations/*.sql       applied in filename order, tracked in schema_migrations
scripts/                        setup, backup, supervisor, verify
docs/HOME-SETUP.md              setting up another machine
```

## Commands (from `server/`)

```
npm run dev          server with reload          npm test     20 tests
npm run start        server                      npm run export
npm run import -- <files>            dry run; add --apply to write
npm run rollover -- --to 2026/2027   dry run; add --apply
```

From the repo root:

```
powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1        health check
powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1 new machine
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1           dump + JSON
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1          supervised server
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

## Conventions

App code and UI text are Macedonian; server code and comments are English.
Comments explain *why*, not *what*. Scripts are dry-run by default and need
`--apply` to write.

## State (19 Aug 2026)

Plan stages 0–9 complete: local PostgreSQL, API, blob sync in both apps,
identity reconciliation, full relational model, school years with rollover,
verified backups, Tailscale access. Supabase sync was removed.

Real data loaded: 82 students, 10 therapists, 436 terms, 919 attendance
marks, 16 dossiers, 48 assessments, 21 triage tests, 16 audiograms.

Open, needing a human rather than code: 6 double-booked terms, 10 students
with no term, the 2026/2027 rollover, and the `postgres` superuser password
still being `qwerty`.

See `docs/STATUS-2026-08-19.md` and `therapy_app_postgres_local_plan_v2.md`.
