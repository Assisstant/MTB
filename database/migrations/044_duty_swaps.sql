-- Дежурства: a swap between two colleagues (owner, 25 Sep 2026).
--
-- One of them has something on their day, the other does them a favour: A
-- takes B's day and B takes A's. It is a deal between two people, not a change
-- of the list, so the rotation is worked out exactly as before and only the
-- two days trade names afterwards (`applySwaps`, server/src/lib/duty.ts).
--
-- Each side names the day AND the person, because the deal was made between
-- those two. If the rota later moves (somebody's sick leave, a day closed)
-- and one of those days no longer belongs to that person, the swap no longer
-- applies and the administrator is told. Nothing is swapped between people
-- who never agreed to it.
CREATE TABLE duty_swaps (
  id bigserial PRIMARY KEY,
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  first_day date NOT NULL,
  first_employee_id integer NOT NULL REFERENCES employees(id),
  second_day date NOT NULL,
  second_employee_id integer NOT NULL REFERENCES employees(id),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_day < second_day),
  CHECK (first_employee_id <> second_employee_id)
);
-- A day is in one swap at most. (A day that is the first of one swap and the
-- second of another is refused by the route, under a table lock.)
CREATE UNIQUE INDEX duty_swaps_first_day ON duty_swaps (school_year_id, first_day);
CREATE UNIQUE INDEX duty_swaps_second_day ON duty_swaps (school_year_id, second_day);

-- The MTB server's own table, never the Supabase browser Data API (036).
ALTER TABLE duty_swaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON duty_swaps FROM PUBLIC;
REVOKE ALL ON SEQUENCE duty_swaps_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON duty_swaps FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE duty_swaps_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE duty_swaps IS 'Дежурства: two colleagues trade days; the list and the rotation are untouched (lib/duty.ts applySwaps).';
