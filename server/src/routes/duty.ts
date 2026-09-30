/**
 * Дежурства — the administrator's side (owner, 25 Sep 2026; migration 043).
 *
 *   GET /api/duty?year=&month=YYYY-MM   the month, the list and who can be on it
 *   PUT /api/duty/setup                 the list in its order, and the start date
 *   PUT /api/duty/day                   a closed day, a note, or who actually served (051)
 *   PUT /api/duty/absence               anybody away on a day
 *   PUT /api/duty/swap                  two colleagues trade days (044); the list is untouched
 *   POST /api/duty/swap/remove          a swap taken back
 *
 * The original routes and /api/duty/delegations remain behind the owner's
 * gate. The owner may also issue a revocable duty-only link (28 Sep 2026):
 * /api/portal/duty-admin/* calls these same handlers, after checking BOTH
 * an ordinary active colleague session and the separate capability on every
 * request. Without a link, colleagues mark only their OWN absence through
 * /api/portal/duty (routes/portal.ts).
 *
 * Nothing here stores who is on duty. That is worked out from these inputs
 * every time (lib/duty.ts), so changing one day cannot leave another stale.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import { defaultMonth, isIsoDate, loadDuty, monthBounds, monthPayload, rotaWithSwaps, servedRota, todayInSkopje, windowPayload } from '../lib/duty.js';
import { PORTAL_TOKEN_HEADER, sessionEmployee, staffOfYear } from '../lib/staff-accounts.js';
import {
    DUTY_ADMIN_HOURS, DUTY_ADMIN_TOKEN_HEADER, acceptDutyAdminLink, createDutyAdminLink,
    dutyAdminLinks, revokeDutyAdminLinks, type DutyAdminLink, type DutyLinkDatabase
} from '../lib/duty-delegation.js';

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const YearRef = z.string().min(1).max(64).optional();

const SetupBody = z.object({
    year: YearRef,
    startsOn: Iso,
    members: z.array(z.object({
        employeeId: z.number().int().positive(),
        joinedOn: Iso.nullable().optional(),
        leftOn: Iso.nullable().optional()
    })).max(60)
});
const DayBody = z.object({
    year: YearRef,
    date: Iso,
    closed: z.boolean(),
    note: z.string().max(200).optional(),
    assignedEmployeeId: z.number().int().positive().nullable().optional(),
    // Who actually served (051). Absent = keep what is stored; null = the rota person.
    servedEmployeeId: z.number().int().positive().nullable().optional(),
    // Even it out: the replaced colleague serves the stand-in's next own turn.
    repay: z.boolean().optional()
});
const SwapSide = z.object({ date: Iso, employeeId: z.number().int().positive() });
const SwapBody = z.object({ year: YearRef, first: SwapSide, second: SwapSide, note: z.string().max(200).optional() });
const UnswapBody = z.object({ year: YearRef, id: z.coerce.number().int().positive() });

const AbsenceBody = z.object({
    year: YearRef,
    date: Iso,
    employeeId: z.number().int().positive(),
    absent: z.boolean()
});
const DelegationBody = z.object({ hours: z.union([
    z.literal(DUTY_ADMIN_HOURS[0]), z.literal(DUTY_ADMIN_HOURS[1]),
    z.literal(DUTY_ADMIN_HOURS[2]), z.literal(DUTY_ADMIN_HOURS[3])
]).nullable().optional() });

export async function schoolYearOf(db: any, label?: string) {
    const { rows } = await db.query(
        `SELECT id, label, starts_on, ends_on FROM school_years
          WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`, [label ?? null]);
    return rows[0] as { id: number; label: string; starts_on: string; ends_on: string } | undefined;
}

/** A working day inside the school year, or the reason it is not. */
export function dayProblem(date: string, year: { starts_on: string; ends_on: string }): string | null {
    if (date < String(year.starts_on) || date > String(year.ends_on)) return 'Датумот не е во оваа учебна година.';
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) return 'Во сабота и недела нема дежурства.';
    return null;
}

/**
 * Everyone who works this year, in any role: who can be put on the list.
 * `cabinet` marks the ones on this year's therapist list — the duty is the
 * cabinets', so the page starts a new list with exactly them checked and
 * everybody else one tick away (owner, 25 Sep 2026).
 */
async function candidates(yearId: number) {
    const { rows } = await pool.query(
        `SELECT id AS "employeeId", name, cabinet FROM (
           SELECT e.id, e.name,
                  EXISTS (SELECT 1 FROM therapists h JOIN therapist_years hy ON hy.therapist_id = h.id
                           WHERE h.employee_id = e.id AND hy.school_year_id = $1 AND hy.active) AS cabinet,
                  EXISTS (SELECT 1 FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id
                           WHERE t.employee_id = e.id AND ty.school_year_id = $1 AND ty.active)
               OR EXISTS (SELECT 1 FROM employee_roles r
                           WHERE r.employee_id = e.id AND r.school_year_id = $1 AND r.active) AS other
             FROM employees e WHERE e.superseded_by IS NULL) x
          WHERE cabinet OR other
          ORDER BY cabinet DESC, name`, [yearId]);
    return rows;
}

type DutyAdminAccess = { by: string; link: DutyAdminLink | null };
type DutyAdminAuthorizer = (req: FastifyRequest, reply: FastifyReply) => Promise<DutyAdminAccess | null>;

async function owner(req: FastifyRequest, reply: FastifyReply): Promise<DutyAdminAccess | null> {
    try {
        assertOwner(await scopeOf(req), 'дежурствата');
        return { by: 'Администраторот', link: null };
    } catch (err) {
        refuseScope(reply, err);
        return null;
    }
}

/** A normal colleague session plus the separate, revocable duty capability. */
async function delegated(req: FastifyRequest, reply: FastifyReply, yearLabel?: string, linksDb: DutyLinkDatabase = pool): Promise<DutyAdminAccess | null> {
    const employeeId = await sessionEmployee(pool, req.headers[PORTAL_TOKEN_HEADER]);
    if (!employeeId) {
        reply.code(401).send({ error: 'Најавете се со својата сметка за колеги.', signedOut: true });
        return null;
    }
    const year = await schoolYearOf(pool, yearLabel);
    const staff = year ? (await staffOfYear(pool, year.id)).find((person) => person.employeeId === employeeId) : null;
    if (!staff) {
        reply.code(403).send({ error: 'Не сте на списокот на вработени за тековната година.' });
        return null;
    }
    if (staff.readOnly) {
        reply.code(403).send({ error: 'Имате пристап само за преглед.', readOnly: true }); return null;
    }
    const link = await acceptDutyAdminLink(linksDb, req.headers[DUTY_ADMIN_TOKEN_HEADER]);
    if (!link) {
        reply.code(403).send({ error: 'Администраторскиот линк е истечен или поништен.', needsDutyAdminLink: true });
        return null;
    }
    return { by: staff.name, link };
}

export async function dutyRoutes(server: FastifyInstance, options: { year?: string; delegationDb?: DutyLinkDatabase } = {}) {
    const linksDb = options.delegationDb || pool;
    const delegatedHere: DutyAdminAuthorizer = (req, reply) => delegated(req, reply, options.year, linksDb);
    /** The owner creates/revokes links; the raw capability is returned once. */
    server.get('/api/duty/delegations', async (req, reply) => {
        if (!await owner(req, reply)) return;
        reply.header('Cache-Control', 'no-store');
        return { links: await dutyAdminLinks(linksDb) };
    });
    server.post('/api/duty/delegations', async (req, reply) => {
        if (!await owner(req, reply)) return;
        reply.header('Cache-Control', 'no-store');
        const parsed = DelegationBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Изберете колку време да важи линкот.' });
        const made = await createDutyAdminLink(linksDb, parsed.data.hours ?? null);
        return {
            url: `/kolegi#duty-admin=${made.token}`,
            link: { id: made.id, createdAt: made.createdAt, expiresAt: made.expiresAt }
        };
    });
    server.delete('/api/duty/delegations', async (req, reply) => {
        if (!await owner(req, reply)) return;
        return { ok: true, revoked: await revokeDutyAdminLinks(linksDb) };
    });

    const readDuty = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        const access = await authorize(req, reply);
        if (!access) return;
        const q = req.query as any;
        const year = await schoolYearOf(pool, q?.year ? String(q.year) : options.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const state = await loadDuty(pool, year.id);
        const adminMode = access.link
            ? { kind: 'link', expiresAt: access.link.expiresAt }
            : { kind: 'owner' };
        if (q?.around !== undefined) {
            if (!isIsoDate(q.around)) return reply.code(400).send({ error: 'Денот се пишува како ГГГГ-ММ-ДД.' });
            return { year: year.label, today: todayInSkopje(), ...windowPayload(state, q.around), candidates: await candidates(year.id), adminMode };
        }
        const month = q?.month ? String(q.month) : defaultMonth(state);
        if (!monthBounds(month)) return reply.code(400).send({ error: 'Месецот се пишува како ГГГГ-ММ.' });
        return { year: year.label, ...monthPayload(state, month), candidates: await candidates(year.id), adminMode };
    };
    server.get('/api/duty', readDuty(owner));
    server.get('/api/portal/duty-admin', readDuty(delegatedHere));

    /** The list, replaced as a whole in its order, and the day the rotation starts. */
    const setupDuty = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        if (!await authorize(req, reply)) return;
        const parsed = SetupBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете го списокот и датумот на почеток.' });
        const b = parsed.data;
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        if (b.startsOn < String(year.starts_on) || b.startsOn > String(year.ends_on)) {
            return reply.code(400).send({ error: 'Почетокот мора да е во оваа учебна година.' });
        }
        const ids = b.members.map((m) => m.employeeId);
        if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'Некој е двапати на списокот.' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (ids.length) {
                const found = await client.query(
                    'SELECT id FROM employees WHERE id = ANY($1::int[]) AND superseded_by IS NULL', [ids]);
                if (found.rowCount !== ids.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: 'Некој од списокот повеќе не постои во вработените.' });
                }
            }
            await client.query(
                `INSERT INTO duty_settings (school_year_id, starts_on) VALUES ($1, $2)
                 ON CONFLICT (school_year_id) DO UPDATE SET starts_on = EXCLUDED.starts_on`, [year.id, b.startsOn]);
            await client.query('DELETE FROM duty_members WHERE school_year_id = $1', [year.id]);
            for (const [i, m] of b.members.entries()) {
                if (m.joinedOn && m.leftOn && m.leftOn <= m.joinedOn) {
                    await client.query('ROLLBACK');
                    return reply.code(400).send({ error: 'Некој заминува пред да дојде.' });
                }
                await client.query(
                    `INSERT INTO duty_members (school_year_id, employee_id, position, joined_on, left_on)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [year.id, m.employeeId, i + 1, m.joinedOn || null, m.leftOn || null]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        return { ok: true, year: year.label, members: ids.length };
    };
    server.put('/api/duty/setup', setupDuty(owner));
    server.put('/api/portal/duty-admin/setup', setupDuty(delegatedHere));

    /** Closed (no duty, nobody moves), or given to a named person by agreement, or neither. */
    const putDay = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        if (!await authorize(req, reply)) return;
        const parsed = DayBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете го денот.' });
        const b = parsed.data;
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const problem = dayProblem(b.date, year);
        if (problem) return reply.code(400).send({ error: problem });
        const note = (b.note || '').replace(/\s+/g, ' ').trim();
        const assigned = b.closed ? null : (b.assignedEmployeeId ?? null);
        // Keep old records editable, but do not create another one-sided
        // agreement. A new exchange must name BOTH dates through /swap.
        if (assigned != null) {
            const prior = await pool.query('SELECT assigned_employee_id FROM duty_days WHERE school_year_id=$1 AND day=$2', [year.id, b.date]);
            if (Number(prior.rows[0]?.assigned_employee_id) !== assigned) {
                return reply.code(400).send({ error: 'За договорена смена користете „Замени со ден“ — се разменуваат два термина, без дополнително дежурство.' });
            }
        }
        // Who actually served: a correction of the name on this day, any day
        // including past ones; the queue does not move (lib/duty.ts applyServed).
        const state = await loadDuty(pool, year.id);
        let served = b.servedEmployeeId === undefined ? (state.days.get(b.date)?.served ?? null) : b.servedEmployeeId;
        if (b.closed) served = null;
        let insteadOf: number | null = null;
        if (served != null) {
            const member = state.members.find((m) => m.employeeId === served);
            if (!member || (member.joinedOn && member.joinedOn > b.date) || (member.leftOn && member.leftOn <= b.date)) {
                return reply.code(400).send({ error: 'Тој колега не е на списокот за дежурства на тој ден.' });
            }
            // Measured against the rota WITHOUT this day's correction.
            const plain = new Map(state.days);
            plain.set(b.date, { closed: false, note, assigned, served: null });
            const day = servedRota({ ...state, days: plain }, b.date).days.find((d) => d.date === b.date);
            insteadOf = day ? day.employeeId : null;
            if (insteadOf === served) served = null; // the rota already names them
        }
        if (!b.closed && assigned == null && served == null && !note) {
            await pool.query('DELETE FROM duty_days WHERE school_year_id = $1 AND day = $2', [year.id, b.date]);
        } else {
            await pool.query(
                `INSERT INTO duty_days (school_year_id, day, closed, note, assigned_employee_id, served_employee_id) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (school_year_id, day) DO UPDATE
                    SET closed = EXCLUDED.closed, note = EXCLUDED.note, assigned_employee_id = EXCLUDED.assigned_employee_id,
                        served_employee_id = EXCLUDED.served_employee_id`,
                [year.id, b.date, b.closed, note, assigned, served]);
        }
        if (!b.repay || served == null || insteadOf == null) return { ok: true, cleared: !b.closed && assigned == null && served == null && !note };
        // Even it out: the stand-in's next OWN turn, in a later cycle, goes to
        // the colleague who was replaced. Found on the rota as it now stands.
        const after = await loadDuty(pool, year.id);
        const rota = servedRota(after, after.yearEndsOn).days;
        const here = rota.find((d) => d.date === b.date);
        const next = rota.find((d) => d.date > b.date && here && d.cycle > here.cycle && !d.closed
            && d.employeeId === served && d.insteadOf === undefined && !d.absent.includes(insteadOf!));
        if (!next) return { ok: true, repaid: null, error: 'Нема следен термин за враќање во оваа учебна година.' };
        const mark = after.days.get(next.date);
        await pool.query(
            `INSERT INTO duty_days (school_year_id, day, closed, note, assigned_employee_id, served_employee_id) VALUES ($1, $2, false, $3, $4, $5)
             ON CONFLICT (school_year_id, day) DO UPDATE SET served_employee_id = EXCLUDED.served_employee_id`,
            [year.id, next.date, mark?.note || '', mark?.assigned ?? null, insteadOf]);
        return { ok: true, repaid: next.date };
    };
    server.put('/api/duty/day', putDay(owner));
    server.put('/api/portal/duty-admin/day', putDay(delegatedHere));

    /** Anybody away on a day — the administrator's version of a colleague's own mark. */
    const putAbsence = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        const access = await authorize(req, reply);
        if (!access) return;
        const parsed = AbsenceBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете го денот и колегата.' });
        const b = parsed.data;
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const problem = dayProblem(b.date, year);
        if (problem) return reply.code(400).send({ error: problem });
        await setAbsence(pool, year.id, b.date, b.employeeId, b.absent, access.by);
        return { ok: true };
    };
    server.put('/api/duty/absence', putAbsence(owner));
    server.put('/api/portal/duty-admin/absence', putAbsence(delegatedHere));

    await swapRoutes(server, delegatedHere);
}

/**
 * Two colleagues trade days. Each side says whose day it is AS THE PAGE SHOWED
 * IT, and the rota is worked out again under a lock to check that it still is:
 * a deal is made between two people, so if the rota moved in between, the
 * swap is refused rather than made between somebody else.
 */
export async function swapRoutes(server: FastifyInstance,
    delegatedAuthorize: DutyAdminAuthorizer = (req, reply) => delegated(req, reply)) {
    const putSwap = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        if (!await authorize(req, reply)) return;
        const parsed = SwapBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете ги двата дена на замената.' });
        const b = parsed.data;
        const [first, second] = b.first.date < b.second.date ? [b.first, b.second] : [b.second, b.first];
        if (first.date === second.date) return reply.code(400).send({ error: 'Замената е меѓу два различни дена.' });
        if (first.employeeId === second.employeeId) return reply.code(400).send({ error: 'Тоа е истиот колега — нема што да се замени.' });
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        for (const side of [first, second]) {
            const problem = dayProblem(side.date, year);
            if (problem) return reply.code(400).send({ error: problem });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('LOCK TABLE duty_swaps IN SHARE ROW EXCLUSIVE MODE');
            const taken = await client.query(
                `SELECT 1 FROM duty_swaps WHERE school_year_id = $1
                    AND (first_day = ANY($2::date[]) OR second_day = ANY($2::date[]))`, [year.id, [first.date, second.date]]);
            if (taken.rowCount) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Еден од тие денови веќе е заменет. Прво откажете ја таа замена.' });
            }
            // Read through the pool: loadDuty asks in parallel, which one client
            // must not do. The lock above is what keeps the swaps still meanwhile.
            const state = await loadDuty(pool, year.id);
            const days = rotaWithSwaps(state, second.date).days;
            const on = (date: string) => days.find((d) => d.date === date);
            const x = on(first.date);
            const y = on(second.date);
            if (!x || !y || x.closed || y.closed) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Тој ден нема дежурство.' });
            }
            if (x.employeeId !== first.employeeId || y.employeeId !== second.employeeId) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Распоредот се смени во меѓувреме. Освежете и обидете се пак.' });
            }
            if (state.days.get(first.date)?.served != null || state.days.get(second.date)?.served != null) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'На еден од деновите е запишано кој навистина дежурал. Прво тргнете ја таа исправка.' });
            }
            if (x.cycle !== y.cycle) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Изберете два термина од истиот циклус. Замена меѓу различни циклуси би повторила колега во еден циклус.' });
            }
            if (x.absent.includes(second.employeeId) || y.absent.includes(first.employeeId)) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Едниот од двајцата е отсутен токму на денот што би го зел.' });
            }
            const { rows } = await client.query(
                `INSERT INTO duty_swaps (school_year_id, first_day, first_employee_id, second_day, second_employee_id, note)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [year.id, first.date, first.employeeId, second.date, second.employeeId, (b.note || '').replace(/\s+/g, ' ').trim()]);
            await client.query('COMMIT');
            return { ok: true, id: Number(rows[0].id) };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    };
    server.put('/api/duty/swap', putSwap(owner));
    server.put('/api/portal/duty-admin/swap', putSwap(delegatedAuthorize));

    const removeSwap = (authorize: DutyAdminAuthorizer) => async (req: FastifyRequest, reply: FastifyReply) => {
        if (!await authorize(req, reply)) return;
        const parsed = UnswapBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Која замена?' });
        const year = await schoolYearOf(pool, parsed.data.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const gone = await pool.query('DELETE FROM duty_swaps WHERE school_year_id = $1 AND id = $2', [year.id, parsed.data.id]);
        if (!gone.rowCount) return reply.code(404).send({ error: 'Таа замена веќе ја нема.' });
        return { ok: true };
    };
    server.post('/api/duty/swap/remove', removeSwap(owner));
    server.post('/api/portal/duty-admin/swap/remove', removeSwap(delegatedAuthorize));
}

/** One person away (or back) on one day. Shared with the colleague's own route. */
export async function setAbsence(db: any, yearId: number, date: string, employeeId: number, absent: boolean, by: string) {
    if (absent) {
        await db.query(
            `INSERT INTO duty_absences (school_year_id, day, employee_id, marked_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (school_year_id, day, employee_id) DO UPDATE SET marked_by = EXCLUDED.marked_by`,
            [yearId, date, employeeId, by]);
    } else {
        await db.query('DELETE FROM duty_absences WHERE school_year_id = $1 AND day = $2 AND employee_id = $3',
            [yearId, date, employeeId]);
    }
}
