-- Explicitly assigned by the owner; job titles never grant portal permissions.
-- Existing passwords and sessions remain intact. Each request rereads the role.
ALTER TABLE staff_accounts ADD COLUMN read_only boolean NOT NULL DEFAULT false;
