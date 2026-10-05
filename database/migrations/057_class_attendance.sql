-- Присуство по паралелка, по ден (owner, 5 Oct 2026): who is in school today,
-- so tomorrow's food can be ordered. NOT the transport report — that stays the
-- cabinets' confirmed visits (049) — and not a lesson-by-lesson register.
-- An unmarked pupil has no row: „неозначено“ is never read as absent.
CREATE TABLE class_attendance (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  class_id integer NOT NULL REFERENCES school_classes(id),
  day date NOT NULL,
  student_id integer NOT NULL REFERENCES students(id),
  status text NOT NULL CHECK (status IN ('present', 'absent')),
  marked_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_year_id, class_id, day, student_id)
);
CREATE INDEX class_attendance_day ON class_attendance (school_year_id, day);
-- Who changed what, in the same shape as cabinet_attendance_changes.
CREATE TABLE class_attendance_changes (
  id bigserial PRIMARY KEY,
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  class_id integer NOT NULL REFERENCES school_classes(id),
  day date NOT NULL,
  student_id integer NOT NULL REFERENCES students(id),
  previous_status text CHECK (previous_status IN ('present', 'absent')),
  status text CHECK (status IN ('present', 'absent')),
  marked_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
-- 056 put its guard on the tables that existed then; a new table that points
-- at a pupil must take it too, or a stale tab could mark a merged-away row.
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON class_attendance
    FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON class_attendance_changes
    FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');

ALTER TABLE class_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_attendance_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON class_attendance, class_attendance_changes FROM PUBLIC;
REVOKE ALL ON SEQUENCE class_attendance_changes_id_seq FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON class_attendance, class_attendance_changes FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE class_attendance_changes_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;
