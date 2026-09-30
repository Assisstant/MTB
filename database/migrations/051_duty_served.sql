-- Дежурства: who actually served, when it was not the person the rota names
-- (owner, 30 Sep 2026).
--
-- A colleague marked on sick leave came in after all, and another covered her
-- day on the spot. The rota's queue is NOT changed by that: the day stays the
-- rota person's turn, and only the name on it is corrected. What it does
-- change is the count per cycle — the one who stepped in has two duties in
-- that cycle, the one replaced none — and the page shows that balance so the
-- next cycle can even it out (lib/duty.ts `applyServed`, `cycleTally`).
--
-- Additive: a nullable column, NULL for every existing day.
ALTER TABLE duty_days ADD COLUMN served_employee_id integer REFERENCES employees(id);
ALTER TABLE duty_days ADD CONSTRAINT duty_days_served_open
  CHECK (NOT (closed AND served_employee_id IS NOT NULL));

COMMENT ON COLUMN duty_days.served_employee_id IS 'Дежурства: who actually served that day, when it differs from the rota; the queue is untouched.';
