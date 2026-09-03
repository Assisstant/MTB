# Local-First Therapy App — PostgreSQL Plan v2 (corrected for the real apps)

This is the corrected version of `therapy_app_postgres_local_first_plan.md`.
It is rewritten around the two applications that actually exist in this repo:

- **`Rasporedi-Unified-Sync-v5.0.html`** — multi-therapist schedule app
- **`S-Dnevnik-Unified-Sync-v4.html`** — the local therapist's diary app

## Goal (unchanged)

**Existing HTML/JavaScript frontend → local TypeScript API → local PostgreSQL**

Everything runs locally on machines you control. No student data on a public
cloud during learning. The browser never talks to PostgreSQL directly — only
to the API.

---

## Progress (updated 2026-08-18)

| Stage | State | Notes |
|---|---|---|
| 0 preserve current work | done | repo under git; real backups used as import source |
| 1 PostgreSQL locally | done | PostgreSQL 18 on Windows, db `therapy_dev`, role `therapy` |
| 2 TypeScript API | done | Fastify + pg + Zod in `server/`, `GET /api/health` |
| 2.5 blob endpoint | done | `GET/PUT /api/state/:app`, version counter, 409 on conflict |
| 3 identity + importer | done | `server/scripts/import-json.ts`, tiered matching, dry run by default |
| 4 core tables | done | students / therapists / therapist_students |
| 5 schedule | done | `schedule_slots` + `schedule_conflicts` view |
| 6 attendance & plans | done | attendance, plans, plan_activities, student_plan_progress |
| 7 clinical records | done | dossiers, scale_templates, assessments, triage_tests, audiograms |
| 8 backup & restore | done | `scripts/backup-db.ps1` (weekly task `TherapyBackup`), JSON export, restore tested |
| 9 LAN / remote access | done (Tailscale) | tailnet-only HTTPS via `tailscale serve`; phone + PCs reach one server |
| 10 retire Supabase path | open | Supabase module still present in Rasporedi, offline by default |
| 11 authentication | open | not needed while access is tailnet-only and single-user |
| 12 institutional hosting | open | only if real staff and authorization appear |

Loaded from the real May 2026 backups: 82 students, 10 therapists, 221
therapist-student links, 436 schedule slots (6 double-bookings), 919
attendance marks, 671 progress entries, 16 dossiers, 48 assessments, 21
triage tests, 16 audiograms (3 unlinked).

Still open, deliberately: the read paths. Both apps continue to run on the
`app_state` blob; the relational tables are populated in parallel and nothing
reads from them yet.

Not modelled yet: the diary's own weekly schedule (monday…friday) and the
links list — the JSON export says so on every run.

---

## 0. What the apps actually contain today (inventory)

The v1 plan assumed a generic app. This is the real state:

### Rasporedi v5.0

| Data | Shape today |
|---|---|
| `students` | array of **name strings** (identity = the name itself) |
| `studentMeta` | per-name metadata incl. a generated stable `studentId` |
| `therapists` | array of name strings |
| `therapistStudents` | `{ therapistName: [studentName, …] }` — a many-to-many |
| `schedule` | array of slots `{ day, time, assignments: { therapistName: studentName } }` |

Storage: localStorage + manually exchanged **Unified Sync JSON**
(`schemaVersion 2.0`), snapshots before every load, per-therapist merge.
It also contains a **Supabase cloud sync module** (offline by default,
whole-blob push/pull with a version counter and conflict detection).

### S-Dnevnik v4

| Data | Shape today |
|---|---|
| `students` | objects with **numeric `id`**, name, grade, `planId`, `rasporediStudentId` |
| `schedule`, `scheduleHistory` | weekly terms per student |
| `attendance` | `attendance[dateStr][studentId][slotKey] = { status, date, time }` |
| `plans` | `{ id, name, activities: [...] }` |
| `studentProgress` | `progress[studentId][planId] = [completed activities]` |
| `trijazenTestovi` | triage test results |
| `student_records` | dossiers: firstName, lastName, birthDate, parents, address, contact, findings, opinion |
| `audiograms` | `{ subjectName, date, rightAir, rightBone, leftAir, leftBone }` |
| `assessments` + `scaleTemplates` | 0–4 rating scales per period (T1–T4) |

Storage: **IndexedDB** with a localStorage pointer (data outgrew the 5 MB
localStorage quota), rotating local backups, JSON export.

### The bridge

The two apps share students through `rasporediStudentId`. There are therefore
**three identity schemes** in play: Rasporedi name strings, S-Dnevnik numeric
ids, and the bridge string id.

---

## 1. Corrections to the v1 plan

1. **A blob stage comes before per-entity CRUD.** Both apps save their entire
   state as one JSON document (`saveData()` writes everything). Jumping
   straight to `POST /api/students` would mean rewiring hundreds of call
   sites. Instead: first let the API store the whole Unified JSON in one
   `jsonb` row (Stage 2.5 below). That alone replaces the manual
   "pass the master JSON around" workflow with one authoritative server.
2. **Student identity reconciliation is a first-class migration step**, not a
   footnote. The canonical key becomes the `rasporediStudentId`-style stable
   string; old numeric ids are kept in a column for traceability.
3. **The Supabase module already exists and needs a decision.** The v1 plan
   ignored it. Plan: keep it untouched (offline by default) while the local
   API is built, then retire it — or repoint it at the local API — in
   Stage 10. Do not run two live sync paths at once.
4. **Offline capability must be kept deliberately.** Today both apps work
   with zero network. The localStorage/IndexedDB layer stays as the offline
   cache; the API becomes the source of truth *when reachable*. The
   dirty-flag + version-conflict logic already written for Supabase is reused
   for the local API.
5. **Environment is Windows** (this PC). PostgreSQL installs natively; the
   "old Linux PC" is an optional later stage, not a prerequisite.
6. **The repo is already a git repository** — Stage 0 is mostly done; what
   remains is fresh JSON exports and an anonymized sample dataset.
7. Durable Objects / `celld` remain out of scope until a real problem appears
   (unchanged from v1, but demoted to an appendix mentally — nothing in the
   current apps needs them; schedule conflicts are already detected in JS and
   will be enforced by DB constraints).

---

## 2. Target architecture

```text
Rasporedi v5.0 (browser)      S-Dnevnik v4 (browser)
        \                          /
         \   HTTP / JSON (fetch)  /
          v                      v
        TypeScript API  (Fastify, localhost:3000)
                    |
                    | SQL
                    v
            PostgreSQL  (therapy_dev, local)
```

Two phases of the API:

- **Phase A (blob):** `GET/PUT /api/state/:app` — the Unified JSON lives in
  one `jsonb` row with a version counter. Multi-device via one server,
  conflict detection identical in spirit to the existing cloud module.
- **Phase B (relational):** real tables, entity endpoints, decomposed
  gradually while Phase A keeps working.

## 3. Stack

```text
Node.js + TypeScript
Fastify
pg (node-postgres driver, raw SQL first)
Zod (validate payloads at the API boundary)
Drizzle ORM — optional, only after the schema is stable
```

Raw SQL first is deliberate: the project doubles as the PostgreSQL refresher.

## 4. Rules kept from v1

- Never copy/sync PostgreSQL data folders (no Dropbox/Drive/OneDrive on the
  data directory). One authoritative running server; everyone goes through
  the API.
- JSON does not disappear: it stays as the API wire format and as the
  import/export/backup format (the existing Unified Sync JSON exporters are
  the backup tool).
- Real student data stays local until institutional authorization is
  explicit. Use anonymized data for experiments.

---

## 5. Roadmap

### Stage 0 — preserve current work (mostly done)

- Repo is under git — commit current state.
- Export a fresh Unified Sync JSON from Rasporedi and a full JSON backup from
  S-Dnevnik; keep them as migration input and rollback.
- Create `sample-data/anonymized/` with fake names for development.

### Stage 1 — install PostgreSQL locally (Windows)

- Install PostgreSQL + pgAdmin (native Windows installer).
- Create database `therapy_dev`.
- SQL refresher using the real model (create/insert/select on a throwaway
  `students` table with 3 fake students).

### Stage 2 — TypeScript API skeleton

Create `/server` in this repo:

```text
GET /api/health          → { ok: true }
```

### Stage 2.5 — blob endpoint (NEW; the key correction)

```sql
CREATE TABLE app_state (
    app         text PRIMARY KEY,          -- 'unified'
    version     integer NOT NULL DEFAULT 1,
    payload     jsonb   NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text
);
```

```text
GET /api/state/unified            → { version, payload, updated_at, updated_by }
PUT /api/state/unified            body: { baseVersion, payload, updated_by }
      → 200 { version: n+1 }      if baseVersion matches
      → 409 { current }           if someone else saved in between
```

Frontend change is small: in each app's save/load seam
(`exportJSONBackup` / import in Rasporedi, `saveData()` / `loadData()` in
S-Dnevnik) add a "local server" mode that pushes/pulls this endpoint. The
409-conflict handling mirrors what the Supabase module's `cloudState.version`
already does — reuse that logic and UI (status chip, dirty flag, snapshots
before overwrite).

**When this works, the manual master-JSON workflow is obsolete.** That is the
first big win, and it requires no relational modelling at all.

### Stage 3 — identity reconciliation + JSON importer

`/scripts/import-json.ts` reads the exported Unified JSON and builds the
canonical student list **before** any other table:

```text
1. Take every Rasporedi student name + its studentMeta.studentId
2. Take every S-Dnevnik student (numeric id, rasporediStudentId)
3. Join on rasporediStudentId where present; fall back to exact name match;
   report every unmatched record for manual review — do not guess silently
4. Emit one canonical row per real student
```

The importer must: validate (Zod), report errors, avoid duplicates on re-run
(upsert on `public_id`), and print an import summary.

### Stage 4 — first relational tables

```sql
CREATE TABLE students (
    id           serial PRIMARY KEY,
    public_id    text UNIQUE NOT NULL,     -- the stable string id (bridge id)
    sdnevnik_id  integer UNIQUE,           -- old numeric id, migration only
    name         text NOT NULL,
    grade        text,
    active       boolean NOT NULL DEFAULT true
);

CREATE TABLE therapists (
    id    serial PRIMARY KEY,
    name  text UNIQUE NOT NULL
);

CREATE TABLE therapist_students (
    therapist_id integer NOT NULL REFERENCES therapists(id),
    student_id   integer NOT NULL REFERENCES students(id),
    PRIMARY KEY (therapist_id, student_id)
);
```

API: `GET/POST/PUT/DELETE /api/students`, same for `/api/therapists`.
First frontend swap: the student list in S-Dnevnik reads from
`GET /api/students` (v1 plan's Stage 4, unchanged — it just happens later).

### Stage 5 — schedule

```sql
CREATE TABLE schedule_slots (
    id           serial PRIMARY KEY,
    day          text NOT NULL,            -- keep the app's day keys
    time_slot    text NOT NULL,            -- keep the app's time labels
    therapist_id integer NOT NULL REFERENCES therapists(id),
    student_id   integer REFERENCES students(id),
    UNIQUE (day, time_slot, therapist_id)  -- a therapist has one slot per term
);
```

The double-booking check the JS does today ("student is with another
therapist at the same term") becomes a query + a constraint check at the API,
inside a transaction.

### Stage 6 — attendance, plans, progress

```sql
CREATE TABLE attendance (
    id         serial PRIMARY KEY,
    student_id integer NOT NULL REFERENCES students(id),
    date       date NOT NULL,
    time_slot  text NOT NULL,
    status     text NOT NULL CHECK (status IN ('present','absent')),
    UNIQUE (student_id, date, time_slot)
);

CREATE TABLE plans (
    id   serial PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE plan_activities (
    id       serial PRIMARY KEY,
    plan_id  integer NOT NULL REFERENCES plans(id),
    position integer NOT NULL,
    label    text NOT NULL,
    UNIQUE (plan_id, position)
);

CREATE TABLE student_plan_progress (
    student_id  integer NOT NULL REFERENCES students(id),
    activity_id integer NOT NULL REFERENCES plan_activities(id),
    completed_at date,
    PRIMARY KEY (student_id, activity_id)
);
```

### Stage 7 — clinical records

Rule of thumb: **columns for what you query, `jsonb` for what you only
display.** Decompose a `jsonb` column into columns only when a real query
needs it.

```sql
CREATE TABLE student_records (            -- досие
    student_id  integer PRIMARY KEY REFERENCES students(id),
    first_name  text, last_name text, birth_date date,
    father_name text, mother_name text,
    address text, residence text, contact text,
    findings text, opinion text
);

CREATE TABLE scale_templates (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    indicators jsonb NOT NULL             -- [{id,label,levels[0..4]}]
);

CREATE TABLE assessments (
    id          serial PRIMARY KEY,
    student_id  integer NOT NULL REFERENCES students(id),
    template_id integer REFERENCES scale_templates(id),
    date        date NOT NULL,
    period      text CHECK (period IN ('T1','T2','T3','T4')),
    scores      jsonb NOT NULL,
    average     numeric(3,2),
    comment     text
);

CREATE TABLE triage_tests (
    id         serial PRIMARY KEY,
    student_id integer REFERENCES students(id),
    test_date  date,
    payload    jsonb NOT NULL             -- full trijazen detail, as-is
);

CREATE TABLE audiograms (
    id         serial PRIMARY KEY,
    student_id integer REFERENCES students(id),
    date       date,
    right_air jsonb, right_bone jsonb, left_air jsonb, left_bone jsonb
);
```

Attachments/large files stay as files on disk with a path reference in the
database — never as `bytea` blobs in the first version.

### Stage 8 — backups

```text
pg_dump therapy_dev                      (database backup, scheduled)
GET /api/export/unified                  (regenerates the Unified Sync JSON)
POST /api/import  (the Stage 3 importer as an endpoint)
```

Test restoring both into an empty database. The JSON export keeps the current
apps' formats working forever as a human-portable escape hatch.

### Stage 9 — LAN access (optional)

Move API + PostgreSQL to a home server (the old Linux PC, or keep this PC).
Bind the API to the LAN address; PostgreSQL stays bound to localhost — only
the API talks to it. Test from a laptop/phone on the same network.

### Stage 10 — retire the Supabase module

Once the local API is the source of truth:

- Preferred: remove the Supabase cloud panel from Rasporedi (or hide it), and
  keep the local-server mode from Stage 2.5.
- Alternative: keep the module but point its URL at the local API — only
  worth it if you want to preserve the exact UI; the endpoints are not
  Supabase-compatible, so this needs an adapter and is more work than
  removing it.

Never run Supabase sync and local-API sync simultaneously on real data.

### Stage 11 — authentication (only after everything above works)

```text
users, password hashing (argon2), roles (therapist/admin), audit log
```

Until then, the API is protected by being reachable only on localhost/LAN.

### Stage 12 — remote access & institutional hosting

Unchanged from v1: authorization, legal/data-protection review, private
network (e.g. VPN/Tailscale-style), never PostgreSQL on the public internet.

---

## 6. Offline strategy (explicit, was implicit in v1)

- localStorage (Rasporedi) and IndexedDB (S-Dnevnik) are **kept** as the
  local cache — the apps must still open and work with no server.
- On startup: try `GET /api/state` (later: entity endpoints); on success,
  refresh the cache; on failure, run from cache and mark the UI "offline".
- On save: write cache first, then push; a failed push sets the existing
  `dirty` flag and retries later. Conflicts (409) reuse the snapshot-before-
  overwrite behaviour both apps already have.

## 7. Suggested project structure (adapted to this repo)

```text
MTB/
├── Rasporedi-Unified-Sync-v5.0.html        (existing frontend)
├── S-Dnevnik-Unified-Sync-v4.html          (existing frontend)
├── server/
│   ├── src/
│   │   ├── index.ts          (Fastify bootstrap)
│   │   ├── db.ts             (pg pool)
│   │   ├── routes/state.ts   (Stage 2.5 blob endpoints)
│   │   └── routes/…          (entity routes, added per stage)
│   ├── package.json
│   └── tsconfig.json
├── database/
│   ├── migrations/           (numbered .sql files, applied in order)
│   └── seeds/
├── scripts/
│   ├── import-json.ts
│   └── export-json.ts
├── sample-data/
│   └── anonymized/
└── docs/
```

## 8. First practical session (updated targets)

```text
1. Install PostgreSQL + pgAdmin (Windows installer)
2. Create database: therapy_dev
3. Create the app_state table (Stage 2.5 SQL above)
4. Scaffold /server: Fastify + pg + TypeScript
5. GET /api/health works
6. GET/PUT /api/state/unified works (test with curl/pgAdmin)
7. In Rasporedi, wire "save to local server" / "load from local server"
   buttons to those endpoints
8. Open the app on a second browser/profile and see the same data
```

Stop there. When step 8 works, the architecture is proven and the manual
master-JSON round-trip is already replaced.

## 9. Principle

**Keep both frontends. Put one local API in front of one local PostgreSQL.
Ship the blob endpoint first — it solves the real synchronization pain with
minimal risk. Reconcile student identity before building relational tables.
Decompose into tables one area at a time, keeping JSON as import/export and
the local cache as offline mode. Retire the Supabase path once the local API
is trusted. Durable Objects stay an experiment for a problem you do not yet
have.**
