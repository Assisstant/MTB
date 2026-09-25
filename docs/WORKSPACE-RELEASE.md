# Master administration release — 21 September 2026

## Staff form update — 22 September, code ready, NOT deployed

Migration 037 adds `employee_year_details` for annual profession, job title and
multiple duties; it classifies nobody automatically. The existing Administration
form exposes these facts, filters and annual history separately from participation
in teaching/cabinet schedules. Staff-only professions never create profiles.
The categories used by action plans are unchanged and displayed read-only here.

Migration 038 adds `roster_order`, the preferred display order of one year’s
four lists. It stores a position and nothing else — no membership, identity,
eligibility or access — and an absent row simply means the list is read in the
reader’s own order, so the upgrade changes nothing until somebody presses an
arrow in „Податоци“.

Migration 039 (24 September) lets the same table hold one list per therapist,
`caseload:<therapist id>` — the order a therapist reads their own pupils in.
It changes a CHECK constraint and no row; until somebody presses an arrow in
„Ученици по терапевт“ every list reads as before.

Migration 040 (24 September) adds the review queue for offline form answers
(`form_replies`, `form_reply_decisions`, docs/PLAN-formulari.md): two new
tables, row-level security on, no rights for the REST roles; no existing row
changes.

Migration 041 (24 September, late) lets a teacher's own week be a form answer:
the `form_replies.kind` check gains `'teacher'`. No row changes. 039 and 040
were already in the cloud (`8cc595e` deployed as "already current").

Migration 042 (25 September) adds the colleagues' accounts, sessions and clash
notices (`staff_accounts`, `staff_sessions`, `schedule_notices`,
docs/PLAN-kolegi-online.md): three new tables, row-level security on, no rights
for the REST roles. Its batch name in the code was
`mtb_workspace_recovery_staff_accounts_20260925`.

Migration 043 (25 September) adds the duty rota for the cabinets
(`duty_settings`, `duty_members`, `duty_days`, `duty_absences`; `lib/duty.ts`):
four new tables, row-level security on, no rights for the REST roles, no
existing row touched. The rota itself is calculated, never stored. The mirror
copies the four tables, because a read-only copy without them would show nobody
on duty.

Migration 044 (25 September, evening) adds `duty_swaps`: two colleagues trading
days, which leaves the list and the rotation alone. It is one new table, with
row-level security on and no rights for the REST roles; no existing row is
touched. The mirror copies it.

The current `deploy:workspace` runner accepts reviewed pending 033–044. Its new
private recovery schema is `mtb_workspace_recovery_duty_swaps_20260925` (044).
It is a fresh name whether or not 043 was deployed first; if 043 is still
pending, both go in together under it. 043 alone was named
`mtb_workspace_recovery_duty_rota_20260925`. Earlier: 041 under
`mtb_workspace_recovery_teacher_forms_20260924`, 040 under
`mtb_workspace_recovery_form_replies_20260924`, and
`…_caseload_order_20260924` was never used in the cloud; it preserves the earlier snapshots, `mtb_workspace_recovery_20260921` (033–036),
`mtb_workspace_recovery_staff_20260922` (037) and
`mtb_workspace_recovery_order_20260922` (038). Both 032→038 and 036→038 are
tested, including repeat no-op and preservation of original data.

**A recovery schema name belongs to ONE batch.** The runner creates it and
refuses if it is already there, because writing a second batch into it would
overwrite the snapshot taken before the first. That is why each batch above has
its own name. Reusing one shows up in the deploy log as
`Workspace upgrade refused (42P06)` — duplicate_schema — which says nothing
about the cause, so the refusal now names the schema and what to do. Measured:
the 038 deploy failed exactly this way on Render, after 037 had deployed
successfully earlier the same day.
The added business table is included in the mirror scope; source and target
must have matching schema/table ledgers. This does not activate a mirror.

Do not use a bare migration command to bypass the guarded release. A future
approved deployment must verify 38 migrations, unchanged pre-existing data,
authenticated form save/reload and staff-only exclusion from Fusion. No live
database or hosting change was made while implementing this update.

The sections below record the earlier 036 deployment; they are historical,
not a claim that the new fields are already live.

## Previous verified cloud release

Deployment verified on 22 September: commit `c04b7cf`, Render deployment
`dep-daot905g1s2s738jla10`, existing service `mtb-cloud-test`. The release log
confirmed four applied migrations, 44 unchanged original business tables and
the retained private recovery snapshot. Public health returned 200; both health
and Workspace API returned 401 without a session; the shell redirected to login.
Authenticated live UI acceptance still requires the owner's Google sign-in.
HOME's original database is intentionally still on migration 032; the new local
administration requires a separately reviewed upgrade or the mirror rollout.

Open `MTB-Workspace.html` on the selected server. Administration is the initial
view; all existing windows remain available and retain their iframe/editor DOM.
The traditional layout is available directly with `?view=windows`.

## What is implemented

- Pupil search and filters: year, class, individual grade, Internal/External,
  therapist, active/inactive. Stable public identity, full name, annual class,
  individual I–IX grade, boarding, programme and preparatory/observation placement.
- Pupil creation and annual activation/deactivation; annual class/history;
  explicit caseload assignments. No permanent person deletion. Globally archived
  pupils remain read-only pending review in the existing diary archive.
- One employee identity with multiple annual teacher, therapist, specialist and
  administration roles; optional employee identifier. Existing profile ids and
  their records remain intact. Linking is explicit, stale-checked and refused
  when both identities carry the same profile type or conflicting identifiers.
- Existing Podatoci class/subject editors, Fusion cabinet conflict checks and
  NastavaUredi teaching timetable are reused inside the same shell.
- Server-confirmed transactions, stale-write refusals, recoverable DOM drafts,
  responsive layout, read-only mirror controls, no browser business-data store.

Employee roles are not access-control roles. Teacher class/subject assignments
remain in the existing relationship editor; the legacy primary teacher kind is
not a limitation on those assignments. Existing names are not automatically split
into first and last names. Same-name pupil creation is referred to the existing
Podatoci identity-review flow. This does not implement simultaneous group therapy,
recommendation renewal, or separation of the diary's global archive coupling.

## Schema and data safety

033 is the opt-in mirror ledger, 034 adds annual pupil facts, 035 adds staff
identities and compatibility triggers, and 036 locks the new tables away from
anonymous/Supabase-authenticated Data API roles. The MTB backend connects directly
with its existing database owner connection and retains its Google perimeter.
No new browser Supabase SDK, keys, or direct-table API is introduced.

`npm run deploy:workspace --prefix server` is the reviewed 032→036 release runner.
It requires an explicitly supplied `DATABASE_URL`; it never reads a local `.env`
as a fallback. It accepts only the known migration baseline and pending 033–036.
In one locked transaction it copies the original tables and sequence values to
the private `mtb_workspace_recovery_20260921` schema, applies the migrations,
checks original-column content hashes for every existing non-ledger table and
commits only if unchanged. It neither drops nor replaces live business tables.
On failure the whole transaction rolls back and the new server does not start.
On subsequent starts at 036 it does nothing.

The recovery schema is local to the same PostgreSQL database, denied to PUBLIC,
anon and authenticated. It contains sensitive data and must never be exported to
the public repository. It is a point-in-time data recovery aid, not an automatic
restore command or a replacement for normal database backups. A rollback normally
redeploys the prior app commit; additive schema changes remain in place. Restoring
old data would discard newer work and requires a separate reviewed operation.

## Hosting

The existing Render service is used; no new service, billing plan or database is
created. Branch: `main`; automatic deployments remain off. Startup:

```
npm run deploy:workspace --prefix server && npm start --prefix server
```

Keep the existing Google login, allowed identity, origin, session secret and
database connection unchanged. Verify the release commit, migration result,
protected application access, 36 migrations, record counts and live shell.
The free Render instance can sleep; this release does not provide an uptime SLA.

## Local database sync is a separate activation

This release includes the tested opt-in Supabase→read-only local mirror code.
It does not make `therapy_dev` a mirror, activate export credentials, or install
a scheduled task. Follow `SUPABASE-MIRROR.md`: use a separate `*_mirror` database,
review the exact snapshot/plan and configure a dedicated read-only application
connection plus private pull credentials. Existing HOME/WORK databases and their
manual handover remain unchanged until that rollout. Offline mirror use is read
only, not bidirectional editing or automatic merging.

## Verification

`npm test`, `npm run typecheck`, `npm run test:workspace-admin` and
`node test/release-verification.mjs` from `server/`. The latter creates an isolated
schema, runs the real API/browser suites, then removes it and compares the live
public-table content fingerprints before/after. Tests use invented identities.
`npm run check:names` remains mandatory before publishing.
