-- A caseload belongs to a school year.
--
-- The original table said only "therapist X works with student Y".  Changing
-- that checkbox in September therefore rewrote what an archived year appeared
-- to say.  Students, therapists, schedules and teaching assignments are
-- already year-scoped; this is the missing relationship between them.

BEGIN;

ALTER TABLE therapist_students
    ADD COLUMN IF NOT EXISTS school_year_id integer REFERENCES school_years(id) ON DELETE CASCADE;

-- Existing links are the working list the user sees today, so preserve them in
-- the current year.  For older years, a booked slot is evidence that the pair
-- existed then; copy only those provable links rather than inventing history.
UPDATE therapist_students
SET school_year_id = (SELECT id FROM school_years WHERE is_current)
WHERE school_year_id IS NULL;

ALTER TABLE therapist_students DROP CONSTRAINT IF EXISTS therapist_students_pkey;

INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
SELECT DISTINCT sl.school_year_id, sl.therapist_id, sl.student_id
FROM schedule_slots sl
WHERE sl.school_year_id IS NOT NULL
  AND sl.student_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM therapist_students ts
      WHERE ts.school_year_id = sl.school_year_id
        AND ts.therapist_id = sl.therapist_id
        AND ts.student_id = sl.student_id
  );

ALTER TABLE therapist_students ALTER COLUMN school_year_id SET NOT NULL;

ALTER TABLE therapist_students
    ADD CONSTRAINT therapist_students_pkey
    PRIMARY KEY (school_year_id, therapist_id, student_id);

DROP INDEX IF EXISTS idx_therapist_students_student;
CREATE INDEX idx_therapist_students_student
    ON therapist_students (school_year_id, student_id);
CREATE INDEX IF NOT EXISTS idx_therapist_students_therapist
    ON therapist_students (school_year_id, therapist_id);

COMMIT;
