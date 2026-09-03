-- 011 — a student leaving is an event, not an absence.
--
-- Until now the only thing that ever set students.active = false was
-- rollover-year.ts, deciding by itself who had graduated. Meanwhile S-Dnevnik
-- kept its own archivedStudents list, which never reached the server at all:
-- archiving someone in the app left their row here active for ever, so
-- Pregled-Baza and every query disagreed with the app that owns the fact.
--
-- The app is now the owner. These columns record what it decided, so the
-- database can answer "who left, when, and why" instead of merely "who is
-- missing from the latest payload" — which is indistinguishable from "the app
-- had not pulled yet".

ALTER TABLE students ADD COLUMN IF NOT EXISTS left_at     timestamptz;
ALTER TABLE students ADD COLUMN IF NOT EXISTS left_year   text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS left_reason text;

COMMENT ON COLUMN students.active      IS 'false = archived in S-Dnevnik. The app owns this; nothing else may set it.';
COMMENT ON COLUMN students.left_at     IS 'When the app archived them.';
COMMENT ON COLUMN students.left_year   IS 'School year they left in, e.g. 2025/2026.';
COMMENT ON COLUMN students.left_reason IS 'finished | moved | other — free text from the app, never guessed here.';

-- Finding who is still enrolled is now the common query, so index for it.
CREATE INDEX IF NOT EXISTS students_active_idx ON students (active);
