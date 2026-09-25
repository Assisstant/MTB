-- Colleagues online (docs/PLAN-kolegi-online.md, owner, 25 Sep 2026).
--
-- An account per EMPLOYEE (035): the username is the person's own name, read
-- from `employees`, so there is no second copy of it to drift. No row here
-- means the account has never been used; a row with no password means the
-- shared initial password still applies — keeping it is the colleague's
-- decision, and the administrator can put an account back on it.
CREATE TABLE staff_accounts (
  employee_id integer PRIMARY KEY REFERENCES employees(id),
  password_salt text,
  password_hash text,
  CHECK ((password_salt IS NULL) = (password_hash IS NULL)),
  changed_at timestamptz,
  reset_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only a HASH of the token is stored: a copy of this table must not be a key
-- to anybody's session.
CREATE TABLE staff_sessions (
  token_hash text PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX staff_sessions_employee ON staff_sessions(employee_id);

-- A clash somebody saved anyway, and the person it hits. Whether it is still
-- a clash is read from the live timetable, so one side moving away resolves it
-- without anybody closing it; `closed_at` is for putting it away by hand.
-- `sentence` is how it read when it happened, in the words the form used.
CREATE TABLE schedule_notices (
  id bigserial PRIMARY KEY,
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  author_employee_id integer REFERENCES employees(id),
  author_name text NOT NULL,
  recipient_employee_id integer NOT NULL REFERENCES employees(id),
  kind text NOT NULL CHECK (kind IN ('lesson', 'term')),
  day text NOT NULL,
  slot text NOT NULL,
  about text NOT NULL,
  sentence text NOT NULL,
  seen_at timestamptz,
  closed_at timestamptz
);
CREATE INDEX schedule_notices_recipient ON schedule_notices(recipient_employee_id, school_year_id);

-- The MTB server's own tables, never the Supabase browser Data API (036).
ALTER TABLE staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_accounts, staff_sessions, schedule_notices FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON staff_accounts, staff_sessions, schedule_notices FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
