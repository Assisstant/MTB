-- Successful Supabase -> local mirror applications.
--
-- This row is committed in the SAME transaction as the mirrored business
-- tables.  A downloaded file, a started import, or a rolled-back transaction
-- is therefore never reported as a successful sync.

CREATE TABLE IF NOT EXISTS mirror_sync_state (
    source_id          text PRIMARY KEY,
    snapshot_id        text NOT NULL,
    source_version     bigint NOT NULL,
    source_snapshot_at timestamptz NOT NULL,
    content_hash       text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload_hash       text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    format_version     integer NOT NULL CHECK (format_version > 0),
    table_counts       jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied_at         timestamptz NOT NULL DEFAULT now()
);

-- Attempts are separate because a failed transaction cannot update the success
-- row it just rolled back. Error codes are intentionally coarse: database
-- constraint messages can contain personal values and do not belong in status.
CREATE TABLE IF NOT EXISTS mirror_sync_attempt (
    source_id   text PRIMARY KEY,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    succeeded   boolean NOT NULL,
    error_code  text
);
