-- The cabinet becomes a CATEGORY, and a teacher can hold one too.
--
-- WHY THE RENAME, one migration after the table was created.
-- Two reasons, and the second is the one that would have cost real time.
--
-- The concept turned out to be wider than a room. What owns an action-plan
-- section is the KIND of specialist writing it -- логопед, психолог, педагог,
-- сензорна интеграција -- and the school's teachers are special educators who
-- hold such a profile as well, without necessarily having a room at all. A
-- column called `cabinet_id` on a teacher reads as nonsense, and whoever meets
-- it next has to guess.
--
-- And `cabinet` was ALREADY taken: `bell_periods.kind = 'kabinet'` is the
-- therapy bell schedule, in `lib/crossing.ts`, `lib/teaching.ts` and
-- migrations 004 and 014. One word meaning two things in one system is the
-- shape of mistake this project keeps paying for. It is renamed now, holding
-- nine seeded rows and no real assignments, because that is the cheap moment.
--
-- Apply with PGCLIENTENCODING=UTF8 -- this file is Cyrillic.

-- WHY to_regclass AND conrelid RATHER THAN A BARE CATALOGUE LOOKUP.
-- `pg_tables`, `pg_indexes` and `pg_constraint` answer for the whole cluster,
-- not for the schema this statement will act in. `projection.test.ts` applies
-- every migration into a disposable schema with `search_path` set to it alone,
-- so once `public.specialist_categories` existed the guard below read PUBLIC's
-- copy, decided the rename was already done, skipped it, and the next statement
-- failed on a table that was never renamed. `to_regclass` resolves a name the
-- same way ALTER TABLE will; `conrelid = to_regclass(...)` ties a constraint to
-- that exact table. Ask about the object you are about to change, not about its
-- name anywhere in the database.

DO $$
BEGIN
    IF to_regclass('cabinets') IS NOT NULL
       AND to_regclass('specialist_categories') IS NULL THEN
        ALTER TABLE cabinets RENAME TO specialist_categories;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('therapist_years')
                  AND attname = 'cabinet_id' AND NOT attisdropped) THEN
        ALTER TABLE therapist_years RENAME COLUMN cabinet_id TO category_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('evidence_sections')
                  AND attname = 'cabinet_id' AND NOT attisdropped) THEN
        ALTER TABLE evidence_sections RENAME COLUMN cabinet_id TO category_id;
    END IF;
END $$;

-- A teacher holds a category in a year, exactly as a therapist does. Same
-- shape, same annual reasoning: people move between profiles and an archived
-- plan must keep saying which profile wrote it.
ALTER TABLE teacher_years
    ADD COLUMN IF NOT EXISTS category_id integer
        REFERENCES specialist_categories(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS teacher_years_category_idx ON teacher_years (category_id);

DO $$
BEGIN
    IF to_regclass('therapist_years_cabinet_idx') IS NOT NULL THEN
        ALTER INDEX therapist_years_cabinet_idx RENAME TO therapist_years_category_idx;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'evidence_sections_cabinet_ck'
                  AND conrelid = to_regclass('evidence_sections')) THEN
        ALTER TABLE evidence_sections RENAME CONSTRAINT evidence_sections_cabinet_ck
            TO evidence_sections_category_ck;
    END IF;
END $$;

-- The nine were seeded as ROOM names, which is wrong for a profile a teacher
-- can hold. Only rows still carrying the exact seeded string are renamed --
-- a name somebody has already edited is a person's decision and wins, which
-- is the same rule `writeTeaching` follows for a subject typed by hand.
UPDATE specialist_categories SET name = 'Логопед'
 WHERE code = 'logoped'   AND name = 'Логопедски кабинет';
UPDATE specialist_categories SET name = 'Психолог'
 WHERE code = 'psiholoski' AND name = 'Психолошки кабинет';
UPDATE specialist_categories SET name = 'Ортооптика и плеоптика'
 WHERE code = 'ortooptika' AND name = 'Ортооптичко-плеоптички кабинет';

-- Profiles the годишна програма names outside индивидуална рехабилитација.
-- Seeds, not code: rename them, retire them, add your own.
INSERT INTO specialist_categories (code, name, ord) VALUES
    ('pedagog',      'Педагог',                        10),
    ('spec_edukator','Специјален едукатор',            11),
    ('vospituvac',   'Воспитувач',                     12)
ON CONFLICT (code) DO NOTHING;
