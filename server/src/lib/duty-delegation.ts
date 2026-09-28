/**
 * Duty-only capability links. Owner decision, 28 Sep 2026: permanent by
 * default, until explicitly revoked, including across Render restarts.
 * PostgreSQL stores only a hash (048). The raw token is returned once in a
 * URL fragment; every use also requires an active colleague's own session.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const DUTY_ADMIN_TOKEN_HEADER = 'x-mtb-duty-admin-token';
export const DUTY_ADMIN_HOURS = [2, 8, 24, 168] as const;

export type DutyLinkDatabase = Pick<Pool, 'query'>;
type DutyAdminHours = typeof DUTY_ADMIN_HOURS[number] | null;
const tokenDigest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export type DutyAdminLink = {
    id: string;
    createdAt: string;
    expiresAt: string | null;
};

const publicEntry = (row: any): DutyAdminLink => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString()
});

export async function createDutyAdminLink(db: DutyLinkDatabase, hours: DutyAdminHours = null): Promise<DutyAdminLink & { token: string }> {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await db.query(
        `INSERT INTO duty_admin_links(id, token_hash, expires_at)
         VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + $3 * interval '1 hour' END)
         RETURNING id, created_at, expires_at`, [randomUUID(), tokenDigest(token), hours]);
    return { ...publicEntry(rows[0]), token };
}

export async function dutyAdminLinks(db: DutyLinkDatabase): Promise<DutyAdminLink[]> {
    const { rows } = await db.query(
        `SELECT id, created_at, expires_at FROM duty_admin_links
         WHERE expires_at IS NULL OR expires_at > now() ORDER BY expires_at NULLS LAST, created_at`);
    return rows.map(publicEntry);
}

export async function acceptDutyAdminLink(db: DutyLinkDatabase, offered: unknown): Promise<DutyAdminLink | null> {
    const token = typeof offered === 'string' ? offered.trim() : '';
    // randomBytes(32).toString('base64url') is exactly 43 URL-safe characters.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await db.query(
        `SELECT id, created_at, expires_at FROM duty_admin_links
         WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`, [tokenDigest(token)]);
    return rows.length ? publicEntry(rows[0]) : null;
}

export async function revokeDutyAdminLinks(db: DutyLinkDatabase): Promise<number> {
    const result = await db.query('DELETE FROM duty_admin_links');
    return result.rowCount || 0;
}
