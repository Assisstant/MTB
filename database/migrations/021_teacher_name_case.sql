-- One spelling per person.
--
-- The school's workbook types the staff in capitals, so every teacher imported
-- from it was stored as „АНА ТЕСТОВА" and every screen that shows a name
-- shouted.  `Podatoci.html` meanwhile title-cases a name as it saves it, so
-- the one teacher somebody had edited was stored differently from the twenty
-- nobody had touched — two renderings of one fact, decided by which screen
-- last pressed a button.
--
-- The second consequence is the dangerous one: the unique key on
-- `teachers.name` is the exact string.  Edit a teacher in Podatoci, re-import
-- the workbook, and „АНА ТЕСТОВА" no longer conflicts with „Ана
-- Тестова" — a SECOND row for the same person, with the new year's lessons
-- hanging off it while `teacher_classes` still points at the old one.
-- `writeTeaching` now resolves case-insensitively as well, so this backfill
-- and that change close the same hole from both ends.
--
-- ONLY ENTIRELY UPPERCASE NAMES ARE TOUCHED.  A name with any lower-case
-- letter in it was written by a person, and a person's spelling wins.
-- `initcap` is the same rule `personName` in `server/src/lib/import-core.ts`
-- applies from here on; this file is the one-off for what is already stored.
--
-- Therapists and students are deliberately left alone: none of them is in
-- capitals, they do not come from the workbook, and a student's name is the
-- one field this project has already been burned by touching.

BEGIN;

UPDATE teachers
SET    name = initcap(name)
WHERE  name = upper(name)
  AND  name <> lower(name);   -- a database that cannot case-fold Cyrillic
                              -- (collation C) matches nothing here rather
                              -- than mangling everything; see /api/health.

COMMIT;
