-- Owner, 28 Sep 2026: duty-admin links stay valid until revoked, even after
-- a restart. Only hashes are stored. This is installation-local authorization,
-- not school data: never publish through Supabase REST or copy into a mirror.
CREATE TABLE duty_admin_links (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

ALTER TABLE duty_admin_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON duty_admin_links FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON duty_admin_links FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
