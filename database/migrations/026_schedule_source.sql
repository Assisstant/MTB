-- Who wrote this slot: the API, cell by cell, or a whole document at once.
--
-- WHY THIS EXISTS
-- `import-core.ts` deletes every slot for the year and rebuilds them from a
-- unified payload, matching pupils BY NAME. `slotWrites` in the payload turns
-- that off, and only `Rasporedi.html` sets it -- S-Dnevnik does not. So one
-- press of "Зачувај на сервер" in the diary replaces the whole school's
-- schedule with one therapist's browser copy, and every slot whose pupil has
-- since been renamed is dropped as "unknown student".
--
-- That was measured, not imagined: the diary held an old spelling of one pupil
-- and a pupil taken off the current year, while the database held both
-- correctly. Nothing about that is the diary's fault -- it was built before
-- there was a database to be wrong about.
--
-- The contract now says RasporediFusion is the only owner of the plan. This
-- column is what lets the server hold to that: a document may not replace what
-- was written cell by cell. Same shape as the guard already beside it, which
-- refuses an empty schedule over a full one and says why.
--
-- WHY EXISTING ROWS ARE 'api'
-- Not a guess. Every live database's current schedule was built in Fusion --
-- that is exactly why it disagreed with the diary's copy. Marking them
-- 'document' would leave the thing this migration exists to protect unprotected
-- on the very first save.
--
-- Apply with PGCLIENTENCODING=UTF8 -- this file is Cyrillic.

ALTER TABLE schedule_slots ADD COLUMN IF NOT EXISTS source text;

UPDATE schedule_slots SET source = 'api' WHERE source IS NULL;

ALTER TABLE schedule_slots ALTER COLUMN source SET DEFAULT 'document';
ALTER TABLE schedule_slots ALTER COLUMN source SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'schedule_slots_source_ck'
                      AND conrelid = to_regclass('schedule_slots')) THEN
        ALTER TABLE schedule_slots ADD CONSTRAINT schedule_slots_source_ck
            CHECK (source IN ('api', 'document'));
    END IF;
END $$;

-- The projection asks one question of this column -- "does this year hold any
-- api-written slot?" -- on every save, so it gets an index shaped like that
-- question rather than a scan of the year.
CREATE INDEX IF NOT EXISTS schedule_slots_api_idx
    ON schedule_slots (school_year_id) WHERE source = 'api';
