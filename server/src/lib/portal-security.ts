/**
 * The colleagues' door under the owner's control (owner, 1 Oct 2026;
 * migration 052): maintenance mode, a lock per account, testers, one shared
 * link that can be replaced, and a record of every change.
 *
 * ONE HOOK DECIDES, for every `/api/portal/` path. The door has routes in two
 * files (routes/portal.ts, routes/duty.ts) and will get more; a check each
 * route must remember to call is the one that gets forgotten. Sign-in is the
 * exception, because who is asking is known only after the password: the
 * login route calls `accountRefusal` itself.
 *
 * WHO PASSES. The owner's two-hour look at a colleague's form is the owner,
 * and passes everything. The account marked `owner` passes maintenance and
 * cannot be locked. A `tester` passes maintenance. Everybody needs the
 * current link's code once one exists — it is a second thing an outsider
 * must have, since the username is only a name.
 *
 * A DATABASE WITHOUT 052 behaves as before: the door is open. The code can
 * reach an installation a start before its migration does.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { isInternal } from './internal.js';
import { PORTAL_TOKEN_HEADER, sessionEmployee } from './staff-accounts.js';

type Queryable = Pick<PoolClient, 'query'>;

export const PORTAL_KEY_HEADER = 'x-mtb-portal-key';
/** Locked: the request was understood and the door is closed to it. */
export const DOOR_STATUS = 423;

export type DoorRefusal = { door: 'link' | 'maintenance' | 'locked'; error: string };

const MESSAGES = {
    link: 'Линкот за колегите е променет и овој повеќе не важи. Ве молиме побарајте го новиот линк од администраторот. Ви благодариме на разбирањето.',
    maintenance: 'Системот моментално се одржува. Ве молиме обидете се малку подоцна. Ви благодариме на трпението.',
    locked: 'Пристапот со оваа сметка е привремено запрен. Ве молиме јавете се кај администраторот.'
};

/** No ambiguous letters: the code is read off a phone and typed by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newCode(): string {
    const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${part()}-${part()}`;
}

/** MTB_MAINTENANCE=1 closes the door whatever the page says: the switch that works when the page does not. */
export const maintenanceForced = (env: NodeJS.ProcessEnv = process.env) => env.MTB_MAINTENANCE === '1';

const missing = (err: any) => err && (err.code === '42P01' || err.code === '42703');

type DoorState = { maintenance: boolean; message: string | null; code: string | null };

/** The door as it stands, or null on a database that has no 052 yet. */
export async function doorState(db: Queryable = pool): Promise<DoorState | null> {
    try {
        const { rows } = await db.query(
            `SELECT (SELECT maintenance FROM portal_security) AS maintenance,
                    (SELECT message FROM portal_security) AS message,
                    (SELECT code FROM portal_links WHERE retired_at IS NULL) AS code`);
        return { maintenance: Boolean(rows[0].maintenance) || maintenanceForced(), message: rows[0].message || null, code: rows[0].code || null };
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

const same = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

const maintenanceRefusal = (state: DoorState): DoorRefusal =>
    ({ door: 'maintenance', error: state.message || MESSAGES.maintenance });

/** May this account come in now? Asked at sign-in and on every request after it. */
export async function accountRefusal(db: Queryable, employeeId: number, state?: DoorState | null): Promise<DoorRefusal | null> {
    const door = state === undefined ? await doorState(db) : state;
    if (!door) return null;
    const { rows } = await db.query('SELECT locked, tester, owner FROM staff_accounts WHERE employee_id = $1', [employeeId]);
    const account = rows[0] || {};
    if (account.owner) return null;
    if (account.locked) return { door: 'locked', error: MESSAGES.locked };
    if (door.maintenance && !account.tester) return maintenanceRefusal(door);
    return null;
}

/** What a page with no sign-in is told: only whether the door is in maintenance. */
export async function doorNotice(db: Queryable = pool): Promise<{ ok: true; maintenance: boolean; message?: string }> {
    const state = await doorState(db);
    return state && state.maintenance
        ? { ok: true, maintenance: true, message: state.message || MESSAGES.maintenance }
        : { ok: true, maintenance: false };
}

let actingCheck: (token: unknown) => boolean = () => false;
/** routes/portal.ts holds the owner's two-hour looks in memory; it says which tokens they are. */
export function setActingCheck(check: (token: unknown) => boolean): void { actingCheck = check; }

/** A retired link still in use is worth knowing about; the count is on the security page. */
async function noteRetiredUse(db: Queryable, offered: string): Promise<void> {
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(offered)) return;
    await db.query(
        `UPDATE portal_links SET refused = refused + 1, last_refused_at = now()
          WHERE code = $1 AND retired_at IS NOT NULL`, [offered]);
}

export async function doorRefusal(req: FastifyRequest, db: Queryable = pool): Promise<DoorRefusal | null> {
    const path = String(req.url || '').split('?')[0];
    if (!path.startsWith('/api/portal/') || req.method === 'OPTIONS') return null;
    if (isInternal(req)) return null;
    const token = req.headers[PORTAL_TOKEN_HEADER];
    if (actingCheck(token)) return null;
    // Signing out is always allowed: it only ends a session.
    if (path === '/api/portal/logout') return null;
    const state = await doorState(db);
    if (!state) return null;
    if (state.code) {
        const offered = String(req.headers[PORTAL_KEY_HEADER] || '').trim().toLowerCase();
        if (!same(offered, state.code)) {
            if (offered) await noteRetiredUse(db, offered);
            return { door: 'link', error: MESSAGES.link };
        }
    }
    // The page asking how the door stands, and sign-in, which checks the
    // account itself once it knows whose it is.
    if (path === '/api/portal/door' || path === '/api/portal/login') return null;
    const employeeId = await sessionEmployee(db, token);
    if (!employeeId) return null; // the route answers 401
    return accountRefusal(db, employeeId, state);
}

/** On the ROOT instance, before the route plugins: a plugin-local hook would miss the door's routes in other files. */
export function installPortalDoor(server: FastifyInstance): void {
    server.addHook('onRequest', async (req, reply) => {
        const refusal = await doorRefusal(req);
        if (refusal) return reply.code(DOOR_STATUS).header('Cache-Control', 'no-store').send(refusal);
    });
}

// ── the owner's side ───────────────────────────────────────────────────────

export async function logChange(db: Queryable, action: string, actor: string | null, employeeId: number | null = null, detail: string | null = null): Promise<void> {
    await db.query('INSERT INTO portal_security_log (action, employee_id, detail, actor) VALUES ($1, $2, $3, $4)',
        [action, employeeId, detail, actor]);
}

export async function setMaintenance(db: Queryable, on: boolean, message: string | null, actor: string | null): Promise<void> {
    await db.query(
        `INSERT INTO portal_security (id, maintenance, message, changed_at) VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET maintenance = EXCLUDED.maintenance, message = EXCLUDED.message, changed_at = now()`,
        [on, message]);
    await logChange(db, on ? 'maintenance_on' : 'maintenance_off', actor, null, message);
}

export type AccountChange = { locked?: boolean; tester?: boolean; owner?: boolean };

/** One account's marks. Locking ends its sign-ins; the owner's account cannot be locked. */
export async function setAccount(db: Queryable, employeeId: number, change: AccountChange, actor: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    await db.query('INSERT INTO staff_accounts (employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING', [employeeId]);
    const now = (await db.query('SELECT locked, tester, owner FROM staff_accounts WHERE employee_id = $1 FOR UPDATE', [employeeId])).rows[0];
    const next = { locked: change.locked ?? now.locked, tester: change.tester ?? now.tester, owner: change.owner ?? now.owner };
    if (next.owner && next.locked) return { ok: false, error: 'Сопственичката сметка не се заклучува.' };
    if (next.owner && !now.owner) {
        const before = await db.query('UPDATE staff_accounts SET owner = false WHERE owner AND employee_id <> $1 RETURNING employee_id', [employeeId]);
        for (const row of before.rows) await logChange(db, 'owner_off', actor, row.employee_id);
    }
    await db.query(
        `UPDATE staff_accounts SET locked = $2, tester = $3, owner = $4,
                locked_at = CASE WHEN $2 AND NOT locked THEN now() WHEN $2 THEN locked_at ELSE NULL END
          WHERE employee_id = $1`, [employeeId, next.locked, next.tester, next.owner]);
    if (next.locked !== now.locked) {
        if (next.locked) await db.query('DELETE FROM staff_sessions WHERE employee_id = $1', [employeeId]);
        await logChange(db, next.locked ? 'lock' : 'unlock', actor, employeeId);
    }
    if (next.tester !== now.tester) await logChange(db, next.tester ? 'tester_on' : 'tester_off', actor, employeeId);
    if (next.owner !== now.owner) await logChange(db, next.owner ? 'owner_on' : 'owner_off', actor, employeeId);
    return { ok: true };
}

export async function unlockAll(db: Queryable, actor: string | null): Promise<number> {
    const { rows } = await db.query('UPDATE staff_accounts SET locked = false, locked_at = NULL WHERE locked RETURNING employee_id');
    if (rows.length) await logChange(db, 'unlock_all', actor, null, String(rows.length));
    return rows.length;
}

/**
 * A new shared link. The one before it goes to the archive and stops working
 * at once, and every sign-in ends except the owner's own — a remembered
 * session must not outlive the link it came in through.
 */
export async function newLink(db: Queryable, note: string | null, actor: string | null): Promise<string> {
    await db.query('UPDATE portal_links SET retired_at = now() WHERE retired_at IS NULL');
    let code = newCode();
    while ((await db.query('SELECT 1 FROM portal_links WHERE code = $1', [code])).rows.length) code = newCode();
    await db.query('INSERT INTO portal_links (code, note) VALUES ($1, $2)', [code, note]);
    await db.query('DELETE FROM staff_sessions WHERE employee_id NOT IN (SELECT employee_id FROM staff_accounts WHERE owner)');
    await logChange(db, 'link_new', actor, null, note);
    return code;
}

/** Back to the plain /kolegi address: the current link is archived and none replaces it. */
export async function retireLink(db: Queryable, actor: string | null): Promise<boolean> {
    const { rows } = await db.query('UPDATE portal_links SET retired_at = now() WHERE retired_at IS NULL RETURNING id');
    if (rows.length) await logChange(db, 'link_off', actor);
    return rows.length > 0;
}

/** Everything the security page shows. */
export async function securityOverview(db: Queryable) {
    const state = (await db.query('SELECT maintenance, message, changed_at FROM portal_security')).rows[0];
    const links = (await db.query(
        `SELECT code, note, created_at AS "createdAt", retired_at AS "retiredAt", refused, last_refused_at AS "lastRefusedAt"
           FROM portal_links ORDER BY created_at DESC, id DESC LIMIT 200`)).rows;
    const log = (await db.query(
        `SELECT l.at, l.action, l.detail, l.actor, e.name
           FROM portal_security_log l LEFT JOIN employees e ON e.id = l.employee_id
          ORDER BY l.at DESC, l.id DESC LIMIT 300`)).rows;
    const marks = (await db.query(
        `SELECT a.employee_id, a.locked, a.locked_at, a.tester, a.owner, a.last_login_at,
                (SELECT count(*)::int FROM staff_sessions s WHERE s.employee_id = a.employee_id AND s.expires_at > now()) AS sessions
           FROM staff_accounts a`)).rows;
    return {
        maintenance: {
            on: Boolean(state && state.maintenance) || maintenanceForced(),
            forced: maintenanceForced(),
            message: (state && state.message) || '',
            defaultMessage: MESSAGES.maintenance,
            changedAt: state ? state.changed_at : null
        },
        link: links.find((l: any) => !l.retiredAt) || null,
        archive: links.filter((l: any) => l.retiredAt),
        marks: new Map<number, any>(marks.map((m: any) => [m.employee_id, m])),
        log
    };
}
