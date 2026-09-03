-- The therapy cabinet, and the catalogue's second half.
--
-- WHY THIS EXISTS
-- The евидентен лист catalogue describes one prescribed form: eleven sections
-- every pupil's sheet carries.  What the centre needs on top of that is a
-- quarterly action plan whose sections depend on WHICH cabinets the pupil
-- attends -- a pupil who goes to the logopedic and the sensory cabinet gets
-- those two sections and no others.
--
-- Nothing in the schema could say that, because a therapist had no cabinet at
-- all: `therapists` was (id, name).  The годишна програма names all nine of
-- them, and AGENTS.md has recorded for weeks that the cabinet "has nowhere to
-- live".
--
-- WHY THE CABINET IS ANNUAL
-- It hangs off `therapist_years`, not off `therapists`.  A therapist can move
-- between cabinets, and an action plan printed for 2026/2027 must keep saying
-- what was true in 2026/2027.  That is the same lesson `teacher_classes`,
-- `therapist_students` and `lessons` each taught after being written as a
-- global fact first.  One column now; a migration across every read later.
--
-- WHY THE SECTION'S CABINET IS *NOT* ANNUAL
-- The catalogue is global and already carries `active` for retirement.  A
-- section belongs to a KIND of cabinet, and that does not change when a person
-- moves rooms.
--
-- Apply with PGCLIENTENCODING=UTF8 -- this file is Cyrillic.

-- HAS THIS FILE ALREADY BEEN SUPERSEDED?
-- 024 renames `cabinets` to `specialist_categories` and `cabinet_id` to
-- `category_id`.  Every CREATE and ADD COLUMN below says IF NOT EXISTS, which
-- means that after 024 this file does not fail -- it RESURRECTS: a second empty
-- `cabinets` table beside `specialist_categories`, and an empty `cabinet_id`
-- beside `category_id` on two tables.  Nothing complains, 024 can then never
-- run again, and the drift is invisible until something reads the wrong column.
--
-- `schema_migrations` is what normally prevents this, so the refusal below only
-- ever fires when a file was applied by hand.  Refuse loudly rather than
-- half-apply -- the same rule the projection endpoint follows.
DO $$
BEGIN
    IF to_regclass('cabinets') IS NULL
       AND to_regclass('specialist_categories') IS NOT NULL THEN
        RAISE EXCEPTION
            '023 is superseded by 024: cabinets is now specialist_categories. '
            'Applying it by hand would recreate the old table and the old '
            'columns. Run scripts/setup-home-postgres.ps1 instead -- it applies '
            'each migration once, with its ledger row, in one transaction.';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cabinets (
    id     serial PRIMARY KEY,
    -- A stable ASCII key.  The catalogue and any future import refer to the
    -- cabinet by this, never by the display name, so renaming the room in
    -- Podatoci cannot orphan a section.
    code   text NOT NULL UNIQUE,
    name   text NOT NULL,
    ord    integer NOT NULL DEFAULT 0,
    -- Retirement, never deletion.  A cabinet that is not staffed this year is
    -- a different fact from one that never existed, and archived sheets point
    -- at it.  Same reasoning as `roster-write.ts` having no DELETE.
    active boolean NOT NULL DEFAULT true
);

-- The nine of индивидуална рехабилитација, in the order §8.2 lists them.
-- These are room names, not people (rule 1).
INSERT INTO cabinets (code, name, ord) VALUES
    ('sluh_govor',   'Слушно-говорни вежби',              1),
    ('psihomotorna', 'Психомоторна реедукација',          2),
    ('senzorna',     'Сензорна интеграција',              3),
    ('logoped',      'Логопедски кабинет',                4),
    ('biofidbek',    'Биофидбек',                         5),
    ('montesori',    'Монтесори',                         6),
    ('ortooptika',   'Ортооптичко-плеоптички кабинет',    7),
    ('asistivna',    'Асистивна технологија',             8),
    ('psiholoski',   'Психолошки кабинет',                9)
ON CONFLICT (code) DO NOTHING;

-- Which cabinet this therapist held in this school year.  Nullable: the nine
-- are the rehabilitation staff, and not every therapist on a year's list runs
-- a cabinet.  NULL means "not recorded", never "none" -- the action plan
-- treats it as unknown and says so rather than silently producing no sections.
ALTER TABLE therapist_years
    ADD COLUMN IF NOT EXISTS cabinet_id integer REFERENCES cabinets(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS therapist_years_cabinet_idx ON therapist_years (cabinet_id);

-- WHICH DOCUMENT A SECTION BELONGS TO.
--
-- The евидентен лист is a PRESCRIBED form.  Putting cabinet goals into it
-- would mean that in two years nobody could tell which sections the Правилник
-- requires and which the school added -- and the printed form would carry
-- both.  So sections keep one engine and gain a catalogue.
--
-- Everything that exists today is prescribed; that is what the default says,
-- and it is why no backfill statement is needed.
ALTER TABLE evidence_sections
    ADD COLUMN IF NOT EXISTS catalog text NOT NULL DEFAULT 'prescribed';

ALTER TABLE evidence_sections
    ADD COLUMN IF NOT EXISTS cabinet_id integer REFERENCES cabinets(id) ON DELETE RESTRICT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_sections_catalog_ck'
                                      AND conrelid = to_regclass('evidence_sections')
    ) THEN
        ALTER TABLE evidence_sections ADD CONSTRAINT evidence_sections_catalog_ck
            CHECK (catalog IN ('prescribed', 'action'));
    END IF;
    -- An action-plan section without a cabinet has no way to be switched on,
    -- and a prescribed section with one would be filtered out of its own form.
    -- Both are bugs that read as "the section just does not appear".
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_sections_cabinet_ck'
                                      AND conrelid = to_regclass('evidence_sections')
    ) THEN
        ALTER TABLE evidence_sections ADD CONSTRAINT evidence_sections_cabinet_ck
            CHECK (
                (catalog = 'prescribed' AND cabinet_id IS NULL) OR
                (catalog = 'action'     AND cabinet_id IS NOT NULL)
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS evidence_sections_catalog_idx ON evidence_sections (catalog);

-- A DECISION, NOT A COMPUTATION.
--
-- Which action-plan sections a sheet carries is DERIVED: the cabinets whose
-- therapists have this pupil on their caseload this year.  But a therapist
-- must be able to add a section by hand, or take one off, and that choice has
-- to survive the next page load -- otherwise the derivation quietly overwrites
-- the person, which is the one-owner-per-fact failure this project keeps
-- paying for.
--
-- Only DEVIATIONS are stored.  An absent row means "follow the derivation",
-- so a cabinet added to a pupil's caseload in February still reaches sheets
-- that were opened in September.  Storing every section instead would freeze
-- each sheet at the moment it was created.
CREATE TABLE IF NOT EXISTS evidence_sheet_sections (
    sheet_id   integer NOT NULL REFERENCES evidence_sheets(id)    ON DELETE CASCADE,
    section_id integer NOT NULL REFERENCES evidence_sections(id)  ON DELETE CASCADE,
    included   boolean NOT NULL,
    decided_by integer REFERENCES therapists(id) ON DELETE SET NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sheet_id, section_id)
);
