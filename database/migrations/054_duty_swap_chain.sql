-- A day that was already swapped can be swapped again (owner, 1 Oct 2026):
-- A trades with B, and then B trades the day she got with C. Each swap stays
-- its own row, applied in the order it was made, so the record keeps every
-- step. The two unique indexes allowed a day in one swap only.
DROP INDEX IF EXISTS duty_swaps_first_day;
DROP INDEX IF EXISTS duty_swaps_second_day;
CREATE INDEX duty_swaps_first_day ON duty_swaps (school_year_id, first_day);
CREATE INDEX duty_swaps_second_day ON duty_swaps (school_year_id, second_day);
