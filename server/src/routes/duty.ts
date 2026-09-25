/**
 * Дежурства — the administrator's side (owner, 25 Sep 2026; migration 043).
 *
 *   GET /api/duty?year=&month=YYYY-MM   the month, the list and who can be on it
 *   PUT /api/duty/setup                 the list in its order, and the start date
 *   PUT /api/duty/day                   a closed day, or a day given by agreement
 *   PUT /api/duty/absence               anybody away on a day
 *
 * Deliberately NOT under /api/portal/, exactly like /api/staff-accounts: the
 * cloud's Google gate keeps these for the owner, and on a local server the
 * colleague boundary does. Colleagues see the rota and mark only their OWN
 * absence, through /api/portal/duty (routes/portal.ts).
 *
 * Nothing here stores who is on duty. That is worked out from these inputs
 * every time (lib/duty.ts), so changing one day cannot leave another stale.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import { defaultMonth, loadDuty, monthBounds, monthPayload } from '../lib/duty.js';

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
    assignedEmployeeId: z.number().int().positive().nullable().optional()
});
const AbsenceBody = z.object({
    year: YearRef,
    date: Iso,
    employeeId: z.number().int().positive(),
    absent: z.boolean()
});

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

/** Everyone who works this year, in any role: who can be put on the list. */
async function candidates(yearId: number) {
    const { rows } = await pool.query(
        `SELECT e.id AS "employeeId", e.name FROM employees e
          WHERE e.superseded_by IS NULL AND (
                EXISTS (SELECT 1 FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id
                         WHERE t.employee_id = e.id AND ty.school_year_id = $1 AND ty.active)
             OR EXISTS (SELECT 1 FROM therapists h JOIN therapist_years hy ON hy.therapist_id = h.id
                         WHERE h.employee_id = e.id AND hy.school_year_id = $1 AND hy.active)
             OR EXISTS (SELECT 1 FROM employee_roles r
                         WHERE r.employee_id = e.id AND r.school_year_id = $1 AND r.active))
          ORDER BY e.name`, [yearId]);
    return rows;
}

async function owner(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try { assertOwner(await scopeOf(req), 'дежурствата'); return true; }
    catch (err) { refuseScope(reply, err); return false; }
}

export async function dutyRoutes(server: FastifyInstance) {

    server.get('/api/duty', async (req, reply) => {
        if (!await owner(req, reply)) return;
        const q = req.query as any;
        const year = await schoolYearOf(pool, q?.year ? String(q.year) : undefined);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const state = await loadDuty(pool, year.id);
        const month = q?.month ? String(q.month) : defaultMonth(state);
        if (!monthBounds(month)) return reply.code(400).send({ error: 'Месецот се пишува како ГГГГ-ММ.' });
        return { year: year.label, ...monthPayload(state, month), candidates: await candidates(year.id) };
    });

    /** The list, replaced as a whole in its order, and the day the rotation starts. */
    server.put('/api/duty/setup', async (req, reply) => {
        if (!await owner(req, reply)) return;
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
    });

    /** Closed (no duty, nobody moves), or given to a named person by agreement, or neither. */
    server.put('/api/duty/day', async (req, reply) => {
        if (!await owner(req, reply)) return;
        const parsed = DayBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете го денот.' });
        const b = parsed.data;
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const problem = dayProblem(b.date, year);
        if (problem) return reply.code(400).send({ error: problem });
        const note = (b.note || '').replace(/\s+/g, ' ').trim();
        const assigned = b.closed ? null : (b.assignedEmployeeId ?? null);
        if (!b.closed && assigned == null && !note) {
            await pool.query('DELETE FROM duty_days WHERE school_year_id = $1 AND day = $2', [year.id, b.date]);
            return { ok: true, cleared: true };
        }
        await pool.query(
            `INSERT INTO duty_days (school_year_id, day, closed, note, assigned_employee_id) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (school_year_id, day) DO UPDATE
                SET closed = EXCLUDED.closed, note = EXCLUDED.note, assigned_employee_id = EXCLUDED.assigned_employee_id`,
            [year.id, b.date, b.closed, note, assigned]);
        return { ok: true };
    });

    /** Anybody away on a day — the administrator's version of a colleague's own mark. */
    server.put('/api/duty/absence', async (req, reply) => {
        if (!await owner(req, reply)) return;
        const parsed = AbsenceBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете го денот и колегата.' });
        const b = parsed.data;
        const year = await schoolYearOf(pool, b.year);
        if (!year) return reply.code(404).send({ error: 'Нема таква учебна година.' });
        const problem = dayProblem(b.date, year);
        if (problem) return reply.code(400).send({ error: problem });
        await setAbsence(pool, year.id, b.date, b.employeeId, b.absent, 'Администраторот');
        return { ok: true };
    });
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
