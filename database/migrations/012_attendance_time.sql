-- 012 — the time an attendance mark belongs to.
--
-- Until now a mark was (student, date, slot_key, status). That is enough to
-- answer "was this child here", which is all the reports ever asked. It is NOT
-- enough to answer "how many SESSIONS did this child have", and that second
-- question is the one plan progress is built from.
--
-- The difference is merged terms. When two adjacent slots are one long session
-- the diary writes BOTH slot keys with the SAME time string:
--
--     monday-0 -> { status: 'present', time: '09:00-09:30 + 09:30-10:00' }
--     monday-1 -> { status: 'present', time: '09:00-09:30 + 09:30-10:00' }
--
-- and its own rebuildStudentProgress() then de-duplicates on date + time, so
-- that pair counts as ONE session and advances the plan by ONE activity. Two
-- genuinely separate consecutive terms look identical in (day, position) and
-- differ only in this string. Without it a derivation on this side would credit
-- two activities where the diary credits one, and the two would drift apart
-- with every merged term -- silently, because both numbers look plausible.
--
-- Additive and nullable on purpose (CLAUDE.md rule 4). NULL is not "unknown":
-- it means the mark carried no time, which is exactly the old bare-"present"
-- string shape, and which the diary's own rebuild also ignores.

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS time_slot text;

COMMENT ON COLUMN attendance.time_slot IS
    'The diary''s own time label for this mark, e.g. "09:00-09:30", or "09:00-09:30 + 09:30-10:00" for a merged term. Two rows sharing a date and this string are ONE session. NULL = a bare "present" string with no time, which carries no session information.';

-- Counting a student's sessions is what the progress derivation does on every
-- attendance write, so index for exactly that.
CREATE INDEX IF NOT EXISTS idx_attendance_present
    ON attendance (student_id, date) WHERE status = 'present';

-- Backfill from the blob, which has held the times all along.
--
-- Without this the column would be NULL for every existing mark until the next
-- ordinary save re-projected them -- and a progress derivation run before that
-- would see a student with no sessions and clear a year of progress. Making
-- the fix depend on someone remembering to save first is precisely the kind of
-- ordering trap this project has been bitten by before, so it is done here
-- instead. On a fresh database there is no blob and this is a no-op.
WITH marks AS MATERIALIZED (
    SELECT p.key   AS sdnevnik_id,
           d.key   AS date_text,
           k.key   AS slot_key,
           NULLIF(k.value ->> 'time', '') AS time_slot
    FROM app_state st
    CROSS JOIN LATERAL jsonb_each(st.payload -> 'attendance') AS d(key, value)
    CROSS JOIN LATERAL jsonb_each(d.value)                    AS p(key, value)
    CROSS JOIN LATERAL jsonb_each(p.value)                    AS k(key, value)
    WHERE st.app = 'sdnevnik'
      AND jsonb_typeof(st.payload -> 'attendance') = 'object'
      AND jsonb_typeof(d.value) = 'object'
      AND jsonb_typeof(p.value) = 'object'
      -- Only the object shape carries a time; a bare "present" string has none.
      AND jsonb_typeof(k.value) = 'object'
      -- Guards live HERE, before any cast. A key that is not a date or not a
      -- number would otherwise raise on the cast below, and the planner is free
      -- to evaluate a cast ahead of a filter written beside it. MATERIALIZED is
      -- what makes "before" mean before.
      AND d.key ~ '^\d{4}-\d{2}-\d{2}$'
      AND p.key ~ '^\d+$'
      AND NULLIF(k.value ->> 'time', '') IS NOT NULL
), typed AS MATERIALIZED (
    SELECT s.id AS student_id,
           to_date(m.date_text, 'YYYY-MM-DD') AS date,
           m.slot_key,
           m.time_slot
    FROM marks m
    JOIN students s ON s.sdnevnik_id = m.sdnevnik_id::bigint
)
UPDATE attendance a
SET time_slot = t.time_slot
FROM typed t
WHERE a.student_id = t.student_id
  AND a.date       = t.date
  AND a.slot_key   = t.slot_key
  AND a.time_slot IS NULL;
