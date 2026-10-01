-- The colleagues' door under the owner's control (owner, 1 Oct 2026):
-- a maintenance mode, a lock per account, testers who pass maintenance, one
-- shared link that can be replaced, and a record of every such change.
--
-- Nothing here changes for anybody until the owner uses it: maintenance starts
-- off, no account is locked, and with no row in `portal_links` the plain
-- /kolegi address works exactly as before.

-- One row. `message` is what a colleague reads while the door is closed.
CREATE TABLE portal_security (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  maintenance boolean NOT NULL DEFAULT false,
  message text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- `locked`: this account cannot sign in. `tester`: passes maintenance.
-- `owner`: the owner's own colleague account — never locked, never held by
-- maintenance. Marked here and not by name, because this repository is public.
ALTER TABLE staff_accounts ADD COLUMN locked boolean NOT NULL DEFAULT false;
ALTER TABLE staff_accounts ADD COLUMN locked_at timestamptz;
ALTER TABLE staff_accounts ADD COLUMN tester boolean NOT NULL DEFAULT false;
ALTER TABLE staff_accounts ADD COLUMN owner boolean NOT NULL DEFAULT false;
ALTER TABLE staff_accounts ADD CONSTRAINT staff_accounts_owner_unlocked CHECK (NOT (owner AND locked));
CREATE UNIQUE INDEX staff_accounts_one_owner ON staff_accounts ((true)) WHERE owner;

-- The shared link: /kolegi/<code>. One is current (retired_at IS NULL); the
-- rest are the archive. The code is kept readable so the owner can copy the
-- current link again; it opens only the sign-in form, never an account.
-- `refused` counts requests that still arrived with a retired code.
CREATE TABLE portal_links (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{4}-[a-z0-9]{4}$'),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  refused integer NOT NULL DEFAULT 0,
  last_refused_at timestamptz
);
CREATE UNIQUE INDEX portal_links_one_current ON portal_links ((true)) WHERE retired_at IS NULL;

-- Every change made on the security page, and every refused sign-in of a
-- locked account. Written, never edited.
CREATE TABLE portal_security_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  employee_id integer REFERENCES employees(id),
  detail text,
  actor text
);
CREATE INDEX portal_security_log_at ON portal_security_log (at DESC);

-- The MTB server's own tables, never the Supabase browser Data API (036).
ALTER TABLE portal_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_security_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_security, portal_links, portal_security_log FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON portal_security, portal_links, portal_security_log FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
