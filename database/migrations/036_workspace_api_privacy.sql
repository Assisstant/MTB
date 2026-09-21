-- These tables belong to the authenticated MTB server, never the Supabase
-- browser Data API. Table owners retain normal direct PostgreSQL access.
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror_sync_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON employees, employee_roles, employee_identity_links,
  mirror_sync_state, mirror_sync_attempt FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON employees, employee_roles, employee_identity_links, mirror_sync_state, mirror_sync_attempt FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
