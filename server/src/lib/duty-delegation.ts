/**
 * Short-lived capability links for administering only the cabinet duty rota.
 *
 * The owner creates one from Податоци → Колеги.  The raw token travels in the
 * URL fragment, which browsers never send to the server, and Kolega sends it
 * later in a dedicated header together with the colleague's ordinary portal
 * session.  A link therefore grants neither the rest of MTB administration
 * nor anonymous access.
 *
 * Entries deliberately live in memory.  A Render restart revokes them, which
 * is safer than turning a forwarded link into a permanent hidden account.
 * Only a SHA-256 digest is retained; the copyable token is returned once.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const DUTY_ADMIN_TOKEN_HEADER = 'x-mtb-duty-admin-token';
export const DUTY_ADMIN_HOURS = [2, 8, 24, 168] as const;

type DutyAdminHours = typeof DUTY_ADMIN_HOURS[number];
type Entry = {
    id: string;
    digest: string;
    createdAt: number;
    expiresAt: number;
};

const links = new Map<string, Entry>();
const tokenDigest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function prune(now = Date.now()): void {
    for (const [id, entry] of links) if (entry.expiresAt <= now) links.delete(id);
}

export type DutyAdminLink = {
    id: string;
    createdAt: string;
    expiresAt: string;
};

const publicEntry = (entry: Entry): DutyAdminLink => ({
    id: entry.id,
    createdAt: new Date(entry.createdAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString()
});

export function createDutyAdminLink(hours: DutyAdminHours): DutyAdminLink & { token: string } {
    prune();
    const token = randomBytes(32).toString('base64url');
    const entry: Entry = {
        id: randomUUID(),
        digest: tokenDigest(token),
        createdAt: Date.now(),
        expiresAt: Date.now() + hours * 60 * 60 * 1000
    };
    links.set(entry.id, entry);
    return { ...publicEntry(entry), token };
}

export function dutyAdminLinks(): DutyAdminLink[] {
    prune();
    return [...links.values()].sort((a, b) => a.expiresAt - b.expiresAt).map(publicEntry);
}

export function acceptDutyAdminLink(offered: unknown): DutyAdminLink | null {
    prune();
    const token = typeof offered === 'string' ? offered.trim() : '';
    // randomBytes(32).toString('base64url') is exactly 43 URL-safe characters.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = tokenDigest(token);
    const entry = [...links.values()].find((candidate) => candidate.digest === digest);
    return entry ? publicEntry(entry) : null;
}

export function revokeDutyAdminLinks(): number {
    prune();
    const count = links.size;
    links.clear();
    return count;
}
