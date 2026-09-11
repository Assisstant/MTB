-- 028 required, in both directions, that external meant no grade. That was
-- wrong under the owner's 8 September clarification: an external pupil can
-- attend local preparatory/modified teaching, so an active external student
-- CAN legitimately carry a grade. Internal and boarding still must have one
-- -- that half of 028 was correct and stays.
--
-- DROP ... IF EXISTS then ADD, same as 028: this replaces that constraint in
-- place rather than adding a second one beside it, so the table only ever
-- carries one rule under this name.

ALTER TABLE student_enrollments
  DROP CONSTRAINT IF EXISTS kind_matches_grade;

ALTER TABLE student_enrollments
  ADD CONSTRAINT kind_matches_grade
  CHECK (
    NOT active
    OR (
      (kind IN ('internal', 'boarding') AND grade IS NOT NULL AND btrim(grade) <> '')
      OR (kind = 'external')
    )
  );
