-- Сејхан Демиров is a real student from an earlier year, and a different
-- person from Сејхан Неџипов who is on the current roster. His audiograms
-- carried only a subject name, so they had no student to hang from.
--
-- Give him a student row that is NOT enrolled in the current year: the roster
-- stays correct while his records attach to a person and stay searchable.
-- The demo record "Пример - Испитаник" is left unlinked on purpose.

INSERT INTO students (public_id, name, grade, active)
VALUES ('past-sejhan-demirov', 'Сејхан Демиров', NULL, false)
ON CONFLICT (public_id) DO NOTHING;

UPDATE audiograms a
SET student_id = s.id
FROM students s
WHERE s.public_id = 'past-sejhan-demirov'
  AND a.student_id IS NULL
  AND a.subject_name = 'Сејхан Демиров';
