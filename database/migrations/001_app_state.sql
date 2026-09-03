-- Stage 2.5: single-row-per-app blob storage for the Unified Sync JSON.
-- Applied manually on 2026-08-17 to therapy_dev.

CREATE TABLE IF NOT EXISTS app_state (
    app         text PRIMARY KEY,
    version     integer NOT NULL DEFAULT 1,
    payload     jsonb   NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text
);
