-- A confirmed ongoing week: durable server activation, with a recovery copy.
CREATE TABLE diary_cabinet_changes (
    id uuid PRIMARY KEY,
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    therapist_id integer NOT NULL REFERENCES therapists(id),
    from_week date NOT NULL CHECK (extract(isodow FROM from_week) = 1),
    week jsonb NOT NULL,
    times jsonb NOT NULL,
    expected_blocks jsonb NOT NULL,
    before_diary jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('scheduled','applied','blocked','superseded')),
    problem jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz
);
CREATE INDEX diary_cabinet_changes_due ON diary_cabinet_changes(from_week) WHERE status = 'scheduled';
ALTER TABLE diary_cabinet_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON diary_cabinet_changes FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('REVOKE ALL ON diary_cabinet_changes FROM %I',r);
        END IF;
    END LOOP;
END $$;
