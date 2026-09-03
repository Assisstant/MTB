-- Keep each teaching timetable with the school year it describes.
--
-- Therapy slots and student enrollments were already archived by year, but
-- lessons were one global replacement. That made an archived crossing
-- impossible: last year's therapy could only be compared with today's class
-- timetable. The year is now part of both the lesson key and clash view.

BEGIN;

ALTER TABLE lessons
    ADD COLUMN IF NOT EXISTS school_year_id integer
    REFERENCES school_years(id) ON DELETE CASCADE;

-- Existing installations have one timetable. Preserve it as the timetable of
-- the year that was current when this migration was applied.
UPDATE lessons
SET school_year_id = (SELECT id FROM school_years WHERE is_current)
WHERE school_year_id IS NULL;

ALTER TABLE lessons ALTER COLUMN school_year_id SET NOT NULL;

ALTER TABLE lessons
    DROP CONSTRAINT IF EXISTS lessons_day_ordinal_class_id_teacher_id_key;
ALTER TABLE lessons
    DROP CONSTRAINT IF EXISTS lessons_year_day_ordinal_class_teacher_key;
ALTER TABLE lessons
    ADD CONSTRAINT lessons_year_day_ordinal_class_teacher_key
    UNIQUE (school_year_id, day, ordinal, class_id, teacher_id);

CREATE INDEX IF NOT EXISTS idx_lessons_year_day_period
    ON lessons(school_year_id, day_order, ordinal);

DROP VIEW IF EXISTS teaching_clashes;
CREATE VIEW teaching_clashes AS
SELECT y.label AS school_year,
       l.day,
       l.day_order,
       l.ordinal,
       c.label AS class,
       count(*) AS teacher_count,
       string_agg(coalesce(t.name, '—') || ' (' || coalesce(l.subject, '—') || ')', ' | ' ORDER BY t.name) AS who
FROM lessons l
JOIN school_years y ON y.id = l.school_year_id
JOIN school_classes c ON c.id = l.class_id
LEFT JOIN teachers t ON t.id = l.teacher_id
GROUP BY y.label, l.day, l.day_order, l.ordinal, c.label
HAVING count(*) > 1;

COMMIT;
