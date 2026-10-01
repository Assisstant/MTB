-- Which shared link a sign-in came in through (owner, 1 Oct 2026). Stopping an
-- archived link that was put back in use (053) used to sign out everybody but
-- the owner, because nothing recorded who had used which link. With this,
-- „Запри" ends only the sign-ins that came in through that link.
--
-- NULL means "not recorded": a sign-in made before this migration, or one made
-- through the plain /kolegi address while no link existed. No existing row
-- changes. A link is never deleted, but if one ever is, its sign-ins become
-- "not recorded" rather than disappearing with it.
ALTER TABLE staff_sessions ADD COLUMN link_id bigint REFERENCES portal_links(id) ON DELETE SET NULL;
CREATE INDEX staff_sessions_link ON staff_sessions (link_id) WHERE link_id IS NOT NULL;
