-- An archived link can be put back in use by hand (owner, 1 Oct 2026): a
-- colleague who never got the new link keeps the old one working, while the
-- current link stays the one that is handed out. Every existing link starts
-- not allowed, so nothing that was stopped comes back by itself.
ALTER TABLE portal_links ADD COLUMN allowed boolean NOT NULL DEFAULT false;
ALTER TABLE portal_links ADD COLUMN allowed_at timestamptz;
-- Only an archived link is "allowed again"; the current one simply works.
ALTER TABLE portal_links ADD CONSTRAINT portal_links_allowed_archived CHECK (NOT allowed OR retired_at IS NOT NULL);
