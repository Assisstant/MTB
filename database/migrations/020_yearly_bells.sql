-- Bell times can change at a school-year boundary.
--
-- `bell_periods` remains the default timetable. A year stores only the rows
-- that differ from that default, so archived crossings keep the bells that
-- actually rang then without duplicating every unchanged schedule.

BEGIN;

CREATE TABLE IF NOT EXISTS bell_period_overrides (
    school_year_id integer  NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    bell_period_id integer  NOT NULL REFERENCES bell_periods(id) ON DELETE CASCADE,
    label          text,
    starts_at      time     NOT NULL,
    minutes        smallint NOT NULL CHECK (minutes > 0),
    PRIMARY KEY (school_year_id, bell_period_id)
);

-- From 2026/2027 the morning lessons use the same 40-minute blocks as
-- S-Dnevnik: 08:00-08:40, 08:45-09:25, and so on. Earlier years deliberately
-- keep the 07:30 sequence from migration 014.
INSERT INTO bell_period_overrides
       (school_year_id, bell_period_id, label, starts_at, minutes)
SELECT y.id,
       b.id,
       b.label,
       CASE b.ordinal
           WHEN 1 THEN time '08:00'
           WHEN 2 THEN time '08:45'
           WHEN 3 THEN time '09:40'
           WHEN 4 THEN time '10:25'
           WHEN 5 THEN time '11:10'
           WHEN 6 THEN time '11:55'
           WHEN 7 THEN time '12:40'
       END,
       40
FROM school_years y
JOIN bell_periods b
  ON b.schedule = 'nastava-am' AND b.ordinal BETWEEN 1 AND 7
WHERE y.starts_on >= date '2026-09-01'
ON CONFLICT (school_year_id, bell_period_id) DO NOTHING;

COMMIT;
