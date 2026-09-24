-- Answers to the offline forms, kept until the administrator has looked at them.
--
-- WHY A QUEUE AND NOT A WRITE. A colleague fills in a file at home, from the
-- state of the week on the day the file was made. By the time the answer comes
-- back the database may have moved, and one changed term can move the whole
-- timetable: the same child with another therapist at the same time, a slot
-- somebody else already changed. The owner decided (24 Sep 2026) that nothing
-- in an answer is written until the administrator has checked it, item by
-- item, and that an answer is not lost if the page is closed in between.
-- So an answer is STORED here first; the check is made again every time it is
-- opened (the database is compared as it is then, not as it was on arrival);
-- and every item that is written goes through the endpoint that already owns
-- that fact, with its `expected` check. This table decides nothing and writes
-- nothing else.
--
-- WHY `about_key` IS A NAME. The same therapist has a different numeric id at
-- WORK, at HOME and in the cloud. The owner's rule is that among answers about
-- the same employee the newest counts, and "the same employee" has to mean the
-- same person on whichever machine the file was made — so the key is the kind
-- plus the normalised name (`therapist:марија пример`), exactly as MTB_ADMIN
-- names people. Ids inside the answer are resolved again when it is reviewed.
--
-- NEWEST WINS, NOTHING IS DELETED. Several answers about one person: the one
-- with the latest `filled_at` stays `pending`; the others become `superseded`
-- and point at it. They are kept, because "what did she send on Monday?" is a
-- question the administrator may need to answer.
--
-- The answers carry children's names. They live in the local database only
-- (rules 1 and 6), like everything else here.

CREATE TABLE IF NOT EXISTS form_replies (
    id              serial      PRIMARY KEY,
    kind            text        NOT NULL CHECK (kind IN ('cabinet', 'class')),
    school_year_id  integer     NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    about_key       text        NOT NULL CHECK (length(about_key) BETWEEN 3 AND 200),
    about_name      text        NOT NULL,
    made_at         timestamptz,
    filled_at       timestamptz,
    file_name       text,
    fingerprint     text        NOT NULL UNIQUE,
    reply           jsonb       NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    received_by     text,
    status          text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'superseded', 'done', 'rejected')),
    superseded_by   integer     REFERENCES form_replies(id) ON DELETE SET NULL,
    closed_at       timestamptz,
    closed_by       text
);

CREATE INDEX IF NOT EXISTS idx_form_replies_year_about
    ON form_replies (school_year_id, kind, about_key, filled_at DESC);

-- One row per item the administrator decided. `outcome` says what happened
-- when it was written ('written', or the refusal in words), so a decision and
-- its effect are read together.
CREATE TABLE IF NOT EXISTS form_reply_decisions (
    reply_id    integer     NOT NULL REFERENCES form_replies(id) ON DELETE CASCADE,
    item_key    text        NOT NULL CHECK (length(item_key) BETWEEN 1 AND 300),
    decision    text        NOT NULL CHECK (decision IN ('accepted', 'rejected')),
    outcome     text,
    decided_by  text        NOT NULL,
    decided_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reply_id, item_key)
);

COMMENT ON TABLE form_replies IS
    'Answers to offline forms (cabinet / class), stored until the administrator reviews them. Newest per person pending, older superseded. Decides and writes nothing by itself.';
COMMENT ON TABLE form_reply_decisions IS
    'The administrator''s decision on each item of a stored form answer, and what writing it produced.';

-- These tables belong to the authenticated MTB server, never to the Supabase
-- REST roles: an answer holds children's names (as 036-038 do for theirs).
ALTER TABLE form_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_reply_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON form_replies, form_reply_decisions FROM PUBLIC;
REVOKE ALL ON SEQUENCE form_replies_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON form_replies, form_reply_decisions FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON SEQUENCE form_replies_id_seq FROM %I', api_role);
        END IF;
    END LOOP;
END $$;
