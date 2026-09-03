-- Annual rosters are selections from the permanent directory.
--
-- A teacher, therapist or class may still be needed in an archived report
-- after they stop appearing in this year's working screens.  Deleting the
-- directory row would destroy that history; returning every directory row
-- forever is the opposite error.  These tables record the missing fact:
-- whether the item belongs to one particular school year.
--
-- Students already have the same fact in student_enrollments.active.

BEGIN;

CREATE TABLE IF NOT EXISTS teacher_years (
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    teacher_id     integer NOT NULL REFERENCES teachers(id)     ON DELETE CASCADE,
    active         boolean NOT NULL DEFAULT true,
    note           text,
    PRIMARY KEY (school_year_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS therapist_years (
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    therapist_id   integer NOT NULL REFERENCES therapists(id)   ON DELETE CASCADE,
    active         boolean NOT NULL DEFAULT true,
    note           text,
    PRIMARY KEY (school_year_id, therapist_id)
);

CREATE TABLE IF NOT EXISTS class_years (
    school_year_id integer NOT NULL REFERENCES school_years(id)   ON DELETE CASCADE,
    class_id       integer NOT NULL REFERENCES school_classes(id) ON DELETE CASCADE,
    active         boolean NOT NULL DEFAULT true,
    PRIMARY KEY (school_year_id, class_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_years_active
    ON teacher_years (school_year_id, active);
CREATE INDEX IF NOT EXISTS idx_therapist_years_active
    ON therapist_years (school_year_id, active);
CREATE INDEX IF NOT EXISTS idx_class_years_active
    ON class_years (school_year_id, active);

-- Preserve exactly what the current screens showed before this migration:
-- every directory entry remains selected in the current year.  From the next
-- year onwards the list is built deliberately and starts empty.
INSERT INTO teacher_years (school_year_id, teacher_id, active)
SELECT y.id, t.id, true
FROM school_years y CROSS JOIN teachers t
WHERE y.is_current
ON CONFLICT DO NOTHING;

INSERT INTO therapist_years (school_year_id, therapist_id, active)
SELECT y.id, t.id, true
FROM school_years y CROSS JOIN therapists t
WHERE y.is_current
ON CONFLICT DO NOTHING;

INSERT INTO class_years (school_year_id, class_id, active)
SELECT y.id, c.id, true
FROM school_years y CROSS JOIN school_classes c
WHERE y.is_current
ON CONFLICT DO NOTHING;

-- Older years are reconstructed only from facts that prove membership.
INSERT INTO teacher_years (school_year_id, teacher_id, active)
SELECT DISTINCT school_year_id, teacher_id, true FROM teacher_classes
ON CONFLICT DO NOTHING;

INSERT INTO teacher_years (school_year_id, teacher_id, active)
SELECT DISTINCT school_year_id, teacher_id, true FROM lessons
WHERE teacher_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO therapist_years (school_year_id, therapist_id, active)
SELECT DISTINCT school_year_id, therapist_id, true FROM schedule_slots
WHERE school_year_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO class_years (school_year_id, class_id, active)
SELECT DISTINCT school_year_id, class_id, true FROM teacher_classes
ON CONFLICT DO NOTHING;

INSERT INTO class_years (school_year_id, class_id, active)
SELECT DISTINCT school_year_id, class_id, true FROM lessons
ON CONFLICT DO NOTHING;

INSERT INTO class_years (school_year_id, class_id, active)
SELECT DISTINCT e.school_year_id, c.id, true
FROM student_enrollments e
JOIN school_classes c ON c.label = e.grade
WHERE e.active
ON CONFLICT DO NOTHING;

COMMIT;
