# Canonical application contract

This file is the short, authoritative product contract for the MTB web suite.
Read it before changing page structure, navigation, schedule behaviour, storage,
server selection, or database sync. Longer design history belongs in
`AGENTS.md`; when history and this contract disagree, this contract wins.

## One product, one schedule

The user works in one connected MTB suite. The suite has several task screens,
but it must not present parallel versions of the same task.

- `start.html` is the entry point and server chooser.
- `app-navigation.js` is the shared movement and status bar.
- `RasporediFusion.html` is the only user-facing schedule application.
- `Rasporedi.html` is a compatibility and recovery file for legacy JSON. Keep
  it loadable, but never list it in `start.html`, the shared navigation, or the
  EduHub application grid.
- Do not create another top-level schedule HTML file to try a visual redesign.
  Improve `RasporediFusion.html` in place. A new schedule entry point requires
  an explicit product decision and an update to this contract and its tests.

- `AkciskiPlan.html` is the only pupil-development-record screen. It renders
  both the prescribed евидентен лист and the category-linked action plan. It
  is database-first and keeps no copy of a record in the browser; do not add a
  second page or a local fallback for either document.

## What each application is FOR, and what it must refuse to become

The rules above say which file owns what. These say why each exists. The second
half of each line matters more than the first: an application stays useful by
refusing work that belongs to another one, and every drift this project has had
began with a screen growing a second purpose.

- **`RasporediFusion.html` exists to detect impossible presence** — the same
  pupil in the same time slot in two different cabinets. It is a diff over time
  intervals assigned to pupils, and a conflict report. It therefore does not need
  a week: "is this child booked twice" is a question about the plan, asked when
  the plan is made, not about week fourteen. `schedule_slots` having no time
  dimension is correct for it, not a gap. It must refuse weeks, holidays, a
  diary, and history.

- **`S-Dnevnik.html` is one therapist's personal tool.** It solves that person's
  work and is not repurposed for another cabinet. It owns what HAPPENED; it reads
  the shared facts and owns none of them. Its holiday and working-day logic is
  its own and stays there. It must refuse to become a second writer of anything
  shared -- above all the schedule, which it can still overwrite today through the
  unified payload (see `docs/PLAN-rasporedot-i-nedelata.md`).

- **`Podatoci.html` is who exists this year** — pupils, teachers, therapists,
  classes, categories, and the caseload links. Every other screen derives from it
  and none of them writes a person.

- **`AkciskiPlan.html` is the pupil's development record** — the prescribed
  евидентен лист and the quarterly action plan, one screen because they are one
  document about one child.

`RasporediFusion.html` intentionally contains its own HTML, CSS, and browser
JavaScript. Its PostgreSQL API remains in `server/`; copying the appearance
without that API layer is not a functional application.

## Required schedule behaviour

The canonical schedule must retain all of these capabilities:

- read years from `/api/years`;
- read the selected year's students, caseloads, and therapists from
  `/api/roster`;
- read sessions from `/api/schedule/sessions`;
- write one visible 40-minute block through `/api/schedule/block` using stable
  student and therapist ids plus the expected previous value;
- continue reading and editing compatible 20- or 40-minute rows through
  `/api/schedule/session`;
- represent one pupil as one 40-minute session and two pupils as ordered
  20-minute halves;
- refuse stale or conflicting writes visibly, never silently replace them;
- provide day and therapist-week views, therapist focus, print, JPG export,
  light/dark theme, and usable desktop/mobile layouts;
- give the schedule the full workspace width and show every selected pupil's
  full label without ellipsis; the native select remains the editor and opens
  when its visible slot is clicked;
- keep the caseload outside the schedule grid in a separate
  `Ученици по терапевт` tab, with sequential row numbers and filters for
  enrolment kind and scheduled/unscheduled pupils;
- show server-confirmed save state and the server identity in the shared bar.

There is no browser-only fallback inside Fusion. If PostgreSQL cannot confirm a
write, the screen must report failure instead of pretending the change is safe.

## Data and history

The selected school year's enrolment decides who belongs to a historical
roster and schedule. A student's present-day global `active` flag may filter
the current year, but it must never hide a valid enrolment or schedule slot in
an archived year. Old rows are history, not today's waiting list.

Do not use names as row identity. Reads and writes use stable public ids;
ambiguous identity is reported and never guessed. An empty payload never erases
stored data. Real names remain local and must not enter this public repository.

## Server identity and machine transfer

WORK and HOME are logical installation roles. Their Windows hostname can be
identical, so hostname is display information only and must never choose the
role or sync direction. Each machine's ignored `server/.env` must explicitly
set `SYNC_NAME=work` or `SYNC_NAME=home`; `/api/health` is the source displayed
by the UI.

The two PostgreSQL databases are independent. Transfer is the manual verified
snapshot workflow in `docs/MANUAL-DB-SYNC.md`: export to separate pCloud
folders, compare, then accept one exact snapshot id. Startup never restores a
peer database and full databases are never row-merged.

The local/Tailscale HTTP server publishes only an explicit allowlist of the
top-level application HTML, shared JavaScript and required image assets. A new
public file must be added deliberately to `server/src/lib/public-static.ts`.
Repository directories, `.env`, Git metadata, migrations, scripts, backups,
documentation, local handoff files and unknown paths must remain unreachable
through the static route and return 404.

## The pupil development record

`AkciskiPlan.html` writes `evidence_*` rows through `/api/evidence/*`. Its
required behaviour:

- sign in as one of the database's therapists or teachers, and stamp every
  write with that name — the record is filled by several specialists;
- write one score at a time as (sheet, item, period), passing the expected
  previous value and refusing a stale write visibly;
- read the pupil's class from the selected year's enrolment and never store a
  second copy of it;
- treat the sections, their items and the year's assessment columns as data the
  page can edit, hiding rather than deleting anything that already carries
  marks;
- delete a SHEET only, never a person, and say which of the two it is doing;
- print one prescribed Word document per pupil or for the whole year, with one
  column per active period of that year;
- print the selected pupil's action plan as a separate Word document containing
  only its included category sections, never the diagnosis, sensory appendices
  or contacts from the prescribed form.

The sign-in is always an authorship stamp and a shared-workstation lock. Its
authorization role is deployment-controlled:

- with `MTB_REQUIRE_SIGNIN` unset, the compatibility contract remains open and
  a PIN does not grant or restrict API access;
- with `MTB_REQUIRE_SIGNIN=1`, every API mutation is default-denied unless it
  is explicitly delegated or made by the configured administrator/service
  account. A therapist may change only their own schedule and annual caseload;
  a pupil's evidence sheet and its sheet-derived reads/writes are limited to
  that therapist's annual caseload or a teacher's assigned annual class;
  action-catalogue content remains owned by the annual category holder, while
  structural changes to the prescribed catalogue are administrator-only;
- schedule, conflict and shared roster reads remain visible to any caller that
  can reach the API because a cross-cabinet conflict cannot be resolved while
  the other cabinet is hidden. Public directory endpoints needed to choose a
  login also remain visible.

This is an operational authorization boundary, not a confidentiality claim.
A four-digit PIN is low-entropy. The API accepts exactly four decimal digits and
locks that identity for five minutes after five wrong guesses. Under enforced
mode, an initial PIN requires administrator/service scope and a person changes
their own PIN from a live session; direct proof of the old PIN remains available
only in compatibility-open mode. The server still depends on Tailscale and its
CORS/network configuration, and none of this encrypts or anonymizes the local database.
Never expose the API on a public address.

`MTB_ADMIN` must identify the person by kind (`therapist:<name>` or
`teacher:<name>`); a display name alone is ambiguous across the two directories.
Local maintenance and peer-sync writes use a random `MTB_SERVICE_KEY` of at
least 32 characters. The key belongs only in each machine's ignored
`server/.env`, must match on the WORK/HOME pair, and must never be placed in a
browser or committed.

## Definition of done

A schedule or navigation change is not complete until all of these hold:

1. `npm test` passes, including `app-contract.test.ts`.
2. `npm run test:fusion` proves database rows and historical visibility.
3. `npm run test:fusion-ui` proves the real browser workflow and layout.
4. `npm run test:navigation` proves the connected suite and status bar.
5. `npm run check:names` confirms that no local names entered Git.
6. For an evidence-record change, `npm run test:evidence` and
   `npm run test:evidence-ui` pass. For categories, ownership or the action
   plan, `npm run test:categories` passes too.
7. The historical production count is compared before and after the change;
   a UI count drop must be explained before any restore or delete is attempted.
8. For a colleague-access or authorization change, `npm run test:colleague`
   passes in both compatibility and enforced modes, and the browser suites
   prove the shared sign-in without treating a disabled control as the
   security boundary.
9. The static-route regression test and a live HTTP smoke test prove that the
   approved app shell loads while local configuration and repository internals
   return 404.

## Two catalogues, one engine

`AkciskiPlan.html` renders TWO documents out of one set of tables. Sections
carry a `catalog`:

- `prescribed` — the евидентен лист itself. Always on every sheet, never
  switchable, and the only thing the prescribed form may print. Adding cabinet
  goals here is forbidden: within a year nobody would be able to tell which
  sections the Правилник requires.
- `action` — the quarterly action plan. Each such section names one specialist
  category. It appears on a sheet when the pupil is on the caseload of a
  therapist holding that category, or in a class assigned to a teacher holding
  it, in that school year.

The category is recorded per school year on `therapist_years` or
`teacher_years`, and is assigned only in `Podatoci.html`. Do not add a second
screen that assigns it, and do not move it onto the person row — an archived
plan must keep saying what role the person held then. The category holder may
create its action section and enter its goals in `AkciskiPlan.html` settings;
the application must never invent clinical content.

An action section's scale may change only before it carries marks. A section
excluded from one pupil's plan is not writable even while catalogue-edit mode
keeps it visible. Prescribed sections stay shared and are not category-gated.

Manual overrides are stored as deviations only. Never persist the full section
list for a sheet: that freezes the sheet at creation and stops it following the
caseload.
