-- Documents a column that already exists live: student_enrollments.oddelenie
-- was added by hand on 11 September against this machine's therapy_dev
-- (a separate, no-repo-access session guided the user through raw SQL,
-- so there was no way for it to leave a migration file behind).
-- IF NOT EXISTS makes this safe to run on a database that already has the
-- column and on one that does not.
--
-- What it is FOR: grade carries the ПАРАЛЕЛКА (section) a pupil is taught in;
-- for a combined paralelka (комбинирана) that is not the same as their
-- generation/year. oddelenie is meant to carry that generation separately.
-- No read path uses it yet -- every screen that shows "одделение" today is
-- actually showing grade (the paralelka). Wiring oddelenie into any reader
-- is separate work, not part of this migration.

ALTER TABLE student_enrollments
  ADD COLUMN IF NOT EXISTS oddelenie text;

COMMENT ON COLUMN student_enrollments.oddelenie IS
  'Пупил generation/year, kept separate from grade (which carries the paralelka/section and does not match the generation for a combined paralelka). Not yet read by any endpoint.';
