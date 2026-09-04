# Пристап за колегите

Started 4 September 2026, branch `kolegi-pristap`. Written in English because
the audience is whoever — person or model — picks this up cold; the domain
words stay Macedonian because renaming them would be the third name for things
that already have two.

The one-line version: **ten therapists reach the same database over Tailscale,
each fills their own list and their own timetable, and everybody sees the
conflicts.**

---

## What the owner asked for

Colleagues get access to exactly two acts:

1. tick which pupils are theirs (the caseload), and
2. fill their own weekly распоред from a dropdown of the pupils they ticked.

Plus Евидентен лист, scoped to those same pupils. No CRUD on anything else. If
two of them book the same child in the same term, both must see it live and
resolve it themselves.

---

## The decision that shaped everything

**This is not one merged application.** `PLAN-rasporedot-i-nedelata.md` already
settled that each app answers one question and must refuse to grow into
another, and that decision is not reopened here. So what colleagues get is
**one sign-in across three tools**, not one tool:

| tool | its one question | what a colleague may do |
|---|---|---|
| `RasporediFusion.html` | is this child in two cabinets at once? | edit own caseload + own terms |
| `AkciskiPlan.html` | what does this child's record say? | own sheets, own category |
| `Podatoci.html` | who exists at this school? | **nothing — owner only** |

Merging them would answer two questions in one place, which is the failure
that document exists to prevent.

---

## Done (commit `bb589bf`)

`server/src/lib/colleague.ts` — the one place that answers *кој смее што*, so
the boundary is not spelled out in three route files that will disagree. Rule 5
applied to permission.

    read    everything.
    write   own caseload, own terms, own sheets.
    never   the roster, or the year's columns.

**Reads are deliberately open.** A conflict is by definition two therapists
holding the same child in the same term. A colleague who cannot see the other
cabinet cannot resolve the red cell the screen is showing them, so hiding it
would make the feature pointless.

Guards were added to:

- `routes/roster-write.ts` — both `/api/therapists/:name/students/:publicId`
  routes (own name only); `POST /api/students`, `PATCH /api/students/:publicId`,
  `POST /api/therapists`, `PATCH /api/therapists/:name` (owner only).
- `routes/schedule-write.ts` — `/api/schedule/block`, `/session`, `/slot`.
- `routes/evidence.ts` — caseload filter on `/api/evidence/sheets` and
  `/sheets/full`; owner-only on the three `/api/evidence/period` routes.

`lib/evidence.ts` — `SESSION_IDLE_MINUTES` (30). `last_seen` had been written
on every authenticated call since migration 022 and never once read. Twelve
hours answers "how long may a working day be"; it cannot answer "is anybody
still sitting there", and in a staff room those are different questions.

### What was deliberately NOT touched

The catalogue already had an owner before this branch: `lib/categories.ts`
`assertMayEdit` restricts a section, its items and its groups to whoever holds
that specialist category **for the year**. That is finer than "only the admin"
and it is the rule the owner asked for, so nothing here layers on top of it.
Only `evidence_periods` gained a guard, because a year's columns belong to no
category and therefore had nobody.

**Do not "fix" this by adding an admin check to the section and item routes.**
It would take the логопед's own section away from the логопед.

---

## Still to do

### 1. Make Fusion's roster tab editable  (the actual feature)

`RasporediFusion.html` already has the tab — `#rosterPanel`, heading
„Ученици по терапевт" — but it renders a read-only table and its
`<select id="rosterTherapist">` is `disabled`. It needs checkboxes.

The endpoint already exists and is already used by `Podatoci.html`:

    PUT    /api/therapists/${name}/students/${publicId}?year=…    tick
    DELETE /api/therapists/${name}/students/${publicId}?year=…    untick

So this is a rendering change plus two fetches, not new plumbing. Copy the call
shape from `Podatoci.html` rather than inventing a second one.

### 2. Shared sign-in

`AkciskiPlan.html` already holds the whole flow: `/api/evidence/login`,
`/me`, `/logout`, `/pin`, `/people`, and it sends the token as the
`x-mtb-evidence-token` header. Fusion must read the **same** token so signing
in once covers both. One storage key, one helper, both pages.

When signed in as a colleague, Fusion fixes the therapist to that person and
hides the picker. That is presentation — the server guard is what makes it
true, and the guard is already in.

### 3. Live conflicts

Fusion computes conflicts client-side (`RasporediFusion.html`, near the
`const conflicts = new Set()` in `computeConflicts`) from
`/api/schedule/sessions`, which already returns **every** therapist. So "live"
is a periodic re-fetch, not new logic.

Two things to get right: do not re-render while a dropdown is open (it eats the
selection), and back off when the tab is hidden.

`schedule_conflicts` (migration 004, redefined in 007) and `/api/conflicts`
exist if a server-side answer is ever wanted. Today's client-side one is not
wrong — do not add the second without removing the first, or two components
decide one fact.

---

## Open question the owner has not answered

`assertMayEdit` says who may **score** a section. It does not ask whether the
child is on that person's caseload — so the holder of a category can currently
score any child's section of it.

Caseload-scoping that too would match "only his roster students" literally. It
would also refuse a specialist assessing a child who is not on their weekly
timetable, which may be entirely normal at this school. `assertOwnStudent` in
`lib/colleague.ts` is written and ready if the answer turns out to be yes; it
is simply not called from the score route. **Ask before wiring it.**

---

## How to switch it on

Nothing is enforced until `.env` says so. Without it every helper in
`colleague.ts` answers "allowed" and every endpoint behaves exactly as it did
before this branch — which is what keeps `sync-peer`, the import scripts and
the whole e2e suite working.

```
MTB_REQUIRE_SIGNIN=1
MTB_ADMIN=<the owner's name, as it is spelled in the therapists table>
MTB_SESSION_IDLE_MINUTES=30
```

`MTB_ADMIN` is matched with `lower(btrim(name))`, the same way every other name
in this server is matched. It lives in `.env` and not in a column on purpose: it
is a fact about **this deployment**, so a database restored onto a colleague's
machine for a test does not carry somebody else's rights into it.

Access itself stays Tailscale — `docs/CLIENT-SETUP.md`, unchanged. A colleague
installs Tailscale, is invited to the tailnet, and opens the same
`https://<name>.ts.net` address. Revoking someone is removing their device in
the Tailscale admin. **Do not put this on a public address**: migration 025
records why in its own words, and the four-digit PIN is worth exactly what the
network boundary is worth.

---

## Testing

The suite could not be run from the cloud side of the bridge: this repo's
`node_modules` holds the `win32-x64` esbuild binary, so `tsx` refuses on Linux,
and Postgres is not reachable from there either. `npm install` was deliberately
NOT run — it would have replaced the owner's Windows binaries and broken the
running server.

On the server PC:

```powershell
cd C:\Users\Admin\Documents\MTB\server
npm test
```

`tsc --noEmit` is clean as of `bb589bf`.

### What a guard test has to prove

Not yet written. It needs a live database, so it belongs with the other
`*.e2e.ts` files:

1. with `MTB_REQUIRE_SIGNIN` unset, every existing endpoint answers as before —
   this is the one that protects the owner's own workflow;
2. therapist A signed in cannot `PUT /api/schedule/session` for therapist B → 403;
3. therapist A cannot tick a pupil onto B's caseload → 403;
4. A token idle past `MTB_SESSION_IDLE_MINUTES` → 401 `signedOut`;
5. `/api/evidence/sheets` signed in as A returns only A's caseload;
6. A colleague cannot `POST /api/students` → 403, but the owner still can.

Test fixtures use invented names (rule 1).
