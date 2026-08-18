-- Сејхан Демиров is a real student from an earlier year, and a different
-- person from Сејхан Неџипов who is on the current roster. His audiograms
-- carried only a subject name, so they had no student to hang from.
--
-- Give him a student row that is NOT enrolled in the current year: the roster
-- stays correct while his records attach to a person and stay searchable.
-- The demo record "Пример - Испитаник" is left unlinked on purpose.

-- Conditional on the audiograms actually being present: this is a data repair,
-- not a schema change, and a fresh database (a new machine, a test run) must
-- not gain a student who has no records to attach to.
INSERT INTO students (public_id, name, grade, active)
SELECT 'past-sejhan-demirov', 'Сејхан Демиров', NULL, false
WHERE EXISTS (SELECT 1 FROM audiograms WHERE subject_name = 'Сејхан Демиров')
ON CONFLICT (public_id) DO NOTHING;

UPDATE audiograms a
SET student_id = s.id
FROM students s
WHERE s.public_id = 'past-sejhan-demirov'
  AND a.student_id IS NULL
  AND a.subject_name = 'Сејхан Демиров';
