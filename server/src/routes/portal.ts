/**
 * The colleagues' door: sign in with your own name, see your own week
 * (docs/PLAN-kolegi-online.md; owner, 25 Sep 2026).
 *
 * EVERY ROUTE HERE CHECKS ITS OWN SESSION. In the cloud these are the only API
 * paths the Google gate lets through without the owner's sign-in
 * (`cloud-auth.ts`), so nothing may be answered here that a colleague should
 * not see. A colleague gets their own week, the names of their own pupils and
 * — for a clash — the other person's name and the term; never the roster and
 * never anybody else's week.
 *
 * The token travels in a header, not a cookie: a page on another site cannot
 * make the browser send it, so nothing here can be driven from elsewhere.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import {
    MIN_PASSWORD, PORTAL_TOKEN_HEADER, closeOtherSessions, closeSession, looseKey, nameKeys,
    openSession, passwordMatches, resetAccount, resolveUsername, sessionEmployee, setPassword,
    staffOfYear, usernamesOf, type Staff
} from '../lib/staff-accounts.js';

// Failed sign-ins, in memory: per username and per address. Five wrong
// passwords for one name in ten minutes stop that name for the rest of them;
// twenty from one address stop the address.
const WINDOW_MS = 10 * 60 * 1000;
const PER_NAME = 5;
const PER_ADDRESS = 20;
const failures = new Map<string, { n: number; until: number }>();

function blockedFor(key: string, limit: number): number {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.until <= Date.now()) { failures.delete(key); return 0; }
    return entry.n >= limit ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
}
function fail(key: string): void {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || entry.until <= now) failures.set(key, { n: 1, until: now + WINDOW_MS });
    else entry.n++;
}

const WRONG = 'Погрешно корисничко име или лозинка.';

/**
 * The year a colleague works in is the current one. A test names its own
 * invented year through the plugin's options instead, so it never has to put
 * invented people on the real year's lists.
 */
let yearLabel: string | undefined;
async function currentYear() {
    const { rows } = yearLabel
        ? await pool.query('SELECT id, label FROM school_years WHERE label = $1', [yearLabel])
        : await pool.query('SELECT id, label FROM school_years WHERE is_current LIMIT 1');
    return rows[0] as { id: number; label: string } | undefined;
}

/** Who is asking, from the portal token — or a 401 already sent. */
async function signed(req: FastifyRequest, reply: FastifyReply): Promise<{ staff: Staff; year: { id: number; label: string } } | null> {
    const employeeId = await sessionEmployee(pool, req.headers[PORTAL_TOKEN_HEADER]);
    const year = await currentYear();
    if (!employeeId || !year) {
        reply.code(401).send({ error: 'Најавата е истечена. Најавете се повторно.', signedOut: true });
        return null;
    }
    const staff = (await staffOfYear(pool, year.id)).find((s) => s.employeeId === employeeId);
    if (!staff) {
        reply.code(403).send({ error: 'Не сте на списокот за оваа учебна година. Јавете се кај администраторот.', notOnList: true });
        return null;
    }
    return { staff, year };
}

/** What the person does this year: the roles their form is made of. */
async function rolesOf(staff: Staff, yearId: number) {
    const roles: string[] = [];
    let teacher = null;
    if (staff.teacherId != null) {
        const { rows } = await pool.query(
            `SELECT t.kind, t.subject,
                    coalesce(json_agg(json_build_object('label', c.label, 'role', tc.role)
                             ORDER BY (tc.role = 'homeroom') DESC, c.sort_key, c.label)
                             FILTER (WHERE c.id IS NOT NULL), '[]') AS classes
               FROM teachers t
               LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.school_year_id = $2
               LEFT JOIN school_classes c ON c.id = tc.class_id
              WHERE t.id = $1 GROUP BY t.id`, [staff.teacherId, yearId]);
        const row = rows[0] || { kind: null, subject: null, classes: [] };
        teacher = { id: staff.teacherId, kind: row.kind, subject: row.subject, classes: row.classes };
        roles.push('teacher');
        if (row.classes.some((c: any) => c.role === 'homeroom')) roles.push('homeroom');
    }
    if (staff.therapistId != null) roles.push('therapist');
    return { roles, teacher, therapist: staff.therapistId != null ? { id: staff.therapistId } : null };
}

const LoginBody = z.object({ username: z.string().min(1).max(120), password: z.string().min(1).max(200) });
const PasswordBody = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) });

export async function portalRoutes(server: FastifyInstance, options: { year?: string } = {}) {
    yearLabel = options.year;

    /** The short link that is shared with colleagues. */
    server.get('/kolegi', async (_req, reply) => reply.redirect('/Kolega.html'));

    server.post('/api/portal/login', async (req, reply) => {
        const parsed = LoginBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Внесете корисничко име и лозинка.' });
        const { username, password } = parsed.data;
        const nameKey = 'name:' + looseKey(username);
        const addressKey = 'address:' + req.ip;
        const wait = Math.max(blockedFor(nameKey, PER_NAME), blockedFor(addressKey, PER_ADDRESS));
        if (wait) {
            return reply.header('Retry-After', String(wait)).code(429)
                .send({ error: 'Премногу погрешни обиди. Обидете се повторно за неколку минути.', retryAfterSeconds: wait });
        }
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const found = resolveUsername(await staffOfYear(pool, year.id), username);
        if (!found.ok) {
            fail(nameKey); fail(addressKey);
            if (found.reason === 'ambiguous') {
                return reply.code(409).send({ error: 'Повеќе колеги се викаат така. Јавете се кај администраторот.', ambiguous: true });
            }
            return reply.code(401).send({ error: WRONG });
        }
        const check = await passwordMatches(pool, found.staff.employeeId, password);
        if (!check.ok) {
            fail(nameKey); fail(addressKey);
            return reply.code(401).send({ error: WRONG });
        }
        failures.delete(nameKey);
        const session = await openSession(pool, found.staff.employeeId);
        return {
            token: session.token,
            expiresAt: session.expiresAt,
            person: { employeeId: found.staff.employeeId, name: found.staff.name },
            usernames: usernamesOf(found.staff.name),
            initialPassword: check.initial
        };
    });

    server.post('/api/portal/logout', async (req) => {
        await closeSession(pool, req.headers[PORTAL_TOKEN_HEADER]);
        return { ok: true };
    });

    /** Offered, never required: keeping the initial password is the person's call. */
    server.post('/api/portal/password', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const parsed = PasswordBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Внесете ја сегашната и новата лозинка.' });
        const next = parsed.data.next.trim();
        if (next.length < MIN_PASSWORD) {
            return reply.code(400).send({ error: `Новата лозинка мора да има барем ${MIN_PASSWORD} знаци.` });
        }
        const check = await passwordMatches(pool, who.staff.employeeId, parsed.data.current);
        if (!check.ok) return reply.code(403).send({ error: 'Сегашната лозинка не е точна.' });
        await setPassword(pool, who.staff.employeeId, next);
        await closeOtherSessions(pool, who.staff.employeeId, req.headers[PORTAL_TOKEN_HEADER]);
        return { ok: true };
    });

    server.get('/api/portal/me', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const own = await pool.query('SELECT password_hash IS NOT NULL AS own FROM staff_accounts WHERE employee_id = $1',
            [who.staff.employeeId]);
        return {
            person: { employeeId: who.staff.employeeId, name: who.staff.name },
            usernames: usernamesOf(who.staff.name),
            initialPassword: !(own.rows[0] && own.rows[0].own),
            year: who.year.label,
            ...(await rolesOf(who.staff, who.year.id))
        };
    });

    // ── the administrator's side, behind the owner's own sign-in ─────────
    // Deliberately NOT under /api/portal/: the cloud gate keeps these for the
    // owner, and on a local server the colleague boundary does.

    /** Every colleague who can sign in this year, and the state of the account. */
    server.get('/api/staff-accounts', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'сметките на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const staff = await staffOfYear(pool, year.id);
        const accounts = new Map((await pool.query(
            `SELECT employee_id, password_hash IS NOT NULL AS own, changed_at, reset_at, last_login_at FROM staff_accounts`
        )).rows.map((r: any) => [r.employee_id, r]));
        // A username that fits two people signs neither in; say which.
        const holders = new Map<string, number>();
        staff.forEach((s) => nameKeys(s.name).strict.forEach((k) => holders.set(k, (holders.get(k) || 0) + 1)));
        return {
            year: year.label,
            accounts: staff.map((s) => {
                const a: any = accounts.get(s.employeeId) || {};
                return {
                    employeeId: s.employeeId,
                    name: s.name,
                    usernames: usernamesOf(s.name),
                    teacher: s.teacherId != null,
                    therapist: s.therapistId != null,
                    ownPassword: Boolean(a.own),
                    changedAt: a.changed_at || null,
                    resetAt: a.reset_at || null,
                    lastLoginAt: a.last_login_at || null,
                    ambiguous: nameKeys(s.name).strict.some((k) => (holders.get(k) || 0) > 1)
                };
            })
        };
    });

    /** Back on the initial password, every sign-in ended. */
    server.post('/api/staff-accounts/:employeeId/reset', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'сметките на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const employeeId = Number((req.params as any).employeeId);
        if (!Number.isInteger(employeeId) || employeeId <= 0) return reply.code(400).send({ error: 'bad employee id' });
        const known = await pool.query('SELECT 1 FROM employees WHERE id = $1', [employeeId]);
        if (!known.rows.length) return reply.code(404).send({ error: 'no such employee' });
        await resetAccount(pool, employeeId);
        return { ok: true };
    });
}
