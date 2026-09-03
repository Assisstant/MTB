-- Which classes a teacher has, and in which year.
--
-- `teachers.homeroom_class_id` could hold exactly one class and had no year.
-- Both are wrong for this school:
--
--   * A class teacher can have КОМБИНИРАНИ ПАРАЛЕЛКИ — two or three classes
--     taught together as one group. One column cannot say that, and the
--     workbook's "ОДД." cell really does list more than one.
--   * A subject teacher belongs to several classes by definition; the old
--     column was only ever filled for the one class they also led.
--   * A homeroom is a fact about a YEAR. Without the year, importing
--     2026/2027 silently overwrote what 2025/2026 said, and an archived
--     timetable then reported the wrong teacher against last March.
--
-- So the assignment moves into a table of its own, keyed by year, and the
-- column goes. One owner (rule 5): everything that wants to know a teacher's
-- classes reads this, including the importer.
--
-- `role` separates the two senses the school itself separates: 'homeroom' is
-- „одделенски раководител", 'subject' is „предметен наставник влегува во тоа
-- одделение". The same teacher can be both, in different classes, in one year.

BEGIN;

CREATE TABLE IF NOT EXISTS teacher_classes (
    school_year_id integer NOT NULL REFERENCES school_years(id)   ON DELETE CASCADE,
    teacher_id     integer NOT NULL REFERENCES teachers(id)       ON DELETE CASCADE,
    class_id       integer NOT NULL REFERENCES school_classes(id) ON DELETE CASCADE,
    role           text    NOT NULL DEFAULT 'subject' CHECK (role IN ('homeroom', 'subject')),
    PRIMARY KEY (school_year_id, teacher_id, class_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_classes_year  ON teacher_classes(school_year_id);
CREATE INDEX IF NOT EXISTS idx_teacher_classes_class ON teacher_classes(class_id);

-- Carry the old column forward into every year that has a timetable, not only
-- the current one: the column had no year, so the honest reading is "this was
-- true for as long as we have been recording", and a homeroom missing from an
-- archived year reads as a mistake rather than as missing data.
INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
SELECT DISTINCT y.id, t.id, t.homeroom_class_id, 'homeroom'
FROM teachers t
CROSS JOIN school_years y
WHERE t.homeroom_class_id IS NOT NULL
  AND (y.is_current OR EXISTS (SELECT 1 FROM lessons l WHERE l.school_year_id = y.id))
ON CONFLICT DO NOTHING;

-- And record what the timetable already proves: a teacher who teaches a class
-- in a year belongs to that class in that year. This is what makes the list
-- useful on day one instead of empty.
INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
SELECT DISTINCT l.school_year_id, l.teacher_id, l.class_id, 'subject'
FROM lessons l
WHERE l.teacher_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE teachers DROP COLUMN IF EXISTS homeroom_class_id;

COMMIT;
