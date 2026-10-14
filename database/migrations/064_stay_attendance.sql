-- Each colleague owns an annual stay list and daily marks, independent of lessons and therapy.
ALTER TABLE employee_roles DROP CONSTRAINT employee_roles_role_check;
ALTER TABLE employee_roles ADD CONSTRAINT employee_roles_role_check
  CHECK (role IN ('specialist', 'administration', 'stay'));
CREATE TABLE stay_pupils (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES employees(id),
  student_id integer NOT NULL REFERENCES students(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (school_year_id, employee_id, student_id)
);
CREATE TABLE stay_attendance (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES employees(id),
  student_id integer NOT NULL REFERENCES students(id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'absent')),
  marked_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_year_id, employee_id, student_id, day)
);
CREATE TABLE stay_attendance_changes (
  id bigserial PRIMARY KEY,
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES employees(id),
  student_id integer NOT NULL REFERENCES students(id),
  day date NOT NULL,
  previous_status text CHECK (previous_status IN ('present', 'absent')),
  status text CHECK (status IN ('present', 'absent')),
  marked_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON stay_pupils
  FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON stay_attendance
  FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON stay_attendance_changes
  FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');
ALTER TABLE stay_pupils ENABLE ROW LEVEL SECURITY;
ALTER TABLE stay_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE stay_attendance_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stay_pupils, stay_attendance, stay_attendance_changes FROM PUBLIC;
REVOKE ALL ON SEQUENCE stay_attendance_changes_id_seq FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON stay_pupils, stay_attendance, stay_attendance_changes FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE stay_attendance_changes_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;
