-- The last two collections the JSON export could not reproduce.
--
-- diary_schedule is S-Dnevnik's own weekly plan, stored as
--   { monday: [[studentId], [studentId], …], tuesday: […] }
-- where the array index IS the slot number: attendance.slot_key is literally
-- day || '-' || position. So position is part of the identity, not ordering.
-- A slot holds an array because two students can share one term.
--
-- scheduleHistory is a set of dated snapshots that are only ever displayed
-- as a whole, so it stays jsonb (columns for what you query, jsonb for what
-- you only display).

CREATE TABLE IF NOT EXISTS diary_schedule (
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    day            text NOT NULL,
    position       integer NOT NULL,
    student_id     integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    PRIMARY KEY (school_year_id, day, position, student_id)
);

-- Order WITHIN a shared slot. Without it the round trip returns the two
-- students in whatever order the query yields, which is a quiet change to the
-- file even though no information is missing.
ALTER TABLE diary_schedule ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_diary_schedule_student ON diary_schedule(student_id);

CREATE TABLE IF NOT EXISTS diary_schedule_history (
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    week_of        date NOT NULL,
    payload        jsonb NOT NULL,
    PRIMARY KEY (school_year_id, week_of)
);

-- Reference material the diary keeps (exercise sheets, documents).
CREATE TABLE IF NOT EXISTS resource_links (
    id          serial PRIMARY KEY,
    sdnevnik_id bigint UNIQUE,
    name        text NOT NULL,
    url         text NOT NULL
);
