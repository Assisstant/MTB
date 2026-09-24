# Offline forms for colleagues, and a review queue for what comes back

Owner's request, 24 September 2026. Status: **steps 1–4 built** (24 Sep,
HOME): the review queue (part 5), the cabinet form version 2, the class form
and the export/import buttons (part 6). The owner's decisions are in part 4.

This is not the same thing as `docs/PLAN-eden-urednik.md`. That plan is about
popup forms INSIDE the apps, which write at once. This one is about a FILE a
colleague fills in WITHOUT the app, whose answer is checked by the
administrator before anything is written. The two must share their fields and
their rules (see "One definition" below), but they are different doors.

## 1. What the owner asked for

- **Two forms, the same abilities:**
  - **Кабинет** (individual rehabilitation): a therapist's week of sessions
    and their pupils.
  - **Одделение** (teaching): a class's weekly timetable of lessons, filled by
    its homeroom teacher.
- **Each form carries the existing data**, not an empty page.
- **A dropdown of people in the form:** therapists in the cabinet form,
  homeroom teachers / classes in the class form. Choosing one shows that
  person's pupils, or that class's week, with the option to add.
- **The returned JSON says whom it is about** (cabinet–therapist, or
  class–homeroom). That, not the file name or the sender, decides where the
  data goes.
- **Checkbox customisation:** the full list of pupils (cabinet), and the full
  list of subjects (class), from which the person ticks what is theirs.
- **An image of the week** from inside the form, if not a problem.
- **The answer only updates what exists.** Because one change can move the
  whole timetable, answers are **stored first**, and the administrator
  **personally checks and approves** every item that does not match the
  database or causes a conflict. Examples the owner named: a different subject
  in a period; a child already busy at that time (a session at the same
  time).

## 2. The design

### 2.1 One generic file per kind, not one per person

The form is one HTML file per kind and year: all therapists (or all classes)
with their current data, and the dropdown at the top. A colleague picks
themselves. The file works offline, with no server and no sign-in.

Consequence, stated plainly: **the file carries the whole year's pupils and
timetable.** It must be sent only through school channels. It is made when it
is sent and never stored in this repository (rules 1 and 6).

### 2.2 The reply

```
{ type: 'mtb-form-reply', version: 2, kind: 'cabinet' | 'class',
  year, madeAt, filledAt,
  about: { therapist: {id, name} } | { class: {id, label}, homeroom: {id, name} },
  baseline: …the week exactly as the form showed it…,
  week: …the week as the colleague left it…,
  ticks: …pupils (cabinet) or subjects (class) as ticked…,
  newPupils: [names typed that are not on the list],
  note }
```

Identity is by stable id (`public_id`, class id, teacher id), never by name
(rule 2). A typed name stays a proposal: one match → that pupil, said so; two
→ refused; none → a new pupil under observation.

### 2.3 The review queue (new: the "layer" the owner asked for)

- **Storing:** importing a reply no longer writes the schedule. It stores the
  reply as one row (`form_replies`, migration 040): kind, year, whom it is
  about, the JSON, when it arrived, status.
- **Nothing is lost:** a stored reply survives closing the page, a restart,
  and a second reply from the same person (both are kept, newest first).
- **Each reply becomes a list of items**, each one a single change:
  - a session block (cabinet), or a lesson cell (class);
  - a pupil ticked or unticked on a therapist's list;
  - a new pupil name.
- **Each item is checked against the database AT REVIEW TIME, not at import**
  (the database may have moved since):
  - **unchanged** — the reply says what the database already says;
  - **clean** — only this reply touches it, and the database still holds
    what the form showed;
  - **changed meanwhile** — the database no longer holds the form's baseline;
  - **conflict** — see 2.4.
- **The administrator decides per item:** accept, reject, or accept all
  clean items at once. Conflicts and "changed meanwhile" are never accepted
  in bulk; each is looked at.
- **Writing goes through the endpoints that already own each fact**, with
  `expected`, exactly as the in-app editors do. The queue decides; it never
  writes a table directly.
- **A record stays:** who accepted or rejected which item, and when. That is
  the "notification": a list of received forms and their outcome, readable
  later.

### 2.4 Conflicts that are checked

| Kind | Conflict | Why it matters |
|---|---|---|
| cabinet | the child already has a session with **another therapist** at an overlapping time | two cabinets cannot hold one child (today this is only counted, never refused) |
| cabinet | the child is **not on this therapist's list** and the reply does not tick them | the list and the week disagree |
| class | the **teacher** already teaches another class in that period | `teacher-clash`, already refused by the server |
| class | **another subject** is in the database for that cell than the form showed | "changed meanwhile" |
| class | the cell already holds **two lessons** | a person must choose (as in Уреди настава) |
| both | the form was made for **another school year** | refused whole |

A session over a lesson is **not** a conflict: taking a child out of a lesson
is how therapy is done here, and Настава ↔ терапии reports it. It was in the
first draft of this table by mistake.

### 2.5 One definition, two doors

The fields and the checks of 2.3/2.4 live once, in a pure module (like
`MTBScheduleForm.plan` today), and are used by:
- the offline file's reply (this plan), and
- the in-app popup forms of `PLAN-eden-urednik.md` step 5/6.

So a conflict the queue finds is the same conflict a popup would refuse.

## 3. Order of work

Small steps; each approved, tested with invented data, committed, shipped.

1. **The review queue for the form that exists.**
   - Migration 040 `form_replies`; `POST/GET /api/forms/replies`,
     `POST /api/forms/replies/:id/decisions` (records the decisions only).
   - Кабинети → „📥 Внеси формулар" stores the reply and opens the queue
     instead of writing at once.
   - The queue screen: received replies, their items, the checks of 2.4 for
     the cabinet, accept/reject per item, "accept all clean".
   - Tests: a reply stored, reloaded, reviewed; a child double-booked is
     shown as a conflict and not written in bulk; a stale item refused.
2. **The cabinet form, version 2.**
   - The therapist dropdown; the full pupil list as a checklist, each pupil
     labelled with class and homeroom („II-б · Христовска"); add a name.
   - "🖼 Слика" inside the form (the week drawn to a PNG, as Кабинети does).
   - Version 1 replies still import (rule 4 spirit: an answer already sent
     must not become unreadable).
3. **The class form.**
   - The class / homeroom dropdown; the weekly grid (periods × days) with the
     subject per cell, teacher optional; the subject checklist from the full
     MON list filtering what the cells offer; the pupils with their
     generation, read only, with "report a mistake".
   - "🖼 Слика"; the reply into the same queue, with the class checks of 2.4.
4. **Exports from the apps:** Кабинети → „📤 Формулар" and Уреди настава →
   „📤 Формулар за одделенија", each producing the one generic file.

## 4. The owner's decisions (24 September 2026)

- **Subject ticks:** a filter in the form only. Nothing new is stored; the
  lessons themselves say which subjects a class has.
- **Pupils in the class form:** report only. A homeroom teacher flags a child
  in the wrong class; the administrator moves them in Податоци.
- **Where the queue lives:** Податоци → „📥 Формулари".
- **Who:** only the administrator, signed in — on every machine and in every
  mode, not only under `MTB_REQUIRE_SIGNIN`. The administrator is whoever
  `MTB_ADMIN` names in `server/.env` (`therapist:Име Презиме`); without it
  nobody can open the queue, and the screen says how to set it.
- **Several files at once**, and among answers about the same employee **the
  newest wins** (`savedAt`). "The same employee" is matched by NAME, because
  the numeric id differs between WORK, HOME and the cloud.

## 5. Step 1 as built

- **Migration 040** `form_replies` + `form_reply_decisions`, row-level
  security on and no rights for the Supabase REST roles; the cloud runner
  accepts 040 under its own recovery schema
  `mtb_workspace_recovery_form_replies_20260924`. Excluded from the
  cloud→local mirror (an inbox is useless read-only; accepted items reach the
  mirrored tables).
- **Server** `routes/form-replies.ts`, `lib/form-replies.ts`:
  - `POST /api/forms/replies` — one request, many files; each file answers
    `stored` / `superseded` / `duplicate` (same content, key order
    ignored) / `refused`.
  - `GET /api/forms/replies/:id/review` — the answer read by the SAME
    `plan()` Кабинети used (loaded with `vm`), against the database as it is
    now: `clean`, `changed`, `conflict` (a child with another therapist at
    an overlapping time), `refused`.
  - `POST /api/forms/replies/:id/decide` — accepted items are written by the
    routes that own them (`/api/workspace/pupils`, the caseload route,
    `PUT /api/schedule/block` with `expected`) through `server.inject`
    with the administrator's own token; every decision and its outcome is
    recorded; the answer closes when nothing is left undecided.
- **Кабинети → „📥 Внеси формулар"** no longer writes: it sends one or more
  files to the queue and links to Податоци.
- **Tests:** `test:form-replies` (in-process, its own MTB_ADMIN, invented
  year), `test:forms-queue` (the tab, both themes), `test:schedule-form`
  (the hand-off), and a release test for 040.

## 6. Steps 2–4 as built (24 September, evening)

- **Cabinet form, version 2** (`mtb-schedule-form.js`): ONE file for every
  therapist of the year; „Терапевт:" dropdown at the top (preselected when
  one therapist is chosen in Кабинети); the whole year's pupils as a
  checklist grouped „II-б · Христовска"; only ticked pupils are offered in a
  term; unticking a placed pupil asks and takes them out of those terms;
  „🖼 Слика" draws the week to a PNG (`paintGrid`, shared with the class
  form). Each person's draft is kept apart in the browser. The reply adds
  `pupils: {baseline, ticked}`; `plan()` still reads version 1.
  A tick taken away becomes an `uncaseload` item — only when the database
  still lists the pupil and the answer places them in no term — written by
  `DELETE /api/therapists/:name/students/:id` (the link only; history stays).
- **Class form** (`mtb-class-form.js`, needs `mtb-schedule-form.js` first):
  ONE file for every class; „Одделение:" dropdown „II-б · Христовска"; the
  week as periods × days, a subject select per cell (only ticked subjects,
  plus „✎ друг предмет…") and an optional teacher; the full subject list as
  a checklist that only filters (nothing stored); the class's pupils with
  their generation, read only, each with a free-text „what is wrong"; a
  cell holding two lessons is locked, as in Уреди настава. The reply is
  `{kind: 'mtb-class-reply', version: 1, class: {id, label}, homeroom,
  baseline, cells, subjects, reports, note}` — cells keyed `day|ordinal`.
- **Queue:** a class answer is `kind = 'class'`, the same employee rule by
  LABEL (`class:<label>`), newest wins. Items: `lesson` — clean, changed
  (the database no longer holds the form's cell), conflict (the teacher is
  in another class in that period), refused (no such period, two lessons in
  the cell, a teacher not on the year's list); `report` — its own group,
  never pre-ticked, accepting it records „забележано" and writes nothing.
  Lessons are written by `PUT /api/teaching/lesson` with `expected`, or
  `DELETE /api/teaching/lesson/:id` for a cleared period.
- **Buttons:** Кабинети → „📤 Формулар" (all therapists) and „📥 Внеси
  формулар"; Уреди настава → „📤 Формулар" (all classes) and „📥 Внеси
  формулар". Both imports only store; the review is Податоци → Формулари.
- **Tests:** `class-form.test.ts` (10, pure), `schedule-form.test.ts` (+5
  for version 2), `test:class-form` (Уреди настава → offline form → queue),
  `test:schedule-form` (version 2), `test:forms-queue` (a class answer),
  `test:form-replies` (+ version 2 checklist and a class answer written
  through the owning routes, against a real database, invented year).
