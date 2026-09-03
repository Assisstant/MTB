-- Stage G — the school's own timetable.
--
-- Rasporedi already knows who a therapist takes out of class. It has never
-- known what they were taken out OF. These tables hold the other half: which
-- class sits with which teacher for which subject, in which period.
--
-- Why this is not just another jsonb blob: the crossing question ("how many
-- children are missing from IV-б in the third period?") is a join, and the
-- answer has to be the same in the browser, in a printed report and in a
-- query run next June. One owner, one place (rule 5).
--
-- The bell schedule is a TABLE, not a constant, because the school and the
-- cabinet do not necessarily ring at the same minute. Teaching starts at
-- 07:30 and therapy blocks at 08:00, which means a 40-minute session does not
-- sit inside one 40-minute lesson at all — it straddles two. Storing the real
-- start times is what lets the overlap be computed instead of assumed.

BEGIN;

-- ── when things ring ────────────────────────────────────────────────────────
-- One row per period per schedule. `schedule` names the rhythm:
--   'nastava-am'  teaching, morning shift
--   'nastava-pm'  teaching, afternoon shift
--   'kabinet'     the therapy cabinet
CREATE TABLE IF NOT EXISTS bell_periods (
    id         serial   PRIMARY KEY,
    schedule   text     NOT NULL,
    ordinal    smallint NOT NULL CHECK (ordinal >= 1),
    label      text,
    starts_at  time     NOT NULL,
    minutes    smallint NOT NULL CHECK (minutes > 0),
    UNIQUE (schedule, ordinal)
);

-- ── classes ─────────────────────────────────────────────────────────────────
-- `label` is written exactly as the school writes it ("IV-б"). `sort_key` is
-- only so ORDER BY puts II before X instead of after it.
CREATE TABLE IF NOT EXISTS school_classes (
    id       serial PRIMARY KEY,
    label    text UNIQUE NOT NULL,
    sort_key text NOT NULL DEFAULT ''
);

-- ── teachers ────────────────────────────────────────────────────────────────
-- Two kinds, and the difference matters when reading the timetable:
--   'odd'  одделенска — the row is one class, the cell is the subject
--   'pred' предметна  — the row is one subject, the cell is the class
CREATE TABLE IF NOT EXISTS teachers (
    id                serial PRIMARY KEY,
    name              text UNIQUE NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('odd', 'pred')),
    -- The class this teacher leads, when they lead one.
    homeroom_class_id integer REFERENCES school_classes(id) ON DELETE SET NULL,
    -- The subject a subject-teacher carries, when the timetable names one
    -- ("АНГ.", "ЛИК.", "ФЗО.") rather than a homeroom class.
    subject           text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── the timetable itself ────────────────────────────────────────────────────
-- One row per class per period per teacher. Deliberately NOT unique on
-- (day, ordinal, class_id): a class listed twice in the same period is a real
-- clash in the source workbook, and a constraint that refused the import would
-- hide it. `teaching_clashes` below reports it instead.
CREATE TABLE IF NOT EXISTS lessons (
    id         serial   PRIMARY KEY,
    day        text     NOT NULL,
    day_order  smallint NOT NULL DEFAULT 0,
    ordinal    smallint NOT NULL CHECK (ordinal >= 1),
    class_id   integer  NOT NULL REFERENCES school_classes(id) ON DELETE CASCADE,
    teacher_id integer  REFERENCES teachers(id) ON DELETE SET NULL,
    subject    text,
    UNIQUE (day, ordinal, class_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_lessons_day_period ON lessons(day_order, ordinal);
CREATE INDEX IF NOT EXISTS idx_lessons_class      ON lessons(class_id);

-- Two teachers claiming the same class in the same period.
DROP VIEW IF EXISTS teaching_clashes;
CREATE VIEW teaching_clashes AS
SELECT l.day,
       l.day_order,
       l.ordinal,
       c.label AS class,
       count(*) AS teacher_count,
       string_agg(coalesce(t.name, '—') || ' (' || coalesce(l.subject, '—') || ')', ' | ' ORDER BY t.name) AS who
FROM lessons l
JOIN school_classes c ON c.id = l.class_id
LEFT JOIN teachers  t ON t.id = l.teacher_id
GROUP BY l.day, l.day_order, l.ordinal, c.label
HAVING count(*) > 1;

-- ── the bells we know about today ───────────────────────────────────────────
-- Taken from the school's own workbook and from the times the cabinet has
-- always used. Both are editable: change a row here and every crossing
-- recomputes, because nothing downstream hard-codes a clock.
INSERT INTO bell_periods (schedule, ordinal, label, starts_at, minutes) VALUES
    ('nastava-am', 1, '1', '07:30', 40),
    ('nastava-am', 2, '2', '08:15', 40),
    ('nastava-am', 3, '3', '09:10', 40),
    ('nastava-am', 4, '4', '09:55', 40),
    ('nastava-am', 5, '5', '10:40', 40),
    ('nastava-am', 6, '6', '11:25', 40),
    ('nastava-am', 7, '7', '12:10', 40),
    ('nastava-pm', 1, '1', '13:45', 40),
    ('nastava-pm', 2, '2', '14:30', 40),
    ('nastava-pm', 3, '3', '15:25', 40),
    ('nastava-pm', 4, '4', '16:10', 40),
    ('nastava-pm', 5, '5', '16:55', 40),
    ('nastava-pm', 6, '6', '17:40', 40),
    ('nastava-pm', 7, '7', '18:25', 40),
    ('kabinet',    1, 'I',   '08:00', 40),
    ('kabinet',    2, 'II',  '08:45', 40),
    ('kabinet',    3, 'III', '09:40', 40),
    ('kabinet',    4, 'IV',  '10:25', 40),
    ('kabinet',    5, 'V',   '11:10', 40),
    ('kabinet',    6, 'VI',  '11:55', 40)
ON CONFLICT (schedule, ordinal) DO NOTHING;

COMMIT;
