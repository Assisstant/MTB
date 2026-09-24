-- A third kind of form answer: a teacher's OWN week (docs/PLAN-formulari.md).
--
-- The owner decided on 24 Sep 2026 that every teacher — homeroom (одделенски
-- or класен) or subject-only — fills in a personal week: in each period, which
-- class and which subject. The class's week is then read off those, not typed a
-- second time. Such an answer is about a TEACHER, keyed like the others by
-- kind + normalised name (`teacher:име презиме`), so it needs its own kind.
--
-- Nothing else changes: no row is touched, no column added. The check is
-- replaced by name on THIS table (ALTER TABLE resolves through search_path, as
-- the constraint it replaces was created).

ALTER TABLE form_replies DROP CONSTRAINT IF EXISTS form_replies_kind_check;
ALTER TABLE form_replies ADD CONSTRAINT form_replies_kind_check
    CHECK (kind IN ('cabinet', 'class', 'teacher'));
