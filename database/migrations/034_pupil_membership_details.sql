-- Annual pupil facts are independent. Keep kind as the legacy encoding so
-- existing imports, exports and older clients remain compatible.
ALTER TABLE student_enrollments
  ADD COLUMN enrollment_type text,
  ADD COLUMN boarding boolean,
  ADD COLUMN programme text NOT NULL DEFAULT 'unknown',
  ADD COLUMN placement text NOT NULL DEFAULT 'unknown';

-- Only facts already explicitly encoded by kind are copied. A class label
-- does not prove a programme, placement or the pupil's generation.
UPDATE student_enrollments
SET enrollment_type = CASE WHEN kind = 'external' THEN 'external' ELSE 'internal' END,
    boarding = (kind = 'boarding');

ALTER TABLE student_enrollments
  ALTER COLUMN enrollment_type SET NOT NULL,
  ALTER COLUMN boarding SET NOT NULL,
  ADD CONSTRAINT enrollment_type_check CHECK (enrollment_type IN ('internal', 'external')),
  ADD CONSTRAINT boarding_requires_internal CHECK (NOT boarding OR enrollment_type = 'internal'),
  ADD CONSTRAINT enrollment_programme_check CHECK (programme IN ('unknown', 'standard', 'modified')),
  ADD CONSTRAINT enrollment_placement_check CHECK (placement IN ('unknown', 'regular', 'preparatory', 'observation', 'none'));

CREATE FUNCTION synchronize_enrollment_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.enrollment_type := coalesce(NEW.enrollment_type,
      CASE WHEN NEW.kind = 'external' THEN 'external' ELSE 'internal' END);
    NEW.boarding := coalesce(NEW.boarding, NEW.kind = 'boarding');
  ELSIF NEW.enrollment_type IS NOT DISTINCT FROM OLD.enrollment_type
    AND NEW.boarding IS NOT DISTINCT FROM OLD.boarding
    AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    -- A legacy caller changed the compatibility field explicitly.
    NEW.enrollment_type := CASE WHEN NEW.kind = 'external' THEN 'external' ELSE 'internal' END;
    NEW.boarding := NEW.kind = 'boarding';
  END IF;
  NEW.kind := CASE WHEN NEW.enrollment_type = 'external' THEN 'external'
                   WHEN NEW.boarding THEN 'boarding' ELSE 'internal' END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollment_kind_compatibility
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION synchronize_enrollment_kind();

COMMENT ON COLUMN student_enrollments.enrollment_type IS 'Explicit annual internal/external membership; kind is its legacy encoding together with boarding.';
COMMENT ON COLUMN student_enrollments.boarding IS 'Annual boarding provision, independent of programme and teaching placement.';
COMMENT ON COLUMN student_enrollments.programme IS 'Explicit annual standard/modified programme; unknown is never inferred from pupil kind or class.';
COMMENT ON COLUMN student_enrollments.placement IS 'Explicit annual local teaching placement; unknown is never inferred from the class label.';
