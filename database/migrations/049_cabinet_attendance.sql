-- Colleagues own dated cabinet attendance; the personal diary is untouched (049).
-- A day's plan is frozen on its first mark, never by a GET or later timetable edit.
CREATE TABLE cabinet_attendance_days (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  therapist_id integer NOT NULL REFERENCES therapists(id),
  day date NOT NULL,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'array'),
  marks jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(marks) = 'object'),
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_year_id, therapist_id, day)
);
CREATE TABLE cabinet_attendance_changes (
  id bigserial PRIMARY KEY,
  school_year_id integer NOT NULL,
  therapist_id integer NOT NULL,
  day date NOT NULL,
  session_key text NOT NULL,
  previous_status text CHECK (previous_status IN ('present', 'absent')),
  status text CHECK (status IN ('present', 'absent')),
  marked_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_year_id, therapist_id, day)
    REFERENCES cabinet_attendance_days ON DELETE CASCADE
);
-- Foreign keys protect every child in a frozen plan, even one still unmarked.
-- A JSON snapshot alone would be invisible to the typo-delete guard.
CREATE TABLE cabinet_attendance_pupils (
  school_year_id integer NOT NULL,
  therapist_id integer NOT NULL,
  day date NOT NULL,
  student_id integer NOT NULL REFERENCES students(id),
  PRIMARY KEY (school_year_id, therapist_id, day, student_id),
  FOREIGN KEY (school_year_id, therapist_id, day)
    REFERENCES cabinet_attendance_days ON DELETE CASCADE
);
ALTER TABLE cabinet_attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE cabinet_attendance_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cabinet_attendance_pupils ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cabinet_attendance_days, cabinet_attendance_changes, cabinet_attendance_pupils FROM PUBLIC;
REVOKE ALL ON SEQUENCE cabinet_attendance_changes_id_seq FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON cabinet_attendance_days, cabinet_attendance_changes, cabinet_attendance_pupils FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE cabinet_attendance_changes_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;
