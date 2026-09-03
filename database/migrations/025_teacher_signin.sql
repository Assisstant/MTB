-- A teacher signs in too.
--
-- WHY. Migration 023/024 let a teacher hold a profile, and the ownership rule
-- says the section for a profile is written by whoever holds it. But
-- `evidence_logins` and `evidence_sessions` were keyed by `therapist_id`, so a
-- teacher could hold a section they could never write in. The guard refused it
-- loudly rather than hiding it; this is the fix it was pointing at.
--
-- WHY TWO NULLABLE COLUMNS RATHER THAN (kind, person_id).
-- A single pair would need no foreign key, because it would point at one of two
-- tables — and this schema cleans up by CASCADE everywhere. `roster-purge.ts`
-- can delete a teacher typed by mistake, and an orphaned login row surviving
-- that is exactly the kind of quiet leftover this project keeps finding. So
-- each kind gets its own column, its own FK, its own cascade, and a CHECK that
-- exactly one is set.
--
-- The PIN stays four digits and the server stays on the tailnet: the owner's
-- decision, recorded here because the two go together. A four-digit PIN is ten
-- thousand guesses, so it is worth what the network boundary is worth and not a
-- penny more. If the server is ever put on a public address, this file is the
-- one to come back to.
--
-- Apply with PGCLIENTENCODING=UTF8 -- this file is Cyrillic.

-- ── logins ──────────────────────────────────────────────────────────────────
ALTER TABLE evidence_logins
    ADD COLUMN IF NOT EXISTS teacher_id integer REFERENCES teachers(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'evidence_logins_pkey'
                      AND conrelid = to_regclass('evidence_logins')) THEN
        ALTER TABLE evidence_logins DROP CONSTRAINT evidence_logins_pkey;
    END IF;
END $$;

ALTER TABLE evidence_logins ALTER COLUMN therapist_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS evidence_logins_therapist_uq
    ON evidence_logins (therapist_id) WHERE therapist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS evidence_logins_teacher_uq
    ON evidence_logins (teacher_id) WHERE teacher_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'evidence_logins_one_person_ck'
                      AND conrelid = to_regclass('evidence_logins')) THEN
        ALTER TABLE evidence_logins ADD CONSTRAINT evidence_logins_one_person_ck
            CHECK (num_nonnulls(therapist_id, teacher_id) = 1);
    END IF;
END $$;

-- ── sessions ────────────────────────────────────────────────────────────────
ALTER TABLE evidence_sessions
    ADD COLUMN IF NOT EXISTS teacher_id integer REFERENCES teachers(id) ON DELETE CASCADE;

ALTER TABLE evidence_sessions ALTER COLUMN therapist_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'evidence_sessions_one_person_ck'
                      AND conrelid = to_regclass('evidence_sessions')) THEN
        ALTER TABLE evidence_sessions ADD CONSTRAINT evidence_sessions_one_person_ck
            CHECK (num_nonnulls(therapist_id, teacher_id) = 1);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS evidence_sessions_teacher_idx ON evidence_sessions (teacher_id);

-- ── who decided a section deviation ─────────────────────────────────────────
-- Same reasoning: the decision belongs to a person, and a person is now either
-- kind. Both stay ON DELETE SET NULL — losing who decided is better than
-- losing the decision.
ALTER TABLE evidence_sheet_sections
    ADD COLUMN IF NOT EXISTS decided_by_teacher integer REFERENCES teachers(id) ON DELETE SET NULL;
