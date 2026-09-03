-- 013 -- audiograms get an identity of their own.
--
-- Every other clinical record carries an id the diary assigned it: assessments
-- and triage tests have Date.now() values, scale templates have strings like
-- "general_v2". Audiograms have nothing. They arrive from standalone exports
-- and from merged files and are described only by whose hearing they are, when
-- it was measured, and the curves themselves.
--
-- That is why the projection deletes EVERY audiogram row and re-inserts the
-- whole list on every single save. It works, and it is the only thing that can
-- work without an identity -- but it makes a per-record write impossible: there
-- is no name for the record you want to change, and no way to tell "this one
-- was edited" from "this one is new and that one is gone".
--
-- So the identity is derived from the content: subject, date, kind and the four
-- curves, hashed. Computed identically in the app and in the server, the same
-- arrangement `stableStudentIdForName` already uses and for the same reason --
-- two machines must land on the same id without talking to each other.
--
-- Consequence worth stating plainly: two audiograms with the same subject, the
-- same date, the same kind and identical curves become ONE row. They are
-- indistinguishable in the data, so keeping both would mean keeping a
-- difference nobody can see or act on.

ALTER TABLE audiograms ADD COLUMN IF NOT EXISTS sdnevnik_id text;

COMMENT ON COLUMN audiograms.sdnevnik_id IS
    'Derived from the record''s own content (subject, date, kind, curves), because an audiogram carries no id of its own. Both the app and the server compute it the same way so two machines agree without coordinating.';

-- The existing rows have no id and cannot be given one here: the hash is over
-- values this table stores as jsonb, whose key order is not the order the app
-- sent, and a backfill that got it subtly wrong would be worse than none.
--
-- Emptying the table instead costs nothing, and that is a measurement rather
-- than a hope: the projection has replaced every audiogram row on every save
-- since the table existed, so its whole content is already a copy of the blob
-- and the next ordinary save puts it back -- this time with ids. Nothing here
-- is anyone's only copy.
DELETE FROM audiograms;

-- NOT NULL and a plain UNIQUE, not a partial index.
--
-- Partial was the first attempt and it does not work: `ON CONFLICT
-- (sdnevnik_id)` cannot infer an index that carries a WHERE clause, so every
-- upsert failed with "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" and the whole projection rolled back -- audiograms,
-- assessments, dossiers, all of it, on every save.
--
-- Plain is also the truthful shape. A row without an id is a row nothing can
-- name, update or delete; allowing one would only postpone the problem this
-- migration exists to solve.
ALTER TABLE audiograms ALTER COLUMN sdnevnik_id SET NOT NULL;

ALTER TABLE audiograms DROP CONSTRAINT IF EXISTS audiograms_sdnevnik_id_key;
ALTER TABLE audiograms ADD CONSTRAINT audiograms_sdnevnik_id_key UNIQUE (sdnevnik_id);
