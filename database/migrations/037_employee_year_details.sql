-- Profession and duties describe annual employment, not access or scheduling.
-- No existing person is classified or activated by this migration.
CREATE TABLE employee_year_details (
    employee_id integer NOT NULL REFERENCES employees(id),
    school_year_id integer NOT NULL REFERENCES school_years(id),
    profession_code text NOT NULL DEFAULT 'unknown' CHECK (profession_code IN
        ('unknown','teacher','spec_edukator','logoped','psiholog','pedagog','vospituvac','socijalen_rabotnik','other')),
    job_title text NOT NULL DEFAULT '' CHECK (length(job_title) <= 200),
    duties text[] NOT NULL DEFAULT '{}' CHECK (
        cardinality(duties) <= 9 AND array_position(duties, NULL) IS NULL AND duties <@
        ARRAY['teaching','modified_teaching','preparatory_group','individual_rehabilitation',
              'counselling','assistant_coordination','mentoring','administration','boarding']::text[]),
    PRIMARY KEY (employee_id, school_year_id)
);
COMMENT ON TABLE employee_year_details IS 'Annual profession and work duties; no automatic teacher/therapist profile, caseload, permission or schedule.';
ALTER TABLE employee_year_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON employee_year_details FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON employee_year_details FROM %I', api_role);
        END IF;
    END LOOP;
END $$;
