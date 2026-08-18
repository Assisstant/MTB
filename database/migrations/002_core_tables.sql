-- Stage 4 (plan v2): first relational tables.
-- These live ALONGSIDE app_state — the apps keep using the jsonb blob while
-- these tables are populated by scripts/import-json.ts. Nothing here breaks
-- the running applications.

CREATE TABLE IF NOT EXISTS students (
    id           serial PRIMARY KEY,
    -- The stable string id the apps already share (studentMeta.studentId /
    -- rasporediStudentId). This is the canonical identity across both apps.
    public_id    text UNIQUE NOT NULL,
    -- The old S-Dnevnik numeric id. Kept for traceability during migration:
    -- attendance, assessments and dossiers still hang off it today.
    sdnevnik_id  integer UNIQUE,
    name         text NOT NULL,
    grade        text,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS therapists (
    id         serial PRIMARY KEY,
    name       text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Which students belong to which therapist (Rasporedi's therapistStudents).
CREATE TABLE IF NOT EXISTS therapist_students (
    therapist_id integer NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
    student_id   integer NOT NULL REFERENCES students(id)   ON DELETE CASCADE,
    PRIMARY KEY (therapist_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_therapist_students_student ON therapist_students(student_id);
