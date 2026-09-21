-- One person may hold teaching and therapy profiles. Existing identities are
-- preserved individually: matching names are never evidence for merging.
CREATE TABLE employees (
  id serial PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  identifier text UNIQUE,
  superseded_by integer REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (superseded_by IS NULL OR superseded_by <> id)
);
ALTER TABLE teachers ADD COLUMN employee_id integer UNIQUE REFERENCES employees(id);
ALTER TABLE therapists ADD COLUMN employee_id integer UNIQUE REFERENCES employees(id);
DO $$
DECLARE item record; person integer;
BEGIN
  FOR item IN SELECT id, name FROM teachers ORDER BY id LOOP
    INSERT INTO employees(name) VALUES(item.name) RETURNING id INTO person;
    UPDATE teachers SET employee_id=person WHERE id=item.id;
  END LOOP;
  FOR item IN SELECT id, name FROM therapists ORDER BY id LOOP
    INSERT INTO employees(name) VALUES(item.name) RETURNING id INTO person;
    UPDATE therapists SET employee_id=person WHERE id=item.id;
  END LOOP;
END $$;
ALTER TABLE teachers ALTER COLUMN employee_id SET NOT NULL;
ALTER TABLE therapists ALTER COLUMN employee_id SET NOT NULL;

-- Teacher/therapist active membership remains in the existing year tables.
-- Additional duties do not confer API permissions or imply a therapy cabinet.
CREATE TABLE employee_roles (
  employee_id integer NOT NULL REFERENCES employees(id),
  school_year_id integer NOT NULL REFERENCES school_years(id),
  role text NOT NULL CHECK (role IN ('specialist', 'administration')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(employee_id, school_year_id, role)
);
CREATE TABLE employee_identity_links (
  source_id integer PRIMARY KEY REFERENCES employees(id),
  target_id integer NOT NULL REFERENCES employees(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id)
);

CREATE FUNCTION employee_profile_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mtb.mirror_apply', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NEW.employee_id IS NULL THEN
    INSERT INTO employees(name) VALUES(NEW.name) RETURNING id INTO NEW.employee_id;
  ELSIF TG_OP = 'INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    SELECT name INTO NEW.name FROM employees WHERE id=NEW.employee_id AND superseded_by IS NULL;
    IF NEW.name IS NULL THEN RAISE EXCEPTION 'Employee identity is unavailable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teacher_employee_identity BEFORE INSERT OR UPDATE ON teachers
  FOR EACH ROW EXECUTE FUNCTION employee_profile_identity();
CREATE TRIGGER therapist_employee_identity BEFORE INSERT OR UPDATE ON therapists
  FOR EACH ROW EXECUTE FUNCTION employee_profile_identity();

-- Propagate legacy renames AFTER the originating row has changed, so the
-- canonical-name trigger never tries to modify a row mid-update.
CREATE FUNCTION employee_profile_rename() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mtb.mirror_apply', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND pg_trigger_depth() = 1 THEN
    UPDATE employees SET name=NEW.name WHERE id=NEW.employee_id AND name IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teacher_employee_rename AFTER UPDATE OF name ON teachers
  FOR EACH ROW EXECUTE FUNCTION employee_profile_rename();
CREATE TRIGGER therapist_employee_rename AFTER UPDATE OF name ON therapists
  FOR EACH ROW EXECUTE FUNCTION employee_profile_rename();

CREATE FUNCTION employee_profile_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mtb.mirror_apply', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE teachers SET name=NEW.name WHERE employee_id=NEW.id AND name IS DISTINCT FROM NEW.name;
    UPDATE therapists SET name=NEW.name WHERE employee_id=NEW.id AND name IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_name_profiles AFTER UPDATE OF name ON employees
  FOR EACH ROW EXECUTE FUNCTION employee_profile_name();
