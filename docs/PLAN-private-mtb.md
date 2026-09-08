# MTB: private access, two offline PCs, one colleague workflow

Decision and readiness note, 7 September 2026. This is the next-work plan, not
evidence that private hosting, colleague enforcement or a database transfer has
been activated. The product rules remain in [APP-CONTRACT.md](APP-CONTRACT.md).

## Update from the owner's explanation — 8 September

The personal S-Dnevnik is already useful and tested. Preserve its daily work
while the newer shared screens are developed. The concise user map is now in
[README.md](../README.md); the domain distinctions are in the existing
[application contract](APP-CONTRACT.md#domain-clarified-by-the-owner--8-september-2026).

Implemented locally from this explanation:

- External pupils can retain an explicitly assigned local class/group in
  Podatoci, creation/update APIs and annual reselection. Changing `kind` alone
  no longer erases it; omission preserves the annual assignment and explicit
  blank/null removes it. No migration or real pupil reclassification was run.
- Teaching crossing already accepted external pupils with a class. Corrected
  its misleading therapy-only explanation and verified that assigned external
  pupils appear against their teaching. The view reports planned overlap,
  never proof of actual attendance.
- AkciskiPlan opens records for existing pupils. Its duplicate pupil-creation
  flow is replaced by the administrator directory link, keeping server/year.
- Fusion labels the split as consecutive 20-minute treatments and explicitly
  states that simultaneous group treatment cannot yet be entered.

Remaining domain work, in dependency order after the installation/handover gate:

1. Separate personal diary archival from shared school/service eligibility.
   The legacy projection still sets global `students.active`; annual membership
   already has its own flag. Preserve records and compatibility, and test both
   writers before changing either. This can affect who colleagues can select.
2. Correct Nastava's identity and historical reads before calling it a complete
   pupil-location tool: its aggregation still uses names, and global `active`
   filters historical rows. Also, the teacher view can sum several classes but
   open details for only the first. Use same-name and multi-class fixtures.
3. Model annual teaching programmes and service recommendations independently
   of `kind`, including continuing/new/ended eligibility. A prior-year suggestion
   must not become evidence of renewal. Review actual labels locally; do not
   infer them from a name or missing grade.
4. Distinguish staff role/profile from treatment participation and room use.
   Current roster reads include all active entries in the therapist directory;
   zero sessions do not automatically hide administrative associates.
5. Add explicit sessions/participants for simultaneous groups or parent work.
   Preserve per-pupil time conflicts and old exports; 20 + 20 is sequential.

PCW was awakened and reached over Tailscale during this session. Its private
HTTPS and API ports refused connections, and no SSH/WinRM channel was available.
Therefore network reachability is verified, but the installed API, current WORK
database and pCloud receipt still need an on-PC diagnostic. Do not label them
synchronized because Tailscale ping succeeds. No Windows access policy was changed.

Validation for this update: typecheck; 100 unit tests; 610 checks across roster,
annual roster, teaching API, Podatoci, Fusion API/browser, navigation, colleague
authorization, evidence API/browser and Nastava browser suites. All used a
disposable schema and separate API. Before/after content hashes for all 44
public tables, plus sequence counters, are identical; the schema was removed.
Evidence is local under ignored `backups/domain-qa/`.

The initial unit run exposed a test-isolation defect: projection tests put
their schema in Pool.options, but an inherited DATABASE_URL options parameter
overrode it. Migrations reached the already-migrated disposable harness schema
and stopped. The test now places its override in the URL and asserts the actual
schema before any migration. Only the failing unit suite was rerun after that
fix; it passed and the public-data proof remained unchanged. No application
migration or data repair was needed.

## Reconciliation of the overlapping conversations

The user shared the conversations to explain one connected, unfinished project,
not to request every old proposal again. This note is the single current work
queue. Older plans and chats explain decisions; their commands and completion
claims must be checked against today's checkout and the relevant live machine.

Reviewed on 7 September: the recent relevant turns of the tasks below, the
shared sync conversation, the two attached proposals and the current source.
This is not a claim to have audited every turn or the other PC.

| Discussion | What survives in the current project | What must not be restarted from that discussion |
|---|---|---|
| **Implement Podatoci CRUD management** | Annual school lists and annual caseloads exist in migrations 018 and 019 and the current directory APIs. | An old "not committed" answer describes that moment, not today's source. Do not create a second set of year-membership tables. |
| **Finish AkciskiPlan rollout** | This task grew to include evidence, shared PIN sign-in, Fusion pupil selection and permissions, and the static-file boundary. That code is already integrated in the current source. | "Implemented and tested" does not mean permissions are enabled on either live PC. HOME enforcement is still off. The inspected support-request attempt has no confirmed ticket receipt. |
| **Создавање RasporedFusion копија** | Keep the useful goal of a clear, database-backed cabinet schedule. The current contract already defines its features. | Work described in a temporary workspace is not proof it reached this clone. Do not introduce a second schedule app or reinstate the older strict-40-minutes-only proposal; the contract retains ordered 20-minute halves. |
| **File syncing chat** | The screens should share pupil identity, annual relationships, navigation and server access while keeping distinct purposes. | The old assumption that the data is disposable demo data is false for today's HOME. A shared assessment engine is a future proposal, not required for rollout. |
| **Check MYB sync status** / **Sync PCs Across Tailscale** | Code transfer, network reachability and database transfer need separate checks. Verified snapshot files are useful recovery evidence. | Neither a successful Git pull nor an older snapshot proves that today's two databases agree. Do not pull pre-history-rewrite WORK history into the cleaned repository. |

Current code evidence: [annual rosters](../database/migrations/018_annual_rosters.sql),
[yearly caseloads](../database/migrations/019_yearly_caseloads.sql),
[the canonical schedule](../RasporediFusion.html),
[colleague authorization](../server/src/routes/evidence-auth.ts) and
[the static allowlist](../server/src/lib/public-static.ts).

The architecture picture also describes an earlier state. S-Dnevnik already has
an explicit `seedScheduleFromDatabase` action that reads `/api/schedule/sessions`
and asks before replacing its live template. Therefore "no connection" is no
longer accurate; this is a deliberate import, not continuous synchronization.
Its name-based identity fallback still needs review against the no-ambiguity
rule before this action is treated as a verified colleague workflow. Do not
infer completion from the presence of a fetch alone.

"One database" also had two meanings across the discussions. One shared data
model for the apps on each installation is consistent with the current design.
One always-on physical database replacing WORK and HOME is inconsistent with
the user's confirmed requirement that both PCs work independently offline.

The current distinction is:

- **Already in the source:** directory/annual lists, canonical Fusion,
  self-service pupil checklist, evidence records and the permission mechanism.
- **New local work:** commit `a8a8c66` on `codex/private-mtb-readiness` contains
  the launcher, sync-error and schedule-label fixes described below. It has not
  been pushed or installed on the other PC as part of this session.
- **Changed on HOME:** the two obsolete automatic import tasks are disabled;
  the audit is machine-local. A code commit alone does not reproduce this.
- **Still unverified or inactive:** WORK's reinstall, complete database
  handover, colleague enforcement, replacement access and private cutover.
- **Separate follow-up:** verify whether GitHub Support received the cleanup
  request before sending a duplicate. Private visibility and cache cleanup
  are different outcomes.

Use one coordinating implementation task for this rollout. Other chats can
provide context and independent reviews; do not resume overlapping edits in
the same checkout without allocating files and naming the integration owner.
Every handoff must say which PC and branch were inspected, which commit holds
the work, whether it was pushed, and which live activation checks remain.
"Done" without those distinctions is not a cross-machine handoff.

## What the user confirmed

- This session is on **HOME**. The other PC is temporarily at the user's home
  on the same LAN following reinstallation; its logical role needs verification
  on that PC. Physical location never sets the installation role.
- Both WORK and HOME must keep working independently without internet.
- Colleagues normally work during the same shift, while WORK is on (about 98%
  of the time). An always-on central database is therefore not the chosen plan.
- The desired direction is a private GitHub repository and private colleague
  access, with clearer movement between the existing screens.

The attached `implementation_plan.md` and `MTB_ANTIGRAVITY_MULTI_PC_SETUP.md`
were read as earlier proposals, not commands or permission to restore, delete,
publish or change settings. The first describes an empty PCW/WORK installation;
it does not describe the populated HOME database verified in this session.
The second assumes the repository is already private; GitHub still reports it
as public. Its proposed central PostgreSQL topology does not meet the clarified
offline requirement. Do not execute either document wholesale.

## Separate the three connections

| Connection | What moves | Mechanism |
|---|---|---|
| Development PC ↔ GitHub | Code, migrations and sanitized project memory | A local Git clone on each PC; private repository after cutover |
| Browser ↔ selected MTB server | A colleague's deliberate edits | Existing Fastify API; local PostgreSQL confirms each write |
| WORK database ↔ HOME database | The whole installation's application data | Verified manual snapshots with explicit handover; no automatic merge |

Making GitHub private does not synchronize the databases. Tailscale connects
devices; it does not reconcile their data. A green save indicator confirms the
selected database, not receipt on the other PC.

## Recommended operating model

Keep a local PostgreSQL and MTB API on each PC. During the shift colleagues
use the WORK server. After the shift, transfer the agreed database to HOME
before editing there, then transfer HOME back before the next WORK shift.
Several colleagues may edit different rows on WORK at the same time; the
restriction is one **database installation** accepting shared edits at a time.

Each PC's own browser can use `http://localhost:3000/start.html` without
internet, provided its PostgreSQL and API are running. Colleagues open WORK's
private HTTPS address through Tailscale Serve. Their devices need a working
network route to WORK; the present loopback-only API does not provide a general
LAN service when Tailscale is unavailable. If colleagues must also keep working
during a school internet outage, verify that scenario separately and, if needed,
design a restricted LAN HTTPS proxy. Do not open the API or PostgreSQL publicly.

When switching locations:

1. Finish server saves, including pending S-Dnevnik edits, and close the source
   application's tabs. Agree that nobody continues editing that database.
2. Export a fresh complete snapshot from the source. Let all pCloud files
   finish transferring; a ready/checksummed snapshot is the transfer unit.
3. On the destination run Compare. Inspect content differences, migration
   compatibility and whether the destination has its own unreturned changes.
4. Only when replacement is deliberate, accept the exact displayed snapshot
   id with the existing safety-backup workflow. An old command in a handover
   document is never authority to select today's winning copy.
5. Reopen the destination apps, resolve any pending local diary state before
   loading, and verify the installation label, school year and saved data.
6. Reverse the procedure before the next shift if HOME was edited. If HOME
   was only read, no hand-back is needed.

Use [MANUAL-DB-SYNC.md](MANUAL-DB-SYNC.md) for the commands. Never use a legacy
JSON transfer as proof that the newer relational records have synchronized.
Never synchronize PostgreSQL's physical data folder.

The remaining 2% needs an explicit rule: if both installations changed, preserve
both, stop acceptance, compare and decide what to re-enter. Current snapshots
cannot combine their work. Local numeric identities and cross-cabinet time
conflicts make a generic row merge unsafe. Timestamp order does not solve it.
The handover rule is operational today; there is no cross-PC editing lock.

If overlapping offline editing becomes necessary, create a separate sync
project: portable identities for every synchronized entity, a durable change
log committed with each write, idempotent delivery and acknowledgements,
per-record base versions, deletion/archive semantics and a conflict inbox.
Recheck pupil/time overlaps after reconnection, even for different therapists.
No disconnected system can guarantee that another disconnected PC has not
booked the same pupil. Preserve exports and the current manual path until
reconnect, retry, concurrent-edit and recovery tests prove a replacement.

## Private hosting without GitHub Pages

The existing MTB server already serves the app HTML and API together. There is
no requirement to rewrite the apps or buy a public hosting service.

- Keep source and shared development notes in the private GitHub repository.
- Serve the allowlisted apps from each PC's existing MTB server.
- Use Tailscale **Serve** for private HTTPS access. Funnel is public exposure
  and is not part of this design. Network access and application permissions
  are separate controls.
- Give colleagues their own approved Tailscale identities/device access; do
  not share the administrator's personal login. They need neither a GitHub
  account nor Node/PostgreSQL nor a source checkout to use MTB.
- Keep the server's static allowlist. Documentation and backups must stay
  unreachable through its HTTP route. Open architecture documentation from
  the private repository or a local file.

GitHub can publish Pages from a private repository on eligible paid plans,
but that does not make the resulting site private. Private Pages access control
requires an organization using GitHub Enterprise Cloud. That is unnecessary for
this architecture. Sources checked 7 September 2026:
[Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages),
[private Pages access](https://docs.github.com/en/enterprise-cloud%40latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site),
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

Cutover order:

1. Complete the offline-launcher repair and validate local/private app access
   on both installations, including one real colleague device at WORK.
2. Preserve pending diary work at every previously used browser origin. Export
   it locally if necessary; never clear browser storage just because a new
   address looks empty. IndexedDB is specific to the origin, so GitHub Pages,
   localhost and the private HTTPS address have different local copies.
3. Replace everyday GitHub Pages bookmarks with WORK's private launcher on
   colleague devices and the local/private launcher on HOME. Test with Pages
   unavailable and test local operation without internet.
4. Confirm private Git authentication on both development PCs and review the
   concrete interruption of the old public bookmark with the owner.
5. Unpublish the public Pages site and change the repository visibility to
   private. Verify both separately while signed out; neither change is a
   substitute for the other. Keep the already-tested private app route working.
6. Recheck clone access, startup pulls and scheduled task paths after the
   visibility change. If a code pull fails offline, the already-installed
   tested application must remain available.

No visibility change was made in this session. The connected GitHub tool can
read repository metadata; the local `gh` CLI has no authenticated session.
Account administration must be completed through an authenticated owner session
after the replacement access path is verified. Making the repository private
also does not retract existing clones or public caches; the previously recorded
GitHub Support cleanup remains a separate follow-up.

## The colleague journey

**Најава → Распоред на кабинети → Ученици по терапевт → Измени список →
Зачувај список → Распоред.** The checklist already exists in Fusion.

| Task | Screen and owner |
|---|---|
| Add a person to the school year, correct a name/class, assign a professional category | Administrator in Податоци |
| Choose which existing pupils I work with this year | Therapist's checklist inside Распоред на кабинети; same annual relation as the administrator view |
| Place sessions and see pupil/time conflicts across colleagues | Распоред на кабинети, in `RasporediFusion.html` |
| Record actual attendance, the personal week and clinical diary | S-Дневник, still the owner's personal tool |
| Collaborate on the pupil's prescribed record and action plan | Евидентен лист in `AkciskiPlan.html` |
| Inspect missed lessons / edit the school timetable | Настава / Уреди настава |

Keep existing files and storage formats. Forty and twenty minutes describe the
slot rules, not the product's name. The recurring schedule is not the diary's
dated working week. A professional category is not a room; the current grid's
columns identify therapists, and physical room allocation is not modeled.

Removing a pupil from the checklist removes a membership link; existing booked
sessions remain until explicitly changed. Missing people belong in the school
directory, not in a second quick-add system inside the schedule.

Before colleagues are onboarded, follow the existing
[activation order](PLAN-kolegi-pristap.md): bootstrap the administrator PIN,
configure the kind-qualified administrator and shared service key locally,
verify compatibility mode, enable `MTB_REQUIRE_SIGNIN=1`, provision colleagues
and test their actual permissions. Do not flip the flag before bootstrap.
HOME currently has enforcement off; checking the source is not activation.

Therapists' own schedule/caseload writes and evidence access are checked in the
API, not just by disabled controls. Shared rosters and schedule reads stay
visible to callers with network access. Because a therapist can select pupils,
that selection also expands their evidence scope. The present model provides
operational permissions; it is not an administrator-approved confidentiality
partition between pupil records. The four-digit PIN does not replace private
network access.

## What was actually verified on HOME

Read-only audit on 7 September; the machine-local baseline lives under ignored
`backups/runtime-audit/`. It contains hashes and aggregate counts, not a public
pupil report.

| Check | Finding |
|---|---|
| Source checkout | Based on `7ad9cdf`; hooks use `.githooks` |
| Installation identity | `SYNC_NAME=home`, matching the user's answer |
| Database/API | PostgreSQL 18.6, `therapy_dev`, healthy local API, Cyrillic case conversion correct |
| Migrations | All 27 repository migrations applied |
| Application data | Populated, with schedule work added on 7 September; not the empty PC in the attachment |
| Colleague enforcement | Off; administrator and service-key configuration absent |
| Local backup | 6 September dump readable by `pg_restore --list`; this is archive readability, not a restored-data drill |
| Shared snapshots | Latest observed HOME publication 5 September; WORK publication 2 September with only 21 migrations |
| Snapshot freshness | HOME has later changes; WORK's old publication cannot verify the current live WORK PC |
| HTTP file boundary | Approved app shell 200; configuration, Git metadata, docs, backups and migration paths 404 |
| GitHub | Repository public; Pages enabled; local `gh` not signed in |
| Private networking | HOME's configured HTTPS health responds; Serve proxies loopback; Funnel disabled |
| WORK access | Configured WORK HTTPS endpoint timed out; the reinstall may have changed its address |
| Scheduled transfers | Found two automatic legacy `-Apply` tasks every two hours; disabled both after preserving their definitions locally |
| Scheduled backups | Existing weekly local backup and server tasks retained; manual snapshot publisher still needs installation |

The current setup checker needs separate repair: `verify-setup.ps1` assumes a
database instead of reading `DATABASE_URL` and checks an old table set. A green
run of that checker alone cannot certify this installation. No setup installer,
restore, roster import or scratch-database deletion was run for this audit.

`TherapySyncPeer` and `TherapySyncMailbox` are now disabled, not deleted.
Their original XML definitions are in ignored
`backups/runtime-audit/disabled-legacy-tasks-2026-09-07/`. Manual commands still
work, and the existing local backup/server tasks were not modified. After WORK
is verified, preview and install the existing `-ManualDbSync` task mode to add
the weekly snapshot export; it must never automatically accept the peer.

The user's shared conversation was read as context. It describes a previous
restore, a checksummed September snapshot and differing legacy mailbox content;
it does not establish current live database equality or authorize a new import.

## Changes and validation in this branch

- Fusion is presented as **Распоред на кабинети**, explains the existing
  pupil-checklist journey, and sends caseload errors back to that checklist.
  Print/image labels agree. No schedule data model or write API was changed.
- The launcher probes its own local/private API even when all configured peer
  addresses are offline. Aliases of the same running server are deduplicated
  by the API's random instance id, never by the Windows hostname. Two distinct
  servers still require a deliberate choice. The no-server recovery path no
  longer dereferences a removed legacy entry.
- Legacy sync counts transport/database/file failures separately from safety
  refusals. The wrapper no longer recommends Force for an operational failure
  or claims another app could not have changed during a partial run.
- The rollover test now creates its own schema, including its sequences, and
  removes it after the run. Its old transaction rollback protected rows but
  still advanced live ID counters. The audit caught that distinction.

Validation: typecheck; 100 unit/contract tests including ten new offline sync
tests; 33 Fusion API checks; 60 Fusion browser checks; 72 navigation/launcher
checks; 38 colleague API checks in compatibility and enforced modes; the
names guard; live static-route checks. Browser/API suites used a disposable
schema and separate loopback server, with fixture cleanup confirmed. The
desktop and phone layouts were inspected using that empty test installation.

All 43 application tables retain their original counts and content hashes,
including historical schedules. The initial full-suite run advanced the
rollover test's public ID counters despite rolling back its rows; counters
were not reset. While isolating that test, a first attempt used `SET LOCAL`
across migrations that commit their own transactions. It stopped at migration
016, after 015 had re-established its existing public view/constraint. No
application rows changed. The corrected test uses a persistent schema search
path, applies migrations there and cleans its schema explicitly. The temporary
schema left by the failed attempt was removed. The final passing suite left the
post-counter-change database fingerprint unchanged, with no test schemas left.
This is recorded in the
ignored before/after proof, rather than claiming the entire session's original
sequence-inclusive fingerprint never moved.

Remaining validation: WORK's live setup, real colleague-device connectivity,
reboot/Internet-disconnection smoke tests and a full backup restore rehearsal.
No whole-database acceptance or GitHub privacy cutover was attempted.

The architecture diagram is useful context, not the task list. Its missing
calendar arrow is not a reason to put diary calendar rules in Fusion; the
contract deliberately separates those purposes. Its source JSON still mentions
an obsolete holiday count. The schedule-projection protection described as
urgent in the older schedule plan is already present in `import-core.ts` and
covered by a regression test. Verify code before reopening old proposed work.

## Ordered next work and acceptance

1. **Completed locally; integration pending:** the schedule journey, offline
   launcher, sync failure reporting and isolated regression checks are in
   `a8a8c66`. Carry this reviewed branch forward; do not redo these changes from
   an older chat. No private cutover or full database acceptance has happened.
2. **Next gate — verify WORK:** use [OTHER-PC-AUDIT.md](OTHER-PC-AUDIT.md) in
   Codex on that PC. Inspect its active fresh clone, local role, migration
   ledger, live counts, network access and backup. Establish the source version
   before integrating this branch. A stale shared snapshot is not enough.
   Test server startup after reboot and with internet disconnected on each PC.
3. **Prove the handover:** preserve both live copies, rehearse a backup restore,
   then use a fresh snapshot, complete transport, compare, exact acceptance and
   destination fingerprint verification during agreed downtime. Reverse after
   a deliberate small edit. Any independent destination work stops replacement
   until a human resolves it. Only then adopt this as the daily shift routine.
4. **Onboard one colleague:** activate the documented boundary and complete
   checklist → schedule → refresh with two distinct identities. Own edits must
   persist; another colleague's writes must fail; cross-cabinet conflicts must
   remain visible. Then onboard the rest.
5. **Private cutover:** follow the ordered hosting checklist above; verify a
   colleague can work while the old public site is unavailable.
6. **Next UX pass:** test real tasks with a colleague before a visual redesign.
   Focus on finding the list, unscheduled pupils, visible save feedback and
   recovery after refusal. Keep school setup secondary and diagnostic tools out
   of the everyday journey. Do not create another schedule app.
7. **Optional sync upgrade:** add visible handover receipts and destination-change
   checks before considering automatic acceptance. True concurrent offline sync
   is a separate larger project, required only if the shift handover cannot hold.

For development between PCs: use one local clone per PC, explicit files in each
commit, the name guard, and `git pull --ff-only` only with understood local work.
Keep AGENTS.md and CLAUDE.md aligned. Link this note instead of creating another
parallel set of canonical context files. Never bring pre-history-rewrite refs
back from an old WORK clone.
