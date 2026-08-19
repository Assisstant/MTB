-- Stage 5 (plan v2): the weekly schedule.
--
-- Day keys and time labels stay exactly as the apps write them
-- ("понеделник", "08:00-08:20"); day_order exists only so queries can sort
-- Monday-to-Friday instead of alphabetically.
--
-- The hard constraint is one student per therapist per term: a therapist
-- cannot be in two places at once. A STUDENT booked with two therapists in
-- the same term is a real conflict the app already flags in red, and real
-- schedules contain some, so it is reported by a view rather than enforced
-- by a constraint that would refuse the import outright.

CREATE TABLE IF NOT EXISTS schedule_slots (
    id           serial PRIMARY KEY,
    day          text NOT NULL,
    day_order    smallint NOT NULL DEFAULT 0,
    time_slot    text NOT NULL,
    therapist_id integer NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
    student_id   integer REFERENCES students(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (day, time_slot, therapist_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_student ON schedule_slots(student_id);
CREATE INDEX IF NOT EXISTS idx_schedule_day_time ON schedule_slots(day_order, time_slot);

-- Students sitting in two cabinets at the same time.
-- Re-runnable: 007 later redefines this view with more columns, and
-- CREATE OR REPLACE cannot remove columns from an existing view.
DROP VIEW IF EXISTS schedule_conflicts;
CREATE VIEW schedule_conflicts AS
SELECT sl.day,
       sl.day_order,
       sl.time_slot,
       st.name  AS student,
       count(*) AS therapist_count,
       string_agg(t.name, ' | ' ORDER BY t.name) AS therapists
FROM schedule_slots sl
JOIN students   st ON st.id = sl.student_id
JOIN therapists t  ON t.id  = sl.therapist_id
GROUP BY sl.day, sl.day_order, sl.time_slot, st.name
HAVING count(*) > 1;
