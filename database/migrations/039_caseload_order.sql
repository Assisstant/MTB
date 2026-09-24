-- A therapist's own list of pupils, in the order they want to read it.
--
-- The owner, 24 Sep 2026: arrows to reorder a therapist's pupils, as the four
-- annual lists already have. The same three screens read that list — the
-- „Ученици по терапевт" tab, the printed list and the picker in a schedule
-- cell — and each sorted it its own way (class then name, name, label). One
-- stored order, read by all three, is the fix.
--
-- WHY `roster_order` AND NOT A COLUMN ON `therapist_students`. The order is
-- display only and has the same shape as the annual lists: absent means "not
-- placed yet" and sorts last, a stale key names nobody and is gone the next
-- time the list is arranged, and nothing here decides membership, identity,
-- eligibility or access. `therapist_students` is who is on the list; adding a
-- position to it would make every caseload write a candidate for reordering.
--
-- One list per therapist: `caseload:<therapists.id>`, member keys are
-- `students.public_id`, one year at a time like every other list. Only the
-- CHECK changes; no row is touched.

ALTER TABLE roster_order DROP CONSTRAINT IF EXISTS roster_order_list_check;
ALTER TABLE roster_order ADD CONSTRAINT roster_order_list_check
    CHECK (list IN ('students', 'teachers', 'therapists', 'classes') OR list ~ '^caseload:[1-9][0-9]*$');

COMMENT ON TABLE roster_order IS 'Preferred display order of one year''s four lists and of each therapist''s caseload (caseload:<therapist id>); never membership, identity, eligibility or access.';
