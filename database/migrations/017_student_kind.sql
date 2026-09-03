-- Internal, boarding, external — and why the third one matters.
--
-- The school's own lists are three, not one: „список на интерни ученици"
-- (grouped by class, numbered within it), the boarding children inside that
-- list, and „список на екстерни ученици" — children who belong to no class at
-- all and come in only for therapy.
--
-- Nothing recorded that. An external child was simply a student with no class,
-- which is indistinguishable from an internal child whose class nobody has
-- typed in yet. So the crossing reported every one of them as an unattached
-- session with the reason „ученикот нема запишано одделение" — twenty-odd
-- entries in a list of things to fix, none of which can ever be fixed, sitting
-- next to the ones that can. A backlog that never shrinks is one nobody reads,
-- and the real omissions hide in it.
--
-- It goes on the ENROLMENT, not on the student: a child can arrive as external
-- and enrol the following September, and last year's answer must stay true.
--
-- Three values rather than two flags. „Интернатски" is a boarding child, who
-- is by definition also internal, and „boarding external" is not a thing — the
-- external children come from home for an hour. One column that can be picked
-- from a list beats two booleans with an impossible combination.

BEGIN;

ALTER TABLE student_enrollments
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'internal';

ALTER TABLE student_enrollments
    DROP CONSTRAINT IF EXISTS student_enrollments_kind_check;
ALTER TABLE student_enrollments
    ADD CONSTRAINT student_enrollments_kind_check
    CHECK (kind IN ('internal', 'boarding', 'external'));

-- A child with no class in a year is what the school's list calls external.
-- That is a reading of the existing data, not a guess about people: the class
-- is the only thing that distinguishes the two lists, and a child who is
-- internal but missing a class is exactly the case this lets somebody correct
-- — they change the kind back and type the class in.
UPDATE student_enrollments SET kind = 'external'
WHERE coalesce(btrim(grade), '') = '';

CREATE INDEX IF NOT EXISTS idx_enrollments_kind ON student_enrollments(school_year_id, kind);

COMMIT;
