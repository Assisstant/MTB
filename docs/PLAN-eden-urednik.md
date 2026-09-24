# One form per thing, a door wherever it is shown

**Progress:**
- **Step 1 is done** (`4e9e24c`, 24 September): the homeroom dropdown saves.
- **Step 2 is done** (24 September):
  - `mtb-forms.js`, the „✏️ Уреди“ switch, and the pupil form;
  - the first doors are in Податоци · Ученици and in Кабинети · Ученици по
    терапевт.

**Status, 24 September 2026:**
- **The map** (part 3) was read from the code on `main` (`d9d6fe6`), not from
  memory.
- **The working rule** (part 1) is the owner's, from the same day. It replaces
  a first proposal, "one editor, read-only everywhere else", which the owner
  turned down.
- **The owner approved starting** („START“, 24 September). Each step in
  part 5 is tested and committed on its own.

## 1. The rule — the owner's, 24 September 2026

> The Excel way. Where I see something, I can change it: add, edit, delete and
> save it on the spot, in a popup form, without losing the flow of my work. A
> view I make on purpose can be locked read-only. Even then, what it shows
> carries an edit link that opens the same form.

What that means in the code:

- **One form per kind of thing, many doors.**
  - Each kind of thing has exactly one form: a pupil, a staff member, a class,
    a therapist's list, a lesson, a therapy slot.
  - Each form lives once, in one shared file. It writes through the server
    endpoint that already owns that fact.
  - Every screen that shows the thing opens that same form in a popup, over
    the screen. After the save, the screen redraws itself.
- **What goes away is not the editing. It is the separate re-implementations.**
  - Today three different pieces of code edit a pupil: Податоци, the Панел and
    Администрација. They have different fields and behave differently.
  - The copy in Уреди настава saves nothing at all (3.5.1).
  - With one form, the copies cannot disagree, because there are no copies.
- **Editing is a mode: one „✏️ Уредување“ switch in the shared bar.**
  - The bar (`app-navigation.js`) is on every screen, S-Дневник included, so
    one switch reaches everywhere.
  - **Off (the default):** reading. Most of the year is reading. The owner's
    everyday landing page is the weekly schedule in S-Дневник, and the shared
    screens are administration: filled in during September, then small
    changes through the year.
  - **On:** every thing from 2.1 that a screen shows carries a ✏️, and the ✏️
    opens that thing's form.
  - Permissions still come from the server. Under sign-in, a colleague can
    change only their own list and their own schedule. The popup shows as
    read-only whatever the server would refuse.
- **A delete says which delete it is.** The pupil form names two different
  acts:
  - „Тргни од листата за оваа година“ (take off this year's list). The
    history stays, and „Врати на листата“ brings the pupil back.
  - „Избриши — грешка при внес“ (delete a typo). The server refuses it for
    anybody who has records or was on another year's list.

  Archiving a pupil for good is a third act. It stays with S-Дневник, which
  owns it (see `CLAUDE.md` and `roster-purge.ts`), so the form offers no
  archive button. It shows an archived pupil read-only.

## 2. How the apps fit together — the owner, 24 September 2026

- **Кабинети and Настава are one set of apps, because they share time.**
  From either side, at a given moment, you need to see:
  - where each pupil is;
  - which lesson a therapy takes them out of;
  - whose class it is (the homeroom teacher);
  - which teacher is holding that lesson at that moment.
- **S-Дневник stays the owner's own cabinet system.**
  - It records only the work done in that one cabinet, and keeps doing so.
  - It shares the pupils and the therapy times with the other apps. It must
    see the other therapists' times, so that no two therapists book the same
    child.
  - Integrating it means it READS the shared facts. It is not rebuilt, and no
    other app writes its records.
- **Податоци is the sheet of everything:** the full tables of pupils, staff and
  classes. It uses the same forms as the popups.

### 2.1 The things, as the database holds them — one form each

Read from `database/migrations/`.

| Thing | Its types and fields | Tables |
|---|---|---|
| **Ученик** | the person; then per year: паралелка, одделение (I–IX), internal / external, boarding, programme, placement, on this year's list | `students`, `student_enrollments` |
| **Вработен** | the person; then per year: teacher (одделенски / предметен), therapist, стручен соработник, administration; profession, job title, duties; subjects; category | `employees`, `teachers`, `therapists`, `*_years`, `employee_roles`, `employee_year_details` |
| **Паралелка** | label; per year a description; homeroom teacher and subject teachers; pupils. A комбинирана паралелка holds several одделенија | `school_classes`, `class_years`, `teacher_classes` |
| **Одделение** | not a table of its own: the grade I–IX on the pupil. The паралелка is where they sit, the одделение is their generation | `student_enrollments.oddelenie` |
| **Предмет** | the ministry's catalogue per одделение. It only offers choices: a lesson may carry any text. No editor today | `teaching_subjects` |
| **Стручна категорија** | 12, fixed by migration; per year, who holds which | `specialist_categories`, `*_years` |
| **Учебна година** | label, current year, rollover | `school_years` |
| **Распоред на настава** | a lesson: day, period, паралелка, teacher, subject; bells | `lessons`, `bell_periods` |
| **Распоред на кабинети** | a therapy slot: day, time, therapist, pupil or pupils | `schedule_slots` |
| **Листа на терапевт** | which pupils a therapist works with this year, in which order | `therapist_students`, `roster_order` |
| **Твојот распоред во S-Дневник** | yours alone; the diary keeps it | `diary_schedule` |

S-Дневник's own records (attendance, plans, progress, dossiers, tests,
audiograms) and the евидентен лист (`evidence_*`) have their own screens and
stay there.

## 3. The map

### 3.0 The screens

| Short name | File, part |
|---|---|
| **Податоци** | `Podatoci.html`: tabs Ученици, Наставници, Терапевти, Одделенија |
| **Панел** | `MTB-Workspace.html`: the left panel „Заеднички податоци“, with tabs Паралелки, Ученици, Наставници, Терапевти |
| **Администрација** | `MTB-Workspace.html`: the „Администрација“ button (`workspace-admin.js`), for pupils and employees |
| **Кабинети** | `RasporediFusion.html` |
| **Уреди настава** | `NastavaUredi.html`: four timetable tabs, plus the sections Одделенија, Наставници, Ѕвона, Земи од друга година |
| **Настава** | `Nastava.html`: read-only, six views |
| **S-Дневник** | `S-Dnevnik.html`: personal; its tabs include Ученици, Распоред, Податоци |
| **Евидентен лист** | `AkciskiPlan.html` |
| **Преглед** | `Pregled-Baza.html`: read-only |

In the tables below:
- ✏️ means the screen can change the fact;
- ➕ means it can only create one;
- ⚠️ points to 3.5;
- "Editors" counts the separate pieces of code that change the fact. Under the
  rule in part 1, each such count becomes one shared form.

### 3.1 People and the year

| # | Fact | Edited in | Editors | Server write |
|---|---|---|---|---|
| 1 | Pupil's name | Податоци · Ученици, Панел · Ученици, Администрација | **3** | `PATCH /api/students/:id`, `PUT /api/workspace/pupils/:id` |
| 2 | New pupil | ➕ Податоци, ➕ Администрација, ➕ Кабинети (from a slot), ➕ S-Дневник „Рачен внес“ (projected, add-only) | **4** | `POST /api/students`, `POST /api/workspace/pupils`, `PUT /api/state/sdnevnik` |
| 3 | Pupil's паралелка | Податоци · Ученици, Податоци · Одделенија (moving a chip), Панел · Ученици, Администрација | **4** | the same two |
| 4 | Pupil's одделение (generation) | Податоци · Ученици, Панел · Ученици, Администрација | **3** | the same two |
| 5 | Internal / boarding / external | Податоци · Ученици and Панел · Ученици (one field, 3 values); Администрација (two fields: type + boarding) | **3** | the same two |
| 6 | Programme, placement | Администрација | 1 | `PUT /api/workspace/pupils/:id` |
| 7 | On this year's list | Податоци (add / remove), Администрација („активен“) | **2** | `PUT /api/roster/memberships`, `PUT /api/workspace/pupils/:id` |
| 8 | Order of the four lists | Податоци (arrows) | 1 | `PUT /api/roster/order` |
| 9 | Staff name | Податоци · Наставници, Податоци · Терапевти, Уреди настава · Наставници, Панел · Наставници / Терапевти, Администрација | **4** | three different endpoints |
| 10 | New staff member | ➕ Податоци (teacher, therapist), ➕ Уреди настава (teacher), ➕ Администрација (employee) | **3** | three different endpoints |
| 11 | Teacher type (одделенски / предметен) | Податоци, Уреди настава, Панел, Администрација | **4** | `PUT /api/teaching/teacher/:id`, `PUT /api/workspace/employees/:id` |
| 12 | Teacher's subjects | Податоци, Уреди настава · Наставници, Панел | **3** | `PUT /api/teaching/teacher/:id` |
| 13 | Profession, job title, duties, roles | Администрација | 1 | `PUT /api/workspace/employees/:id` |
| 14 | Two profiles are one person | Администрација | 1 | `POST /api/workspace/employees/:id/link` |
| 15 | Category holder (per year) | Податоци, **Панел** ⚠️ | **2** | `PUT /api/categories/holder` |

### 3.2 Classes and teaching

| # | Fact | Edited in | Editors | Server write |
|---|---|---|---|---|
| 16 | Class list: add, rename | Податоци · Одделенија, Уреди настава · Одделенија | **2** | `POST/PATCH /api/teaching/class` |
| 17 | Class description | Податоци · Одделенија, Уреди настава · Одделенија | **2** | `PUT /api/teaching/class/:id/description` |
| 18 | Homeroom teacher (раководител) | Податоци · Одделенија, Податоци · Наставници, Панел · Наставници. **Уреди настава · Наставници shows a dropdown that saves nothing** ⚠️ | **3 (+1 dead)** | `PUT …/class/:id/teachers`, `PUT …/teacher/:id/classes` |
| 19 | Teacher teaches in a class | Податоци · Одделенија, Податоци · Наставници, Панел, Уреди настава · Распределба. Also set **automatically** whenever a lesson is written (add-only) | **4 + auto** | the same two |
| 20 | Lessons (the timetable) | Уреди настава (4 tabs, one editor) | 1 | `PUT /api/teaching/lesson`, `…/teacher-lesson` |
| 21 | Bells | Уреди настава · Ѕвона | 1 | `PUT /api/teaching/bell/:id` |
| 22 | Copy last year's timetable | Уреди настава | 1 | `POST /api/teaching/copy-year` |

The timetable is also shown, read-only, in three places:
- Настава (six views);
- Кабинети (which lesson a therapy slot takes a pupil out of);
- Панел · Паралелки.

### 3.3 Therapy, records, the year

| # | Fact | Edited in | Editors | Server write |
|---|---|---|---|---|
| 23 | A therapist's list of pupils (caseload) | Кабинети · Ученици по терапевт, Податоци · Терапевти, Панел · Терапевти, Администрација (a pupil's therapists) | **4** | `PUT/DELETE /api/therapists/:name/students/:id`, `PUT /api/workspace/pupils/:id/therapists` |
| 24 | Order of a therapist's list | Кабинети (arrows) | 1 | `PUT /api/therapists/:name/students-order` |
| 25 | The weekly therapy plan | Кабинети. S-Дневник · Распоред keeps the owner's **personal copy**, pulled by a button | 1 (+ a copy) | `PUT /api/schedule/block`, `…/session` |
| 26 | Attendance, plans, progress, dossier, tests, audiograms | S-Дневник | 1 | `/api/diary/*`, `/api/state/sdnevnik` |
| 27 | Евидентен лист: scores, sections, periods | Евидентен лист | 1 | `/api/evidence/*` |
| 28 | The category catalogue | no screen; fixed by migration | 0 | — |
| 29 | School year, rollover | Податоци | 1 | `POST /api/years/rollover` |
| 30 | School calendar (holidays, breaks) | S-Дневник · Податоци, **in the browser only, not in the database** | 1 | — |

### 3.4 What the map says

- **30 facts.** 14 are changed by one piece of code, 15 by two to four, and one
  by none. The one with none is the category catalogue, which is correct.
- **The re-implementations come from three places:**
  - the Workspace Панел, whose editors repeat Податоци field by field;
  - Администрација, which has its own pupil and staff forms;
  - the two setup sections of Уреди настава, „Одделенија“ and „Наставници“.

  These are what the shared forms replace.
- **Every row in the tables is also a list of doors:** the screens where that
  thing is shown, and where the popup has to open.
- **Three different things are called „Податоци“:**
  - the app;
  - the Workspace panel („Заеднички податоци“, with the button „Скриј
    податоци“);
  - a tab inside S-Дневник that holds the backup and the calendar.

### 3.5 Found while mapping

1. **A dead control.**
   - **Where:** Уреди настава → Наставници has a „раководител“ dropdown on
     every row, and „Зачувај“ sends it.
   - **What happens:** the server's teacher route (`TeacherPatch` in
     `teaching-edit.ts`) has no such field, so it drops the value without an
     error. After the reload, the old homeroom is back.
   - **Why nobody noticed:** no test touches the dropdown.
2. **A contract breach.** `APP-CONTRACT.md` says that the category is assigned
   only in Podatoci, and it forbids a second screen for it. The Панел assigns
   it too (`saveCategory` in `MTB-Workspace.html`). With a single shared form,
   there is again only one assigner.
3. **Checked and fine**, so nobody needs to check them again:
   - Names stay in step everywhere. Triggers from migration 035 keep
     `employees.name`, `teachers.name` and `therapists.name` the same, in both
     directions.
   - A therapist's rename keeps their slots, because the schedule points at
     the therapist's row, not at the name.
   - The two ways of storing internal/boarding/external (`kind`, and
     `enrollment_type` + `boarding`) are kept in step by migration 034's
     trigger.

## 4. Open decisions

- **L1. Resolved by the owner's "mode" (part 1).** Every screen starts in
  reading mode, and the one switch turns editing on everywhere.
  - Printouts never carry ✏️.
  - **The contract must change:** in editing mode, Настава opens forms that
    write, where until now it was deliberately read-only. The contract is
    changed in the same step.
- **S1. Doors inside S-Дневник.**
  - **Why they matter most:** the diary's week is where the owner spends the
    year.
  - **What they would open:** the shared forms, for example a pupil's class,
    or the time card.
  - **The risk:** the diary keeps its own copy of each pupil in the browser. A
    change saved there has to reach that copy too, or the diary goes on
    showing the old class.
  - **So it comes after the forms are proven elsewhere,** as its own reviewed
    step, because the contract protects the diary.
- **A1. Администрација.**
  - **Proposal:** its fields (programme, placement, profession, duties, linking
    two profiles) join the one pupil form and the one staff form. The button
    then opens those same forms.
- **D2. One „Настава“ in the menu instead of two** („Настава ↔ терапии“ and
  „Уреди настава“), with a switch between viewing and editing. Still open.
- **D5. Rename the other two „Податоци“.** Proposal: S-Дневник's tab becomes
  „Копија и календар“, and the Workspace panel becomes „Преглед“. Still open.

## 5. Order of work, draft

Small steps. Each one is approved, tested with invented data, committed and
shipped before the next one.
- **Screen changes** must pass the contract's definition of done, including
  `test:navigation` and `app-contract.test.ts`.
- **A new shared file** is added to the static allowlist in `public-static.ts`.

1. **Make the dead dropdown save** (3.5.1). It is shown there, so under the
   rule in part 1 it has to work.
   - It saves through the endpoint that already owns the homeroom.
   - It gets a test that fails first.
2. **The switch, the popup, and the pupil form.** This is the base that every
   later form reuses:
   - **The „✏️ Уредување“ switch** in the shared bar. It is off by default and
     applies to every screen.
   - **The popup itself:**
     - works by keyboard and at phone width, in both themes;
     - warns before an unsaved draft is lost;
     - refuses visibly if somebody else changed the row in the meantime (the
       project's `expected` check).
   - **The pupil form:**
     - every pupil field, including programme and placement;
     - the three kinds of delete, each named.
3. **Doors for the pupil.** Every place a pupil's name is shown opens the pupil
   form:
   - Кабинети (the list and the slots);
   - Уреди настава;
   - Настава;
   - Евидентен лист;
   - the Панел.

   A row in Податоци opens the same form.
4. **The staff form.**
   - **Fields:** name, type, subjects, classes and homeroom, category,
     profession, duties and roles.
   - **Doors:** wherever a teacher's or therapist's name is shown.
   - **What it replaces:** the editors in Уреди настава's sections, in the
     Панел, and in Администрација.
5. **The class form and the therapist's-list form.**
   - **The class form:** label, description, homeroom, subject teachers and
     pupils.
   - **The therapist's-list form:** add, remove and order.
6. **The time card.** Clicking a therapy slot, or a lesson, opens one popup with
   both sides at that moment:
   - the lesson being missed;
   - the class and its homeroom teacher;
   - the teacher holding that lesson;
   - the child's bookings with other therapists.

   Each of these has its own ✏️ door.
7. **Doors inside S-Дневник** (S1), as a separately reviewed step.
8. **Navigation** (D2, D5), and then the look: one header, one button style, and
   one way of saying "saved" or "not saved".

**Separately, and not part of this plan:** the school calendar into the
database (fact 30). S-Дневник stays as it is. Any change to how it reads shared
facts needs its own review, because the contract protects it.
