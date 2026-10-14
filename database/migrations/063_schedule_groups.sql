-- Групни термини (owner, 14 Oct 2026): a cabinet takes several pupils in one
-- term, all of them together for the whole bell — a sensory room, say.
-- docs/PLAN-grupni-termini.md.
--
-- A term was one row per year, day, time and therapist, so a second child at
-- the same time could not exist. A group is one row per child, every row with
-- the whole bell's time; the time says what the term is (the whole bell for
-- each child is together, two halves are „по 20"). So the key gains the
-- pupil: the same child cannot be in one group twice.
--
-- Only the key changes; no row does. A row without a pupil (a pupil row
-- removed ON DELETE SET NULL) stays one per cell, as it was.

ALTER TABLE schedule_slots DROP CONSTRAINT schedule_slots_year_day_time_therapist_key;
ALTER TABLE schedule_slots ADD CONSTRAINT schedule_slots_year_day_time_therapist_student_key
  UNIQUE (school_year_id, day, time_slot, therapist_id, student_id);
CREATE UNIQUE INDEX schedule_slots_empty_cell_key
  ON schedule_slots (school_year_id, day, time_slot, therapist_id) WHERE student_id IS NULL;

COMMENT ON CONSTRAINT schedule_slots_year_day_time_therapist_student_key ON schedule_slots IS
  'One row per child in a term (063): several rows at one time for one therapist are a group, together for the whole bell.';
