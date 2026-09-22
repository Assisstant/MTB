-- The order a person wants to READ this year's four lists in.
--
-- WHY A STORED FACT AND NOT A BROWSER SETTING. `Podatoci.html` deliberately
-- keeps nothing in the browser — its suite asserts `localStorage` is empty —
-- and an order that lives on one machine is an order the other machine
-- contradicts. The school's own годишна програма lists people in an order
-- that is not alphabetical (the оддели, and the combined паралелки beside the
-- teacher who holds them); this is that order, written down once.
--
-- WHY ANNUAL. The four lists are entered fresh each September, so the order
-- belongs to the year that was entered. An archived year keeps reading the way
-- it was read then, and a new year starts from the reader's default order
-- rather than from last year's arrangement of different people.
--
-- WHY A TEXT KEY AND NO FOREIGN KEY. The four lists are keyed differently — a
-- pupil by `students.public_id`, the other three by their numeric id — and one
-- column cannot reference four tables. Nothing here decides membership,
-- identity, eligibility or access; `position` is display only. A key that
-- names nobody simply never matches, and the whole list for that (year, list)
-- is rewritten on the next move, which is where a stale key goes.
--
-- ABSENT MEANS "NOT PLACED YET", NOT "FIRST". The reader sorts unplaced rows
-- last, in the order it already used, so somebody added after a list was
-- arranged appears at the end until a person moves them — visible, and never
-- a silent reshuffle of the arrangement.
CREATE TABLE roster_order (
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    list           text    NOT NULL CHECK (list IN ('students', 'teachers', 'therapists', 'classes')),
    member_key     text    NOT NULL CHECK (length(member_key) BETWEEN 1 AND 80),
    position       integer NOT NULL CHECK (position >= 0),
    PRIMARY KEY (school_year_id, list, member_key)
);
COMMENT ON TABLE roster_order IS 'Preferred display order of one year''s four lists; never membership, identity, eligibility or access.';
ALTER TABLE roster_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON roster_order FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON roster_order FROM %I', api_role);
        END IF;
    END LOOP;
END $$;
