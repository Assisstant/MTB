# Пристап за колегите

Started 4 September and verified 5 September 2026 on branch `kolegi-pristap`. This is the operational
handover for the shared sign-in, colleague-scoped schedule/caseload work and the
database-backed `AkciskiPlan.html` rollout.

## Status

The implementation and complete verification gate are green on
`kolegi-pristap`; it is **not active merely because the branch is pulled**.
Authorization remains compatibility-open until the local server has
`MTB_REQUIRE_SIGNIN=1` and is restarted. The branch is ready for code review.
The reachable history was rewritten and `main` was force-pushed on 5 September
after both current trees were verified byte-for-byte. The commit-candidate and
reachable-history name guards are green, so the rollout may be merged. GitHub
Support still needs to dereference two read-only closed-PR refs. WORK must use
a fresh clone before any pull or push.

The outcome is one shared session across the existing applications, not a new
combined application:

| Screen | Colleague work when enforcement is on |
|---|---|
| `RasporediFusion.html` | therapist edits their own annual caseload and own schedule; everybody can see cross-cabinet conflicts |
| `AkciskiPlan.html` | therapist works with pupils on their annual caseload; teacher works with pupils in their assigned annual class |
| `Podatoci.html` and other system editors | administrator only |

`RasporediFusion.html` remains the only schedule. `AkciskiPlan.html` remains the
only pupil-development-record screen.

## Permission boundary

`server/src/lib/colleague.ts` owns the authorization decision. A root
`onRequest` hook default-denies every mutating API route that is not on the
small delegated allowlist. This also makes a future write route
administrator-only until somebody deliberately classifies it.

With `MTB_REQUIRE_SIGNIN=1`:

- a therapist may write only schedule blocks/sessions addressed to their stable
  therapist id and caseload links addressed to their own therapist row;
- the legacy name-addressed schedule-slot writer is administrator-only;
- a therapist's evidence pupil set comes from the active annual
  `therapist_students` membership;
- a teacher's evidence pupil set comes from active annual `teacher_classes`,
  using the same normalized class-label comparison as teaching/action-plan
  derivation;
- sheet lists, a direct sheet read, profile/panel/examiner/contact writes,
  score writes and sheet-section reads/writes all apply that pupil boundary;
- an action-plan section remains editable by the person who holds its
  specialist category for that school year;
- changing the structure of the prescribed catalogue and changing a year's
  evidence columns is administrator-only;
- roster, teaching, state, purge and other unlisted mutations are
  administrator/service-only.

Administrator identity is kind-qualified. Configure
`therapist:<database display name>` or `teacher:<database display name>`;
the same visible name in the other directory is a different identity. An
unqualified legacy value is interpreted as a therapist only, but new
installations must use the qualified form.

### Reads that intentionally remain open

Schedule sessions, conflict information and the shared roster remain readable
to any caller that can reach the API. The login directory also remains
readable so a person can choose their identity. A colleague cannot resolve a
cross-cabinet conflict if the other booking is hidden.

Evidence sheets are different: when enforcement is on, sheet lists and direct
sheet-derived reads are limited to the therapist's annual caseload or the
teacher's assigned annual class. Administrator and service scopes are not
filtered.

This is an **operational authorization boundary**, not a promise of
confidentiality. A four-digit PIN is low-entropy. The API accepts exactly four
decimal digits and temporarily locks that identity for five minutes after five
wrong guesses, including against a subsequent correct guess. Open shared reads
still contain school information; the database is not encrypted or anonymized
by this change. Tailscale and the server's origin/network configuration remain
the real reachability boundary. Never publish the API port on the public
Internet.

## Sign-in and maintenance

`app-navigation.js` attaches the same `evidence_token_v1` session to requests
for the selected MTB server only. It never sends the token to another host.
`AkciskiPlan.html` and `RasporediFusion.html` consume the same `/me` response,
show the signed-in person and revoke the server session on logout. A transient
network failure does not erase a still-valid local token; an HTTP 401 does.

Sessions expire after the configured idle interval. Changing a PIN ends the
sessions created with the old PIN. Once enforcement is active, only the
administrator/service scope can provision a person's first PIN; after that the
person signs in and changes their own PIN from the live session. Direct proof
with the current PIN remains available only in compatibility-open mode, where
it preserves the old workflow without creating a second guessing surface in
the enforced deployment.

The local server also has an explicit top-level static-file allowlist. It serves
the approved HTML/JavaScript/image application shell and returns 404 for
`server/.env`, `.git`, migrations, scripts, documentation, backups and unknown
files. This is independent of GitHub Pages: it protects every LAN/Tailscale
client from reading private repository or machine files through port 3000.

Maintenance callers cannot use a four-digit human PIN. `MTB_SERVICE_KEY` is a
random deployment secret of at least 32 characters, accepted only through
`X-MTB-Service-Key`. `server/scripts/sync-peer.ts` reads it from the local
ignored `.env` and sends it on state writes. WORK and HOME therefore need the
same service key before either server is switched to enforced mode. Never put
the key in Git, a command-line argument, browser storage or client setup notes.

## User-facing work completed

`RasporediFusion.html` now:

- edits the selected therapist's caseload with checkboxes against the selected
  school year's roster;
- limits a therapist's schedule selector to that therapist and their selected
  pupils, while teachers are read-only and administrators remain unrestricted;
- refreshes colleague changes about every 20 seconds, without replacing an
  active editor, an open caseload modal or queued writes;
- invalidates stale polling responses when the year/session changes;
- treats the schedule API as authoritative: an overlapping booking is refused,
  reloaded and shown as a conflict rather than accepted through a browser-only
  confirmation.

`AkciskiPlan.html` now:

- filters pupils with exact grade bands `Сите`, `I–III`, `IV–VI`, `VII–IX`;
  preparatory, missing and out-of-band grades remain visible under `Сите`;
- accepts keyboard scores (`1`, `2`, `3`, `/`, `√`, `X`) and moves to the next
  row;
- auto-saves independent profile fields and panels after one second without
  collapsing simultaneous edits into one request;
- captures the sheet/pupil/year at edit time, so a delayed save cannot land on
  a sheet opened later, and flushes pending text with `keepalive` on page exit;
- links directly to the canonical schedule.

The server remains the authority. Disabled selectors are guidance, not the
security control; the API tests prove the same requests are rejected when sent
directly.

## Database and migration steps

This authorization hardening adds **no new SQL migration**. It uses structures
already introduced and ledgered by:

- `019_yearly_caseloads.sql` — annual therapist/pupil membership;
- `022_evidence_sheets.sql` — evidence sheets, scores, PIN logins and sessions;
- `024_specialist_categories.sql` — annual specialist-category ownership;
- `025_teacher_signin.sql` — teacher login/session support.

The repository currently continues through `027_schedule_source_default_api.sql`.
On HOME, the final verification found migrations 001–026 already ledgered and
applied only 027 through the repository installer. That migration changes the
default source for new schedule rows; it does not import, restore or rewrite a
pupil. Apply migrations only through the installer, which records each filename
once in `schema_migrations`; never paste or rerun an individual SQL file:

```powershell
cd C:\Users\Admin\Documents\GitHub\MTB
powershell -ExecutionPolicy Bypass -File scripts\setup-home-postgres.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1
```

The migration step is complete only when `schema_migrations` exactly matches
the filenames under `database/migrations/` and health reports a working UTF-8
database/collation. It must not import, restore or rewrite student rows.

## Safe activation order

1. Stop editing on the peer machine. Make a verified local backup with
   `scripts\backup-db.ps1`; do not restore anything.
2. Record production table counts before tests. Run the migration/health steps
   above and confirm the count has not changed unexpectedly.
3. While `MTB_REQUIRE_SIGNIN` is still unset and access is physically/network
   restricted, create or confirm the administrator's own PIN. This avoids a
   first-PIN bootstrap deadlock.
4. In ignored `server/.env` on **both** machines set values of this shape (use
   the real local directory spelling only in `.env`):

   ```dotenv
   MTB_ADMIN=therapist:<exact database display name>
   MTB_SESSION_IDLE_MINUTES=30
   MTB_SERVICE_KEY=<same random value of at least 32 characters on WORK and HOME>
   ```

5. Restart and run the complete verification gate below while compatibility is
   still open. This establishes that the rollout itself did not change data.
6. Add `MTB_REQUIRE_SIGNIN=1`, restart, and confirm `/api/health` reports
   `signinRequired: true`.
7. Sign in as the administrator and provision the remaining first PINs. Give
   each PIN to its person through a private channel; do not record it in Git.
8. Smoke-test one therapist: own schedule/caseload/evidence succeeds; another
   therapist's write gets 403; a signed-out write gets 401. Smoke-test one
   teacher against an assigned class. Run a peer-sync dry run so the service
   key path is exercised before allowing live edits.
9. Repeat on the peer machine and compare the same table counts after the test
   fixtures have cleaned themselves up.

Rollback is immediate and non-destructive: remove/set
`MTB_REQUIRE_SIGNIN=0` and restart. That restores compatibility-open behavior;
it does not remove PIN hashes, sessions, catalogue rows or pupil records.

## Verification gate

From `server/`, with the normal local test database/server selected:

```powershell
npm run typecheck
npm test
npm run test:evidence
npm run test:categories
npm run test:colleague
npm run test:fusion
npm run test:fusion-ui
npm run test:evidence-ui
npm run test:navigation
npm run check:names
```

Record counts for `school_years`, `students`, `therapists`,
`therapist_students`, `schedule_slots`, `evidence_sessions` and
`evidence_sheets` before and after. The final counts must match except for an
explicit, explained application change; these suites use invented fixtures and
must clean them up. Never inspect, print or paste real pupil rows into a report.

Final verification captured on HOME on 5 September 2026:

- `npm run typecheck` and `npm test` — passed, 90/90 unit/contract tests;
- `npm run test:evidence`, `test:categories`, `test:fusion` and
  `test:colleague` — passed; the colleague suite completed all 38 checks,
  including exact-PIN validation and five-guess lockout;
- `npm run test:evidence-ui`, `test:fusion-ui` and `test:navigation` — passed in
  real Chromium browsers;
- live static checks returned 200 for the approved application files and 404
  for `.env`, `.git`, local roster JSON, migrations and `AGENTS.md`;
- the before/after counts were identical:
  `school_years=2`, `students=100`, `therapists=10`,
  `therapist_students=440`, `schedule_slots=438`, `evidence_sessions=0`,
  `evidence_sheets=1`; the only ledger change was migration 027, for a final
  total of 27 migrations;
- `npm run check:names` inspected the index, changed working copies and
  untracked non-ignored commit candidates, and found no local database name.
  After the rewrite, `npm run check:names -- --history` also found none in any
  reachable branch blob. Two read-only closed-PR refs remain for GitHub Support
  to dereference; no matched name was printed.
- the vulnerable npm-registry `xlsx@0.18.5` package was replaced with the
  official SheetJS `0.20.3` tarball while keeping the existing import API.
  An invented workbook round-trip, typecheck and the full unit suite pass;
  `npm audit --omit=dev` now reports 0 vulnerabilities.

The implementation and privacy rewrite are ready for merge. GitHub Support
cleanup of the two closed-PR refs and enabling enforcement on a real shared
server are separate operational steps; activation must follow the order above.

## Public consequence

Merging publishes the HTML/JavaScript implementation on GitHub Pages, so the
public will be able to see how the application works. It does **not** publish
the local PostgreSQL database, `.env`, service key, PIN hashes, backups or
student records. `npm run check:names` is mandatory because code being public
is exactly why no real names may enter fixtures, comments or documentation.

The practical benefit is narrower damage from mistakes or misuse by an
authorized colleague: they can perform the two shared tasks assigned to them
without changing somebody else's timetable, the school roster or the
prescribed form. It does not turn a local operational system into a hardened
public records portal.
