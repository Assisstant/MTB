-- Акциски план, фаза 3 (owner, 14 Oct 2026): „причина за промена".
--
-- The owner's proposal asks the plan's history to keep who changed it, when,
-- what — and why. 061 keeps the first three in pupil_plan_changes; this adds
-- the fourth, beside the change it explains. It is optional: a change saved
-- without a reason, and every row written before this, keeps NULL.
--
-- It belongs to the CHANGE, not to the part: a reason written into the part's
-- own data would be carried into every later save that did not touch it.
--
-- Additive only. Code that meets a database without this column does not offer
-- the field (routes/portal-plan.ts asks), so nothing typed is lost.

ALTER TABLE pupil_plan_changes ADD COLUMN reason text
  CONSTRAINT pupil_plan_changes_reason CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500);

COMMENT ON COLUMN pupil_plan_changes.reason IS 'Why the colleague made this change, as typed; optional, NULL where none was given.';
