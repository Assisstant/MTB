# Colleagues online: an account, a personal form, and conflicts that reach the other person

Decided with the owner on 25 Sep 2026. It replaces the idea that colleagues
answer by FILE (`PLAN-formulari.md`) as the everyday path. The owner said the
offline forms are good for collecting the first answers, but a person changing
their schedule in a file cannot see whether the change clashes with the group
timetable. Nobody can agree on a change that nobody sees. The files stay as a
fallback.

## The owner's decisions

- **An account for every employee.** The username is the first name and the
  surname joined, in Latin or in Cyrillic, and both reach the same account:
  `BlagojNasev` = `БлагојНасев`. Letter case does not matter.
- **One initial password for everybody:** `ResursenCentar` / `РесурсенЦентар`.
  The first sign-in OFFERS a change, and keeping the initial one is the
  colleague's own decision. The owner was told what that costs: the app is on
  the internet and the username is only a name, so anyone who knows both can
  sign in as that person. The owner decided. The administrator can put an
  account back on the initial password.
- **A shared link leads straight to the sign-in.** After it comes the person's
  own form, filled from the database. The role decides the form: subject
  teacher, homeroom/class teacher, cabinet (therapist), and so on. One person
  can hold more than one role.
- **Every entry is compared with the group timetable.** A clash is shown
  before saving: who, which class or pupil, which term. The person may still
  save it („сепак запиши"). The change is then saved and stands until
  resolved. The clash is recorded, and it appears on the form of the colleague
  whose lesson or term it hits.
- **Either side, or the owner, resolves it** by moving one of the two to
  another term. Everything keeps working while clashes exist. Colleagues will
  not all be up to date, and resolving every clash is not the owner's job.
- **The owner is the superuser.** They see anybody's personal form and may
  resolve anything.

## What already exists and is reused

- `employees` (035): one identity per person across the teacher and therapist
  profiles. The account belongs to the employee.
- The scope rules in `lib/colleague.ts`: what is a person's own (a therapist's
  caseload and terms, a teacher's classes).
- The clash rules the offline forms already apply on import:
  `mtb-schedule-form.js` and `mtb-class-form.js` (`plan`), and the teaching
  clash view.
- The owner's own screens (Уреди настава, Кабинети) stay exactly as they are.

## Design

### 1. Accounts and sign-in

- `staff_accounts`: the employee, the password hash (none means the initial
  password still applies), when it was changed, the last sign-in, a reset.
- `staff_sessions`: a hash of the token, the employee, the expiry. The token
  travels in a header, never in a cookie, so no other site can act with it.
- The username is resolved from the employee's name. Cyrillic compares as
  Cyrillic. Latin compares after transliteration, with the usual spellings of
  ч, ш, ж, ќ, ѓ, џ, љ, њ accepted. Two people with the same name are not
  guessed between (rule 2): that sign-in is refused, and the administrator
  sees it.
- Failed attempts are limited per username and per address.
- `/api/portal/login | logout | password | me`.
- The cloud's Google gate lets through only the portal's page and
  `/api/portal/*`, and each of those routes checks its own session. Nothing
  else behind the gate changes.

### 2. The personal form

- One page, `Kolega.html`: sign in, then the person's roles as tabs, then the
  week. Editing a cell runs the clash check. The person saves, or moves the
  entry, or saves anyway.
- Per role: a subject teacher's own lessons (class and subject per period); a
  homeroom teacher's class week (subject and teacher per period); a
  therapist's terms (pupils per term).
- A colleague sees their own week and the names of their own pupils. For a
  clash they also see the other person's name, the class or pupil and the
  term. They do not see the roster, other people's schedules, or anything of
  the administration.

### 3. Clash notices

- A notice is recorded when somebody saves anyway: who, whom it hits, where,
  and one sentence. Whether it is still open is read from the live timetable,
  so a clash one side has already moved away from shows as resolved without
  anybody closing it.
- The person hit sees it on their form, with a count. The owner sees all.

### 4. The owner's view

- Podatoci → „Колеги": every account with its username, the last sign-in and
  whether the initial password is still in use, plus a reset. It also lists
  the open clashes and has „отвори го формуларот на…".

## Order

1 → 2 (teaching roles first, since the teaching timetable is what is still
being entered, then the cabinet) → 3 → 4. Each step can be deployed on its
own. The cloud needs its own Manual Deploy for each migration, under a new
recovery schema name (see `WORKSPACE-RELEASE.md`).
