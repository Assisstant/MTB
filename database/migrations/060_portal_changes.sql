-- The administrator's safety net for the colleagues' door (owner, 13 Oct 2026).
--
-- A term a colleague writes in their own cabinet through Kolega replaced the
-- one before it and left no trace: who changed it, when, and what stood there.
-- The owner asked for a way to see the state a colleague started from and to
-- put a term back. Each accepted write of a block now leaves ONE row here, in
-- the same transaction as the write: the block, who wrote it, and the pupils
-- before and after. A block is one therapist's 40-minute bell on one day, as
-- the block writer (routes/schedule-write.ts) understands it.
--
-- Pupils are kept as public ids, never names: a name is read from `students`
-- when the log is shown, so a corrected name is shown corrected and no second
-- copy of a child's name is stored.
--
-- "Undo" is a NEW write through the same block writer, guarded by what the
-- block holds now; it adds its own row (`undo_of`) and marks the row it put
-- back (`undone_at`). Nothing here is ever replayed or rolled back.

CREATE TABLE portal_changes (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  therapist_id integer NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  author_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
  author_name text NOT NULL CHECK (length(btrim(author_name)) BETWEEN 1 AND 200),
  day text NOT NULL,
  slot text NOT NULL,
  before_ids text[] NOT NULL,
  after_ids text[] NOT NULL,
  -- The exact minutes each of those pupils held, in the same order. A legacy
  -- row can be one lone half ("08:20-08:40"); the pupil alone would read as
  -- the whole bell, and putting it back would change how long the term is.
  before_times text[] NOT NULL,
  after_times text[] NOT NULL,
  forced boolean NOT NULL DEFAULT false,
  undo_of bigint REFERENCES portal_changes(id) ON DELETE SET NULL,
  undone_at timestamptz,
  CONSTRAINT portal_changes_changed CHECK (before_ids <> after_ids OR before_times <> after_times),
  CONSTRAINT portal_changes_block CHECK (cardinality(before_ids) <= 2 AND cardinality(after_ids) <= 2),
  CONSTRAINT portal_changes_times CHECK (cardinality(before_times) = cardinality(before_ids)
                                     AND cardinality(after_times) = cardinality(after_ids))
);
CREATE INDEX portal_changes_recent ON portal_changes (school_year_id, created_at DESC);
CREATE INDEX portal_changes_block_idx ON portal_changes (school_year_id, therapist_id, day, slot, id);

-- The MTB server's own table, never the Supabase browser Data API (036).
ALTER TABLE portal_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_changes FROM PUBLIC;
REVOKE ALL ON SEQUENCE portal_changes_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON portal_changes FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE portal_changes_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE portal_changes IS 'One row per block a colleague changed through Kolega: who, when, pupils before and after. Read and undone only by the administrator (routes/portal-changes.ts).';
