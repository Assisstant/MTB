-- Дежурства во кабинетите (owner, 25 Sep 2026).
--
-- One rotation per school year, continuous from its first day, so October
-- starts exactly where September ended. Only the INPUTS are stored: who is in
-- the rotation and in what order, and the dates somebody marked. Who is on
-- duty on a given day is CALCULATED from them (`server/src/lib/duty.ts`), so
-- the rota cannot disagree with itself, and a printed month is always the
-- same answer to the same inputs.
--
-- Until now the rota lived in one browser's storage, in an app of its own. Each
-- computer showed a different rota, and no colleague could see it.

-- When the rotation starts this year. Before it, nobody is on duty.
CREATE TABLE duty_settings (
  school_year_id integer PRIMARY KEY REFERENCES school_years(id) ON DELETE CASCADE,
  starts_on date NOT NULL
);

-- Who is in the rotation, in its order. `joined_on` / `left_on` let a person
-- come in or leave during the year without rewriting the months already
-- printed: a newcomer joins the queue at the back on that day.
CREATE TABLE duty_members (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES employees(id),
  position integer NOT NULL CHECK (position >= 1),
  joined_on date,
  left_on date,
  CHECK (left_on IS NULL OR joined_on IS NULL OR left_on > joined_on),
  PRIMARY KEY (school_year_id, employee_id)
);

-- A day somebody marked: closed (a holiday, an excursion — no duty, and the
-- rotation does not move), or given to a named person by agreement.
CREATE TABLE duty_days (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  day date NOT NULL,
  closed boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  assigned_employee_id integer REFERENCES employees(id),
  CHECK (NOT (closed AND assigned_employee_id IS NOT NULL)),
  PRIMARY KEY (school_year_id, day)
);

-- Somebody away on a day. The next person covers it, and the one away keeps
-- their place: they are on duty the next working day they are in (owner,
-- 25 Sep 2026). A colleague may mark their own; `marked_by` says who did.
CREATE TABLE duty_absences (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  day date NOT NULL,
  employee_id integer NOT NULL REFERENCES employees(id),
  marked_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_year_id, day, employee_id)
);

-- The MTB server's own tables, never the Supabase browser Data API (036).
ALTER TABLE duty_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_absences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON duty_settings, duty_members, duty_days, duty_absences FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON duty_settings, duty_members, duty_days, duty_absences FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE duty_members IS 'Дежурства: who is in the year''s rotation and in what order; the rota itself is calculated (lib/duty.ts).';
