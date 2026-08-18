-- S-Dnevnik generates its student ids with Date.now(), so real values look
-- like 1759384447857 — far beyond the 2147483647 ceiling of `integer`.
-- Found while importing the first real backup.

ALTER TABLE students ALTER COLUMN sdnevnik_id TYPE bigint;
