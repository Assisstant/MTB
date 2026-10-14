-- Акциски план по ученик, пополнуван од целиот тим преку Колега (owner, 14 Oct 2026).
--
-- The action plan of the evidence catalogue (023/024) puts a cabinet's section
-- on a pupil's sheet by deriving it from the caseload. The owner asked for the
-- opposite: which cabinet takes which pupil changes through the year, and
-- following that made the plan hard to keep. Here the cabinets in a pupil's
-- plan are CHOSEN and stay as chosen; everybody signed in through Kolega reads
-- and writes every part, and the control is the record of who wrote what.
--
-- A plan is a set of PARTS per pupil and year, each written and confirmed as a
-- whole by one person:
--   cabinets            which specialist categories are in the plan
--   phaseA, iop, yearEnd
--   review:<1-4>        the quarter's review
--   goal:<category>     a cabinet's starting state and goals
--   marks:<category>:<1-4>   a cabinet's areas with their level for a quarter
-- A quarter's marks carry their own area names, so one quarter can be read,
-- put back or given to another pupil without any other row.
--
-- A row is never deleted: an emptied part keeps its row and its version, so
-- "what I believed was there" cannot match a part that was emptied and written
-- again in between. Free text is stored as typed, never trimmed.
--
-- "Потврда": one person says "my part is done" — a name and a time on the
-- part. Writing a confirmed part opens it again; both are in the record.
--
-- The record keeps the whole part before and after. "Врати" is a NEW write
-- guarded by what the part holds now (routes/portal-plan.ts), never a rollback.

CREATE TABLE pupil_plan_parts (
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  student_id integer NOT NULL REFERENCES students(id),
  part text NOT NULL CHECK (part ~ '^(cabinets|phaseA|iop|yearEnd|review:[1-4]|goal:[a-z0-9_]{1,40}|marks:[a-z0-9_]{1,40}:[1-4])$'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) BETWEEN 1 AND 200),
  confirmed_at timestamptz,
  confirmed_by text,
  confirmed_by_employee integer REFERENCES employees(id) ON DELETE SET NULL,
  PRIMARY KEY (school_year_id, student_id, part),
  CONSTRAINT pupil_plan_parts_confirmed CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL))
);

CREATE TABLE pupil_plan_changes (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  student_id integer NOT NULL REFERENCES students(id),
  part text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('write', 'confirm', 'unconfirm', 'undo', 'move')),
  author_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
  author_name text NOT NULL CHECK (length(btrim(author_name)) BETWEEN 1 AND 200),
  -- The part as it stood and as it stands: { data, by, confirmed: { by, employeeId, at } | null },
  -- or null where there was no row yet.
  before jsonb,
  after jsonb NOT NULL,
  undo_of bigint REFERENCES pupil_plan_changes(id) ON DELETE SET NULL,
  undone_at timestamptz
);
CREATE INDEX pupil_plan_changes_recent ON pupil_plan_changes (school_year_id, id DESC);
CREATE INDEX pupil_plan_changes_part ON pupil_plan_changes (school_year_id, student_id, part, id);

-- 056's guard, for the two new tables that point at a pupil.
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON pupil_plan_parts
    FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');
CREATE TRIGGER guard_merged_pupil_student_id BEFORE INSERT OR UPDATE ON pupil_plan_changes
    FOR EACH ROW EXECUTE FUNCTION guard_merged_pupil_reference('student_id');

-- The MTB server's own tables, never the Supabase browser Data API (036).
ALTER TABLE pupil_plan_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pupil_plan_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pupil_plan_parts, pupil_plan_changes FROM PUBLIC;
REVOKE ALL ON SEQUENCE pupil_plan_changes_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON pupil_plan_parts, pupil_plan_changes FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE pupil_plan_changes_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE pupil_plan_parts IS 'A pupil''s action plan for a year, part by part, written through Kolega by the whole team (routes/portal-plan.ts).';
COMMENT ON TABLE pupil_plan_changes IS 'One row per accepted change of a plan part: who, when, the part before and after. Read by the administrator, who can put a part back or give a mistaken entry to the right pupil.';
