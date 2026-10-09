# MTB — handover and review request for Opus 5.5

Prepared: 9 October 2026.
Repository: `Assisstant/MTB`.
Windows checkout: `C:\Users\Admin\Documents\GitHub\MTB`.
Latest application commit inspected for this handover: `85b6f1e`.

**Update incorporated before delivery:** three newer commits arrived from
WORK while this document was being prepared. The current decision is
**cloud-only daily work**, the cloud backup script now exists, and exercise
tiles require dragging. These supersede parts of the earlier offline proposal
and UX description. Their reported checks are distinguished below from this
agent's own earlier test runs.

## Request to Opus

Please independently review the proposed changes to local/offline/cloud work
and the recent application changes described below. Explain your conclusions
to the owner in clear Macedonian. Separate confirmed defects, design tradeoffs,
and things you could not verify. Do not treat the previous agent's conclusions
or reported test results as your own verification.

The owner requested a plan for local/offline work and has not requested its
implementation in this handover. Start with read-only inspection and a concrete
recommendation. The review should help decide what to implement first, not
silently change databases, installed tasks, shortcuts or deployment settings.

Read `SOSTOJBA.md` first, then `AGENTS.md`/`CLAUDE.md`,
`docs/APP-CONTRACT.md`, `docs/PLAN-online-offline.md` and
`docs/SUPABASE-MIRROR.md`. For the exercise changes, also read `docs/VEZBI.md`.
Check current Git state before assuming this handover still describes HEAD.

## 1. Main topic: local work, cloud data and offline recovery

The earlier request considered current information on computer and phone,
offline reading and eventual offline attendance. The newer 9 October decision
in `docs/APP-CONTRACT.md` is to use only the cloud now. Treat offline work as a
later separate project, not the current default or an approved rollout.

The attached proposal previously named `MTB_Online_Offline_Tasks.md` suggested
changing launchers, archiving the old local database, regular mirror refresh,
full cloud backups, offline browser caching, a durable operation queue and
emergency local-server operation. Its account of the machines was historical;
it was explicitly a plan, not a verified inventory or implementation report.
The revised repository plan is `docs/PLAN-online-offline.md`.

### Existing architecture and decisions

- Cloud/Supabase is the only source used for normal daily work under the latest
  owner decision. Local-server and mirror tools are under „Не се користи“.
- `therapy_dev` is still a deliberately writable local fallback. The owner's
  23 September decision says local work is manually re-entered in the cloud.
  It has not been converted into a read-only archive by these changes.
  Its installed capability remains, but it is not part of the working routine.
- A separate `*_mirror` database is for reading. It is not a full backup and
  not an independent writer whose rows may simply be merged back into cloud.
- On 7 October the owner chose comparison first, then an explicit decision
  before applying a mirror refresh. Automatic application would change that.
- Local and cloud numeric IDs can collide. Do not infer identity from them.
- Browser storage is separate for each origin. Cloud and localhost do not
  share IndexedDB; a phone's localhost is not the computer's server.
- S-Dnevnik already uses IndexedDB, agreement fingerprints, server versions
  and `planMarkMerge` for nonconflicting attendance marks. This is not a blank
  slate. Other records must not automatically inherit the marks' merge rule.

### What the code review established, and its limits

| Area | Evidence in the repository | Still needs live verification |
| --- | --- | --- |
| Normal launcher | Record tiles in `scripts/mtb-actions.ps1` use `MTB_CLOUD_URL`. | The targets of shortcuts actually installed on each PC. |
| Start procedure | `scripts/procedures/start/50-open.ps1` uses `MTB_OPEN_URL`, otherwise a local workspace. | Each machine's effective setting, without exposing secrets. |
| Mirror | `server/src/lib/mirror.ts` and `scripts/mirror-refresh.ps1` provide explicit scope and guarded application. | Source identity, last successful application, migrations and freshness on HOME/WORK. |
| Backups | New `scripts/cloud-backup.ps1` dumps cloud `public`, including accounts, reads the archive index and copies to pCloud. The launcher reminds after a week. The older stop procedure still backs up the local database. | Successful scratch restore, dependencies outside `public`, actual installation on HOME, and any scheduled jobs. A reminder is not an automatic backup schedule. |
| Browser offline start | No service-worker registration was found in the main workspace/diary during the earlier targeted inspection. | Verify the complete delivery path and cold reopening offline. An already-open tab is not sufficient evidence. |

Neither live installation was comprehensively audited during the UI work.
Do not repeat “21 commits behind” or a historical mirror table count as a
current measurement. Git updates transfer code, not attendance or diary data.

### Suggested order — evaluate this critically

The immediate recommendation is to verify the cloud-only entry points and
prove restoration of the existing cloud backup. Steps 3–5 below are future
options, to assess only if the owner returns to the offline project. The older
`docs/PLAN-online-offline.md` predates the incoming cloud-only clarification;
read it with the current product contract, not as overriding instructions.

1. **Inventory and clear entry points.** Inspect both machines, protect unique
   local entries, and make the data source and save status unambiguous. Avoid
   rebuilding the cloud tiles that already work. Do not silently fall back
   from an unavailable cloud to a different writable database.
2. **Full cloud backup and a demonstrated restore.** Inventory what mirror
   omits, including access/configuration dependencies. Restore into an isolated
   scratch database and verify relationships, sequences, diary and access.
   Move this proof BEFORE new offline writes, not to the end of the project.
3. **Offline browser opening and reading.** Cache the required application
   resources deliberately; separate account/workspace/year data. Show when
   the copy was last confirmed. Define logout, expiry, upgrade and storage-full
   behavior. Do not broadly cache authenticated API responses as static files.
4. **Offline attendance in the owner's personal diary first.** A local edit
   and its operation must commit in one IndexedDB transaction. Server receipt,
   validation, revision check and write must be atomic. Duplicate delivery
   must not duplicate the write; conflicting data must remain visible.
5. **Later expansion.** Notes and other clinical records require their own
   identity and conflict rules. A writable emergency local server with safe
   return to cloud is a separate later project, not necessary for the first
   browser-offline attendance release.

Please pay particular attention to these architectural questions:

- Can the existing attendance merge safely cover more of the requirement
  before introducing an operation API? Where exactly does it fall short?
- What is the stable identity of an attendance mark after pupil merges,
  timetable changes and school-year changes?
- How will one fact have one write authority while old whole-document saves
  and new row operations coexist? A new API must not bypass existing rules.
- How will retries work when the server saved but the response was lost,
  or two tabs send the same queue? What happens to dependent edits of one mark?
- What constitutes confirmed cloud success, locally saved work, a conflict,
  and a session requiring sign-in? None should be reported as the other.
- Which changes would actually require revising the owner's existing local
  fallback or mirror policy? List those decisions explicitly, not as bugs.

The earlier proposal suggested 7 daily and 4 weekly backups. The newly
implemented script instead defaults to the newest backup per day for 30 days
locally and 7 days in pCloud. Review that actual policy rather than assuming
the proposal was implemented; do not change retention or delete archives in
this review. The script's archive-index check is not proof of restoration.

## 2. Recent implemented changes — review separately from the offline plan

These application commits were pushed to `origin/main`. No Render Manual
Deploy was performed by the previous agent; the live deployed revision remains
to be verified. No local/cloud database conversion was performed.

| Commit | Change |
| --- | --- |
| `b3cdf15` | Clear diary/group-schedule comparison directions; no preselection or both-sides clearing. Fix blocked future-plan promotion, intentionally empty historical weeks and duplicate progress after pupil merge. |
| `596645e` | Run the schedule comparison's phone-layout check without requiring screenshot mode. |
| `64f2b2d` | Offline Macedonian Marija audio, per-term uploads/recording, mute and audio-pack transfer for Vezbi. |
| `3bf9e3f` | Persistent speech speed 0.5–1.5×, retaining pitch and original downloadable files. |
| `1eb94a6` | Stable completion rewards, explicit repeat, calm mode, ComuniBoard drag/undo corrections, and the offline plan document. |
| `33e8356` | Owner follow-up: exercise tiles fill a box only by dragging; clicking, tapping or Enter on a tile does nothing. Keyboard keys still type on tap. |
| `2958bb8` | Cloud-only routine; launcher favourites/reminders and unused-tools tab; explicit cloud backup script. |
| `85b6f1e` | Teaching poster shows subjects beneath classes; PDF poster output on sixteen A4 sheets. Peripheral to this handover's local/offline focus. |

### Important distinction: Vezbi versus ComuniBoard

The owner's “cards jump when completed” report concerned the shared exercise
experience. The actual completion bug was in `vezbi/index.html`: `.card.pop`
collided with the toolbar's `.pop` class, taking successful cards out of layout.
ComuniBoard itself is a free board; it does not grade completed spelling cards.
Do not add a second spelling/reward system there by mistake.

Implemented behavior:

- A completed exercise card turns slightly in place for 800 ms, highlights
  softly and shows a star. It returns to its original position. Only the
  changed card is refreshed; sibling DOM and page scroll are retained.
- Keyboard space remains after the last letter, preventing a layout jump.
- During spelling, picture taps replay pronunciation. Explicit ↺ clears only
  that card; the existing help controls change difficulty. Opening a card
  large from the grid and browser Back still work.
- “Без анимации” persists locally; system reduced-motion also leaves a static
  star. There is no score, countdown or automatic advance to another card.
- Newer owner follow-up: letter tiles must be dragged to their box. Do not
  restore tap-to-fill as a generic usability improvement. The onscreen and
  physical keyboards still type; the upstream note says that scope was read
  narrowly and may need clarification if the owner meant those keys too.
- In ComuniBoard, letter/image/card dragging starts after 8 px of movement.
  Undo records the position before moving, not after. Undo/Redo schedule
  autosave. Existing multi-selection, snapping and touch translation remain.

Suggested checks: partial and final letters, duplicate letters, wrong-letter
hints, rapid inputs, pointer cancellation, keyboard focus, small phone screens,
long words/sentences, closing the keyboard, reset after completion, animations
disabled mid-reward, multi-drag, snap followed by Undo, and autosave after Undo.
These are review targets, not a claim that each currently fails.

Audio review targets: replacement precedence, mute during playback/loading,
rate changes, failed uploads without losing a good recording, microphone
cleanup and offline file opening. The 984 unique synthetic MP3s cover 986
entries across 26 sounds; individual pronunciation was NOT fully reviewed by
the therapist. Do not claim clinical/linguistic validation from playback tests.

## 3. Validation evidence and commands

The previous agent reported these passing after the relevant changes:

- `npm run test:vezbi` — exercise/ComuniBoard/WBACC integration and layout.
- `npm run test:vezbi-audio` — 31 checks.
- `npm run test:vezbi-feedback` — 31 checks, including a control that reproduces
  the former popup-class displacement and actual drag/Undo/Redo/autosave.
- Public-name and document-index pre-commit checks.
- Desktop and phone screenshots were visually inspected.

Those runs describe application state through `1eb94a6`. Incoming commit
`33e8356` updates the feedback suite to 34 checks and real touch dragging;
the WORK notes report it passing. This handover session has **not** rerun that
newer suite. The cloud-backup and poster validation notes in `SOSTOJBA.md`
are likewise reports from WORK, not this agent's independent verification.

Run relevant checks yourself from `server/` and report what YOU ran. The 388
base-test result belongs to the earlier schedule/audio work, not a fresh run
after every later UI commit. Browser checks use a file-only local test server
and invented/generated content; they do not require production data.

Useful read-only starting commands from the repository root:

```powershell
git status --short
git log -12 --oneline
git show --stat 1eb94a6
git diff 3bf9e3f 1eb94a6 -- ComuniBoard.html vezbi/index.html server/test/vezbi-feedback.browser.mjs
git show --stat 2958bb8
git diff 1eb94a6 85b6f1e -- docs/APP-CONTRACT.md docs/VEZBI.md scripts/cloud-backup.ps1
```

Local-only artifacts, not committed: screenshots under
`backups/qa/vezbi-feedback/`, the MP3 package under `backups/vezbi-audio/`,
and `backups/Vezbi-za-izgovor-audio-2026-10-09.zip`. These paths may not exist
on the other PC. That local ZIP was built at `1eb94a6` and does not include
the incoming drag-only follow-up unless regenerated. Do not copy private
pupil recordings into the public repo.

## 4. Requested output

1. Your overall opinion: keep as is, adjust, or redesign specific parts — why.
2. Confirmed findings by severity, with file/line, reproducible trigger and
   consequence. Say clearly when something is merely an untested concern.
3. The smallest useful next local/offline milestone, exact affected components,
   acceptance checks, deployment order and recovery procedure.
4. Any owner decisions still needed, particularly changing `therapy_dev` or
   automatic mirror application. Do not ask again about already documented
   choices unless evidence reveals a real contradiction.
5. For the child-facing UI, distinguish actual usability defects from personal
   taste. Preserve stationary cards and gentle, optional feedback.

Do not include real names, records, credentials or dumps in the review or Git.
Use isolated databases for any later restore/write tests. Review first; do not
deploy or apply the offline plan merely because this handover lists tasks.
