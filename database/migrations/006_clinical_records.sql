-- Stage 7 (plan v2): clinical records.
--
-- Rule applied throughout: columns for what you query, jsonb for what you
-- only display. Assessment scores, audiogram curves and triage detail are
-- rendered as a whole and never filtered field-by-field, so they stay jsonb;
-- dates, periods, averages and the student link are columns because reports
-- group by them.

-- Dossier (досие). One per student, so the student id is the primary key.
CREATE TABLE IF NOT EXISTS student_records (
    student_id       integer PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    first_name       text,
    last_name        text,
    birth_date       date,
    father_name      text,
    mother_name      text,
    address          text,
    residence        text,
    contact          text,
    findings         text,
    opinion          text,
    attachment_links jsonb,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Rating scales (0-4). Template ids are strings like "general_v2".
CREATE TABLE IF NOT EXISTS scale_templates (
    id          serial PRIMARY KEY,
    sdnevnik_id text UNIQUE NOT NULL,
    name        text NOT NULL,
    category    text,
    indicators  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
    id          serial PRIMARY KEY,
    sdnevnik_id bigint UNIQUE,
    student_id  integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    template_id integer REFERENCES scale_templates(id) ON DELETE SET NULL,
    date        date,
    period      text CHECK (period IN ('T1', 'T2', 'T3', 'T4')),
    scores      jsonb NOT NULL,
    average     numeric(4, 2),
    comment     text
);

CREATE INDEX IF NOT EXISTS idx_assessments_student ON assessments(student_id, date);

CREATE TABLE IF NOT EXISTS triage_tests (
    id          serial PRIMARY KEY,
    sdnevnik_id bigint UNIQUE,
    student_id  integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    test_date   date,
    assessor    text,
    payload     jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triage_student ON triage_tests(student_id, test_date);

-- Audiograms carry only a subject NAME, never a student id, and some name
-- people who are not (or are no longer) in the roster. The original name is
-- kept and student_id stays NULL rather than guessing a match.
CREATE TABLE IF NOT EXISTS audiograms (
    id           serial PRIMARY KEY,
    student_id   integer REFERENCES students(id) ON DELETE SET NULL,
    subject_name text NOT NULL,
    date         date,
    record_type  text,
    right_air    jsonb,
    right_bone   jsonb,
    left_air     jsonb,
    left_bone    jsonb
);

CREATE INDEX IF NOT EXISTS idx_audiograms_student ON audiograms(student_id);
