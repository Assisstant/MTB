-- Audiograms carry only a subject NAME, never a student id, and some name
-- students from earlier years who are no longer on the roster.
--
-- After an import, any audiogram still unlinked has no matching student at
-- all. Give each such subject a student row that is NOT enrolled in the
-- current year: the roster stays correct while the records attach to a person
-- and remain searchable.
--
-- Written generically, with no names in it. This repository is public (it
-- serves the apps through GitHub Pages), so student names must never appear
-- in the source, only in the local database.
--
-- Sample/demo subjects are skipped.

INSERT INTO students (public_id, name, grade, active)
SELECT DISTINCT
       'past-' || substr(md5(a.subject_name), 1, 12),
       a.subject_name,
       NULL,
       false
FROM audiograms a
WHERE a.student_id IS NULL
  AND a.subject_name IS NOT NULL
  AND a.subject_name NOT ILIKE '%пример%'
  AND a.subject_name NOT ILIKE '%example%'
  AND a.subject_name NOT ILIKE '%тест%'
ON CONFLICT (public_id) DO NOTHING;

UPDATE audiograms a
SET student_id = s.id
FROM students s
WHERE a.student_id IS NULL
  AND s.public_id = 'past-' || substr(md5(a.subject_name), 1, 12);
