-- Stage 6 (plan v2): attendance, therapy plans and per-student progress.
--
-- Shapes taken from a real S-Dnevnik v3 export rather than from the app code,
-- because the live data differs from what the code paths suggest:
--   attendance[date][studentId][slotKey] is sometimes a bare "present" string
--   and sometimes { status, date, time };
--   studentProgress[studentId][planId] is a list of { index, date, time },
--   where index points into the plan's activities array.

-- Therapy plans (S-Dnevnik ids are Date.now() values, hence bigint).
CREATE TABLE IF NOT EXISTS plans (
    id          serial PRIMARY KEY,
    sdnevnik_id bigint UNIQUE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Activities are ordered text steps; `position` is the index the diary uses
-- to record progress, so it is part of the identity, not decoration.
CREATE TABLE IF NOT EXISTS plan_activities (
    id       serial PRIMARY KEY,
    plan_id  integer NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    position integer NOT NULL,
    label    text NOT NULL,
    UNIQUE (plan_id, position)
);

-- Which activity a student has completed, and when.
CREATE TABLE IF NOT EXISTS student_plan_progress (
    student_id   integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    activity_id  integer NOT NULL REFERENCES plan_activities(id) ON DELETE CASCADE,
    completed_on date,
    time_slot    text,
    PRIMARY KEY (student_id, activity_id)
);

-- One attendance mark per student, per day, per term slot ("monday-0").
CREATE TABLE IF NOT EXISTS attendance (
    id         serial PRIMARY KEY,
    student_id integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date       date NOT NULL,
    slot_key   text NOT NULL,
    status     text NOT NULL CHECK (status IN ('present', 'absent')),
    UNIQUE (student_id, date, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, date);

-- The plan a student is currently following.
ALTER TABLE students ADD COLUMN IF NOT EXISTS plan_id integer REFERENCES plans(id) ON DELETE SET NULL;
