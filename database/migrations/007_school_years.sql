-- School years: the roster carries over, everything else starts fresh.
--
-- Requirement from practice: each September the work starts over. Only the
-- student NAMES carry forward; last year's schedule, attendance, assessments
-- and progress are archived.
--
-- In a relational store "archived" does not mean deleted or moved to another
-- file. Every year stays queryable side by side; the year simply becomes part
-- of the key. That is the main thing this model buys over one JSON file per
-- year.
--
-- Consequence: a student's GRADE is not a property of the student, it is a
-- property of the student IN A YEAR. Hence student_enrollments.

CREATE TABLE IF NOT EXISTS school_years (
    id         serial PRIMARY KEY,
    label      text UNIQUE NOT NULL,        -- '2025/2026'
    starts_on  date NOT NULL,
    ends_on    date NOT NULL,
    is_current boolean NOT NULL DEFAULT false,
    CHECK (ends_on > starts_on)
);

-- Only one year may be current.
CREATE UNIQUE INDEX IF NOT EXISTS idx_school_years_current
    ON school_years (is_current) WHERE is_current;

-- Years tile the calendar (Sep 1 → Aug 31) so every date lands in exactly one.
INSERT INTO school_years (label, starts_on, ends_on, is_current)
VALUES ('2025/2026', '2025-09-01', '2026-08-31', true)
ON CONFLICT (label) DO NOTHING;

-- Which students attend in which year, and in which grade that year.
CREATE TABLE IF NOT EXISTS student_enrollments (
    student_id     integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    grade          text,
    active         boolean NOT NULL DEFAULT true,
    PRIMARY KEY (student_id, school_year_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_year ON student_enrollments(school_year_id);

-- The schedule has no dates of its own, so it must carry the year explicitly.
ALTER TABLE schedule_slots ADD COLUMN IF NOT EXISTS school_year_id integer REFERENCES school_years(id) ON DELETE CASCADE;

UPDATE schedule_slots
SET school_year_id = (SELECT id FROM school_years WHERE is_current)
WHERE school_year_id IS NULL;

-- The same therapist may hold the same term in different years, so the year
-- becomes part of the uniqueness rule.
ALTER TABLE schedule_slots DROP CONSTRAINT IF EXISTS schedule_slots_day_time_slot_therapist_id_key;
ALTER TABLE schedule_slots DROP CONSTRAINT IF EXISTS schedule_slots_year_day_time_therapist_key;
ALTER TABLE schedule_slots ADD CONSTRAINT schedule_slots_year_day_time_therapist_key
    UNIQUE (school_year_id, day, time_slot, therapist_id);

-- Backfill this year's enrollments from the roster already imported.
INSERT INTO student_enrollments (student_id, school_year_id, grade, active)
SELECT s.id, (SELECT id FROM school_years WHERE is_current), s.grade, s.active
FROM students s
ON CONFLICT (student_id, school_year_id) DO NOTHING;

-- Dated records (attendance, assessments, triage, progress) need no column:
-- their date already says which year they belong to.
CREATE OR REPLACE FUNCTION school_year_of(d date) RETURNS integer AS $$
    SELECT id FROM school_years WHERE d BETWEEN starts_on AND ends_on LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Conflicts are per-year now. The view gains a leading column, and
-- CREATE OR REPLACE cannot reorder columns, so it is dropped first.
DROP VIEW IF EXISTS schedule_conflicts;
CREATE VIEW schedule_conflicts AS
SELECT y.label AS school_year,
       sl.day,
       sl.day_order,
       sl.time_slot,
       st.name  AS student,
       count(*) AS therapist_count,
       string_agg(t.name, ' | ' ORDER BY t.name) AS therapists
FROM schedule_slots sl
JOIN students    st ON st.id = sl.student_id
JOIN therapists  t  ON t.id  = sl.therapist_id
LEFT JOIN school_years y ON y.id = sl.school_year_id
GROUP BY y.label, sl.day, sl.day_order, sl.time_slot, st.name
HAVING count(*) > 1;
