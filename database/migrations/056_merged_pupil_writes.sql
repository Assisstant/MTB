-- A merged pupil stays as an inactive identity alias. Its foreign key still
-- exists, so an old request could otherwise attach new records AFTER the
-- merge. Enforce this at the database boundary, for every pupil reference.
-- No stored pupil or record is changed by this migration.
CREATE FUNCTION guard_merged_pupil_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pupil_id bigint := (to_jsonb(NEW)->>TG_ARGV[0])::bigint;
    reason text;
BEGIN
    IF pupil_id IS NULL THEN RETURN NEW; END IF;
    -- The merge takes FOR UPDATE. Hold a conflicting shared lock until the
    -- write commits; after waiting for a merge, read its final marker.
    SELECT left_reason INTO reason FROM students WHERE id = pupil_id FOR SHARE;
    IF reason LIKE 'merged:%' THEN
        RAISE EXCEPTION 'The pupil was merged; reload before saving this record.'
            USING ERRCODE = '23514', CONSTRAINT = 'students_merged_reference';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
DECLARE fk record;
BEGIN
    FOR fk IN
        SELECT c.conrelid::regclass AS relation, a.attname AS column_name
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = 'students'::regclass
           AND array_length(c.conkey, 1) = 1
    LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference(%L)',
                       'guard_merged_pupil_' || fk.column_name, fk.relation, fk.column_name);
    END LOOP;
END;
$$;

CREATE FUNCTION guard_merged_pupil_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.left_reason LIKE 'merged:%' AND
        (NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.left_reason IS DISTINCT FROM OLD.left_reason))
       OR (NEW.left_reason LIKE 'merged:%' AND (NEW.active OR NEW.sdnevnik_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'The pupil was merged; reload before changing this identity.'
            USING ERRCODE = '23514', CONSTRAINT = 'students_merged_reference';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_merged_pupil_identity BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_identity();
