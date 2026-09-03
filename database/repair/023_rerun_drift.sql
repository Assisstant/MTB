-- Repairs what a hand-applied 023 leaves behind after 024 has run.
--
-- WHY THIS FILE EXISTS
-- 023 creates `cabinets` and two `cabinet_id` columns; 024 renames all three.
-- Every statement in 023 says IF NOT EXISTS, so applying it a second time after
-- 024 does not fail -- it recreates the old table beside the new one and the old
-- columns beside the new ones, all empty, and 024 can then never run again.
-- 023 now refuses to do that.  This file cleans up a database where it already
-- happened.
--
-- SAFE TO RUN ALWAYS.  With no drift it reports "clean" and changes nothing.
-- It removes a duplicate only after proving the duplicate holds no data; if any
-- value was written there it refuses and says so, because at that point a human
-- has to decide which column is the real one.
--
-- Apply with PGCLIENTENCODING=UTF8 -- this file is Cyrillic in its messages.

DO $$
DECLARE
    stray_table  boolean := to_regclass('cabinets') IS NOT NULL
                            AND to_regclass('specialist_categories') IS NOT NULL;
    dup_ty       boolean := (SELECT count(*) = 2 FROM pg_attribute
                              WHERE attrelid = to_regclass('therapist_years')
                                AND attname IN ('cabinet_id', 'category_id')
                                AND NOT attisdropped);
    dup_es       boolean := (SELECT count(*) = 2 FROM pg_attribute
                              WHERE attrelid = to_regclass('evidence_sections')
                                AND attname IN ('cabinet_id', 'category_id')
                                AND NOT attisdropped);
    stray_ck     boolean := EXISTS (SELECT 1 FROM pg_constraint
                                     WHERE conname = 'evidence_sections_cabinet_ck'
                                       AND conrelid = to_regclass('evidence_sections'));
    used         bigint;
BEGIN
    IF NOT (stray_table OR dup_ty OR dup_es OR stray_ck) THEN
        RAISE NOTICE 'clean: no 023 re-run drift in this schema';
        RETURN;
    END IF;

    RAISE NOTICE 'drift found -- stray cabinets table: %, therapist_years dup: %, evidence_sections dup: %, stray check: %',
        stray_table, dup_ty, dup_es, stray_ck;

    IF dup_ty THEN
        EXECUTE 'SELECT count(*) FROM therapist_years WHERE cabinet_id IS NOT NULL' INTO used;
        IF used > 0 THEN
            RAISE EXCEPTION 'therapist_years.cabinet_id holds % row(s); refusing to drop it. Decide by hand which column is the real one.', used;
        END IF;
        EXECUTE 'ALTER TABLE therapist_years DROP COLUMN cabinet_id';
        RAISE NOTICE 'dropped therapist_years.cabinet_id (was empty)';
    END IF;

    IF stray_ck THEN
        EXECUTE 'ALTER TABLE evidence_sections DROP CONSTRAINT evidence_sections_cabinet_ck';
        RAISE NOTICE 'dropped the resurrected evidence_sections_cabinet_ck';
    END IF;

    IF dup_es THEN
        EXECUTE 'SELECT count(*) FROM evidence_sections WHERE cabinet_id IS NOT NULL' INTO used;
        IF used > 0 THEN
            RAISE EXCEPTION 'evidence_sections.cabinet_id holds % row(s); refusing to drop it. Decide by hand which column is the real one.', used;
        END IF;
        EXECUTE 'ALTER TABLE evidence_sections DROP COLUMN cabinet_id';
        RAISE NOTICE 'dropped evidence_sections.cabinet_id (was empty)';
    END IF;

    IF stray_table THEN
        -- Nothing can reference it any more: the only two foreign keys that
        -- ever pointed at it were the columns dropped above.
        EXECUTE 'DROP TABLE cabinets';
        RAISE NOTICE 'dropped the resurrected cabinets table';
    END IF;

    RAISE NOTICE 'repaired';
END $$;
