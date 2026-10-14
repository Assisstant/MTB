import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { norm, DAY_ORDER } from '../lib/import-core.js';
import { minutesOf, slotBell, timeOf } from '../lib/crossing.js';
import { scheduleGate, lockScheduleTherapist, lockScheduleStudents, scheduleOverlaps, overlapRefusal } from '../lib/schedule-conflicts.js';
import { assertOwnTherapistId, assertOwnTherapistName, refuseScope, scopeOf } from '../lib/colleague.js';

/**
 * Stage A of moving Rasporedi onto the database: ONE schedule cell at a time.
 *
 * Today both apps save by replacing the whole document, which is why two
 * therapists cannot use Rasporedi at once — each save overwrites the other's
 * week wholesale, silently, even when they edited different cells. There is
 * nothing to merge because the unit of change is "everything".
 *
 * A cell is (day, time, therapist). `expected` turns stale same-cell edits
 * into a reported 409 instead of a silent overwrite. Different cells can
 * still overlap for the same pupil or cabinet: all three routes share the
 * interval check and pupil/day and cabinet/day transaction locks.
 *
 * Deliberately additive: nothing calls this until Rasporedi is switched over,
 * so it cannot disturb a year that is already running.
 */

const SlotBody = z.object({
    day: z.string().min(1).max(40),
    time: z.string().min(1).max(40),
    therapist: z.string().min(1).max(120),
    /** null or '' clears the cell. */
    student: z.string().max(200).nullable().optional(),
    /** Row-level optimistic concurrency: who the caller believes is there now. */
    expected: z.string().max(200).nullable().optional(),
    year: z.string().max(20).optional()
});

const SessionQuery = z.object({
    year: z.string().min(1).max(64).optional()
});

const SessionBody = z.object({
    year: z.string().min(1).max(64).optional(),
    day: z.string().min(1).max(40),
    time: z.string().min(1).max(80),
    therapistId: z.number().int().positive(),
    /** null clears the session. */
    studentPublicId: z.string().min(1).max(80).nullable(),
    /** Stable-id concurrency guard used by RasporediFusion. */
    expectedStudentPublicId: z.string().min(1).max(80).nullable().optional()
});

/** The most pupils one term can take together (owner, 14 Oct 2026). */
export const GROUP_MAX = 8;
const GROUP_REFUSED = 'Групни термини уште не се вклучени на овој сервер (миграција 063).';
const IS_GROUP = 'Тој термин е група. Уредете го како цел термин, со сите ученици.';

export const BlockBody = z.object({
    year: z.string().min(1).max(64).optional(),
    day: z.string().min(1).max(40),
    /** The containing cabinet bell, always one 40-minute range. */
    time: z.string().min(1).max(80),
    therapistId: z.number().int().positive(),
    /**
     * 0 clears; 1 owns all 40 minutes; 2 are ordered 20-minute halves or,
     * with `mode: "together"`, a group; 3 to 8 are always a group, every pupil
     * the whole bell together (owner, 14 Oct 2026; migration 063).
     */
    studentPublicIds: z.array(z.string().min(1).max(80)).max(GROUP_MAX),
    /** Semantic block state, irrespective of whether one legacy pupil used two equal half-rows. */
    expectedStudentPublicIds: z.array(z.string().min(1).max(80)).max(GROUP_MAX).optional(),
    /**
     * „together" or „halves", which only two pupils can choose between. Left
     * out, a block keeping the same pupils keeps its way — a caller that knows
     * nothing of groups never splits one — and two new pupils are halves.
     */
    mode: z.enum(['together', 'halves']).optional()
});

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function blockTimes(label: string): { full: string; halves: [string, string] } | null {
    const span = slotBell(label);
    if (!span || span.minutes !== 40) return null;
    const start = minutesOf(span.startsAt);
    if (!Number.isFinite(start)) return null;
    return {
        full: label,
        halves: [
            `${timeOf(start)}-${timeOf(start + 20)}`,
            `${timeOf(start + 20)}-${timeOf(start + 40)}`
        ]
    };
}

/**
 * The pupils of a block. Every row with the whole bell is a pupil there for
 * all of it — one, or a group (063), in the rows' order; the halves are two
 * pupils 20 minutes each. Callers read the rows ordered by time, then id.
 */
export function semanticBlock(rows: any[], times: { full: string; halves: [string, string] }): string[] | null {
    const full = rows.filter((row) => row.time_slot === times.full).map((row) => row.student_public_id).filter(Boolean);
    const halves = times.halves.map((time) =>
        rows.find((row) => row.time_slot === time)?.student_public_id).filter(Boolean);
    if (full.length && halves.length) return null; // contradictory overlap; never silently choose one
    if (full.length) return full.map(String);
    if (halves.length === 2 && halves[0] === halves[1]) return [String(halves[0])];
    return halves.map(String);
}
/** A group: two or more pupils, each with the whole bell. */
export const blockTogether = (rows: any[], times: { full: string }) =>
    rows.filter((row) => row.time_slot === times.full && row.student_public_id).length > 1;

let groupsReady = false;
/**
 * Can this database hold a group (063)? Asked of the table the write resolves
 * to (trap 41) and remembered once it can. Without it a group is refused in
 * words, never by a unique violation halfway through a block.
 */
export async function hasGroups(db: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> }): Promise<boolean> {
    if (!groupsReady) groupsReady = (await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'schedule_slots_year_day_time_therapist_student_key'
            AND conrelid = to_regclass('schedule_slots')`)).rows.length > 0;
    return groupsReady;
}

/**
 * The block as it is stored: the pupils `semanticBlock` names, each with the
 * exact minutes they hold. A legacy row can be one lone half (08:20-08:40);
 * the pupil list alone reads that as "one pupil", which a later write would
 * widen to all 40 minutes. Whoever must put a block back needs the minutes.
 */
export function blockState(rows: any[], times: { full: string; halves: [string, string] }): { ids: string[]; times: string[] } | null {
    const ids = semanticBlock(rows, times);
    if (ids == null) return null;
    return { ids, times: ids.map((id) => {
        const own = rows.filter((row) => String(row.student_public_id) === id).map((row) => String(row.time_slot));
        return own.length === 1 ? own[0] : times.full;
    }) };
}

async function yearId(label?: string): Promise<number | null> {
    const { rows } = await pool.query(
        `SELECT id FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    return rows.length ? rows[0].id : null;
}

export type BlockWrite = {
    status: number;
    body: any;
    /** Sessions of other therapists a forced block now overlaps. */
    forcedOver?: Array<{ therapistId: number; therapistName: string; time: string; studentPublicId: string; studentName: string }>;
};

/**
 * The block writer, ONE copy: Кабинети's cell (the route below) and a
 * therapist's own form (routes/portal.ts) both write through it. `force` is
 * the colleague's „сепак запиши" (docs/PLAN-kolegi-online.md): a pupil
 * already with another therapist then is booked anyway, and the sessions it
 * overlaps come back so that therapist can be told. Кабинети never forces.
 */
export async function writeBlock(body: z.infer<typeof BlockBody>, options: BlockOptions = {}): Promise<BlockWrite> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await writeBlockInTransaction(client, body, options);
        await client.query(result.status === 200 ? 'COMMIT' : 'ROLLBACK');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally { client.release(); }
}

/**
 * `exactTimes` and `expectedTimes` are for the administrator's undo
 * (routes/portal-changes.ts): put a block back with the minutes it had,
 * starting from the minutes it has now. Every other caller leaves them out
 * and gets the usual shape — one pupil the whole bell, two the halves.
 */
export type BlockOptions = { force?: boolean; exactTimes?: string[]; expectedTimes?: string[] };

/** Caller owns the transaction; used by one block and by a confirmed whole week. */
export async function writeBlockInTransaction(client: import("pg").PoolClient, body: z.infer<typeof BlockBody>, options: BlockOptions = {}): Promise<BlockWrite> {
    // The route's answers, as a status and a body the caller sends on.
    const reply = { code: (status: number) => ({ send: (payload: any): BlockWrite => ({ status, body: payload }) }) };
    const forcedOver: NonNullable<BlockWrite['forcedOver']> = [];
    const times = blockTimes(body.time);
    if (!times) return reply.code(400).send({ error: 'a block must name one 40-minute time range' });
    if (new Set(body.studentPublicIds).size !== body.studentPublicIds.length) {
        return reply.code(400).send({ error: 'leave the second pupil empty when one pupil owns all 40 minutes' });
    }
    // The route's schema says the same; a caller inside the server (the diary's week) is held to it here.
    if (body.studentPublicIds.length > GROUP_MAX) {
        return reply.code(400).send({ error: `a term takes at most ${GROUP_MAX} pupils` });
    }
    if (body.mode === 'halves' && body.studentPublicIds.length !== 2) {
        return reply.code(400).send({ error: 'halves are for two pupils; three or more are a group' });
    }
    const dayOrder = DAY_ORDER[norm(body.day)];
    if (!dayOrder) return reply.code(400).send({ error: `unknown working day "${body.day}"` });

    await scheduleGate(client);
    const year = (await client.query(
        `SELECT id, label, is_current FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1 FOR SHARE`,
        [body.year ?? null]
    )).rows[0];
    if (!year) {
        return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
    }

    const therapist = (await client.query(
        `SELECT t.id, t.name FROM therapists t
         JOIN therapist_years ty ON ty.therapist_id = t.id
         WHERE t.id = $1 AND ty.school_year_id = $2 AND ty.active`,
        [body.therapistId, year.id]
    )).rows[0];
    if (!therapist) {
        return reply.code(404).send({ error: 'that therapist is not active in this school year' });
    }

    await lockScheduleTherapist(client, year.id, body.day, body.therapistId);

    const exactTimes = [times.full, ...times.halves];
    const currentRows = (await client.query(
        `SELECT sl.time_slot, s.public_id AS student_public_id, s.name AS student_name
         FROM schedule_slots sl LEFT JOIN students s ON s.id = sl.student_id
         WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.therapist_id = $3
           AND sl.time_slot = ANY($4::text[])
         ORDER BY sl.time_slot, sl.id FOR UPDATE OF sl`,
        [year.id, body.day, body.therapistId, exactTimes]
    )).rows;
    const present = semanticBlock(currentRows, times);
    const presentTogether = blockTogether(currentRows, times);
    if (present == null) {
        return reply.code(409).send({
            error: 'that block contains overlapping full and half rows; clear them explicitly first',
            blockOverlap: true
        });
    }
    const presentTimes = blockState(currentRows, times)!.times;
    // A group has no order a person chose, so it is compared as a set.
    const matches = (a: string[], b: string[]) => presentTogether ? sameIds([...a].sort(), [...b].sort()) : sameIds(a, b);
    if ((body.expectedStudentPublicIds !== undefined && !matches(present ?? [], body.expectedStudentPublicIds))
        || (options.expectedTimes !== undefined && !sameIds(presentTimes, options.expectedTimes))) {
        return reply.code(409).send({
            error: 'that block changed while you were editing',
            expectedStudentPublicIds: body.expectedStudentPublicIds,
            actualStudentPublicIds: present
        });
    }

    const ownOverlaps = await scheduleOverlaps(client, year.id, body.day, body.therapistId, times.full, null, exactTimes);
    const ownRefusal = overlapRefusal(ownOverlaps, body.therapistId);
    if (ownRefusal) return reply.code(409).send(ownRefusal);

    const students: any[] = [];
    for (const publicId of body.studentPublicIds) {
        const student = (await client.query(
            `SELECT s.id, s.public_id, s.name
             FROM students s JOIN student_enrollments e ON e.student_id = s.id
             WHERE s.public_id = $1
               AND e.school_year_id = $2 AND e.active
               AND (s.active OR NOT $3::boolean)`,
            [publicId, year.id, year.is_current]
        )).rows[0];
        if (!student) {
            return reply.code(404).send({ error: 'that student is not active in this school year' });
        }
        const linked = await client.query(
            `SELECT 1 FROM therapist_students
             WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
            [year.id, body.therapistId, student.id]
        );
        if (!linked.rows.length) {
            return reply.code(409).send({
                error: 'that student is not in this therapist caseload', notInCaseload: true
            });
        }
        students.push(student);
    }

    await lockScheduleStudents(client, year.id, body.day, body.studentPublicIds);
    // Together: a group, every pupil the whole bell. Three or more always are;
    // two are when asked, or when the same two already were (a caller that
    // knows nothing of groups must not split one); the undo says by its times.
    const n = students.length, ids = students.map((st) => String(st.public_id));
    const samePupils = n === present.length && ids.every((id) => present.includes(id));
    const together = options.exactTimes ? options.exactTimes.length > 1 && options.exactTimes.every((t) => t === times.full)
        : n > 2 || (n === 2 && (body.mode ? body.mode === 'together' : samePupils && presentTogether));
    if (together && !await hasGroups(client)) return reply.code(409).send({ error: GROUP_REFUSED, groupsMissing: true });
    let desiredTimes = n === 1 ? [times.full] : together ? ids.map(() => times.full) : times.halves.slice(0, n);
    if (options.exactTimes) {
        // One pupil may hold the whole bell or one half of it; two hold the halves, in order; a group, the whole bell each.
        const wanted = options.exactTimes;
        const fits = n === 1 ? wanted.length === 1 && exactTimes.includes(wanted[0])
            : together ? wanted.length === n
            : sameIds(wanted, times.halves.slice(0, n));
        if (!fits) return reply.code(400).send({ error: 'those times are not this block' });
        desiredTimes = wanted;
    }
    for (let index = 0; index < students.length; index++) {
        const overlaps = await scheduleOverlaps(client, year.id, body.day, body.therapistId,
            desiredTimes[index], students[index].public_id, exactTimes);
        const refusal = overlapRefusal(overlaps, body.therapistId);
        if (refusal) {
            if (!options.force || !refusal.doubleBooked) return reply.code(409).send(refusal);
            for (const row of overlaps.rows) forcedOver.push({ therapistId: row.therapist_id,
                therapistName: row.therapist_name, time: row.time_slot,
                studentPublicId: students[index].public_id, studentName: students[index].name });
        }
    }

    await client.query(
        `DELETE FROM schedule_slots
         WHERE school_year_id = $1 AND day = $2 AND therapist_id = $3
           AND time_slot = ANY($4::text[])`,
        [year.id, body.day, body.therapistId, exactTimes]
    );
    for (let index = 0; index < students.length; index++) {
        await client.query(
            `INSERT INTO schedule_slots
                (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
             VALUES ($1, $2, $3, $4, $5, $6, 'api')`,
            [year.id, body.day, dayOrder, desiredTimes[index], body.therapistId, students[index].id]
        );
    }
    return { status: 200, forcedOver, body: {
        ok: true, year: year.label, day: body.day, time: times.full,
        therapistId: therapist.id, therapistName: therapist.name,
        studentPublicIds: students.map((student) => student.public_id),
        previousStudentPublicIds: present,
        previousTimes: presentTimes, times: desiredTimes, together, previousTogether: presentTogether,
        sessions: students.map((student, index) => ({
            day: body.day, time: desiredTimes[index], therapist_id: therapist.id,
            therapist_name: therapist.name, student_public_id: student.public_id,
            student_name: student.name
        }))
    } };
}

export async function scheduleWriteRoutes(server: FastifyInstance) {

    /**
     * The DB-first schedule used by RasporediFusion. New cells are two
     * 20-minute halves inside one 40-minute cabinet bell; 40-minute rows stay
     * accepted so an existing schedule remains editable while it transitions.
     *
     * This deliberately speaks in stable ids.  The legacy endpoint below
     * accepts names because the old single-file app keys its arrays by name;
     * two students may share one, so a new application must not inherit that
     * limitation.
     */
    server.get('/api/schedule/sessions', async (req, reply) => {
        const q = SessionQuery.parse(req.query);
        const { rows: years } = await pool.query(
            `SELECT id, label, is_current FROM school_years
             WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
            [q.year ?? null]
        );
        if (!years.length) return reply.code(404).send({ error: `no such school year: ${q.year ?? '(current)'}` });

        const { rows } = await pool.query(
            `SELECT sl.day, sl.day_order, sl.time_slot AS time,
                    t.id AS therapist_id, t.name AS therapist_name,
                    s.public_id AS student_public_id, s.name AS student_name
             FROM schedule_slots sl
             JOIN therapists t ON t.id = sl.therapist_id
             JOIN therapist_years ty
                  ON ty.therapist_id = t.id AND ty.school_year_id = sl.school_year_id AND ty.active
             LEFT JOIN students s ON s.id = sl.student_id
             LEFT JOIN student_enrollments e
                  ON e.student_id = s.id AND e.school_year_id = sl.school_year_id AND e.active
             WHERE sl.school_year_id = $1
               AND (sl.student_id IS NULL OR
                    (e.student_id IS NOT NULL AND (NOT $2::boolean OR s.active)))
             ORDER BY sl.day_order, sl.time_slot, t.name`,
            [years[0].id, years[0].is_current]
        );
        return { year: years[0].label, sessions: rows };
    });

    /**
     * One visible 40-minute block, with the same meaning as S-Dnevnik:
     * one pupil owns the full block; two pupils split it into ordered halves.
     * The representation change is one transaction, so there is never a
     * moment where clearing the full row loses it before the halves land.
     */
    server.put('/api/schedule/block', async (req, reply) => {
        const parsed = BlockBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: `a block is a day, one 40-minute time, a therapist and up to ${GROUP_MAX} pupils` });
        const body = parsed.data;
        try { assertOwnTherapistId(await scopeOf(req), body.therapistId); }
        catch (err) { return refuseScope(reply, err); }
        const result = await writeBlock(body);
        return reply.code(result.status).send(result.body);
    });

    server.put('/api/schedule/session', async (req, reply) => {
        const body = SessionBody.parse(req.body);
        try { assertOwnTherapistId(await scopeOf(req), body.therapistId); }
        catch (err) { return refuseScope(reply, err); }
        const span = slotBell(body.time);
        if (!span || ![20, 40].includes(span.minutes)) {
            return reply.code(400).send({ error: 'a Fusion session must name one 20- or 40-minute time range' });
        }
        const dayOrder = DAY_ORDER[norm(body.day)];
        if (!dayOrder) return reply.code(400).send({ error: `unknown working day "${body.day}"` });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await scheduleGate(client);
            const year = (await client.query(
                `SELECT id, label, is_current FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1 FOR SHARE`,
                [body.year ?? null]
            )).rows[0];
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }

            const therapist = (await client.query(
                `SELECT t.id, t.name FROM therapists t
                 JOIN therapist_years ty ON ty.therapist_id = t.id
                 WHERE t.id = $1 AND ty.school_year_id = $2 AND ty.active`,
                [body.therapistId, year.id]
            )).rows[0];
            if (!therapist) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'that therapist is not active in this school year' });
            }

            await lockScheduleTherapist(client, year.id, body.day, body.therapistId);

            const cell = (await client.query(
                `SELECT sl.id, s.public_id AS student_public_id, s.name AS student_name
                 FROM schedule_slots sl
                 LEFT JOIN students s ON s.id = sl.student_id
                 WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.time_slot = $3
                   AND sl.therapist_id = $4
                 FOR UPDATE OF sl`,
                [year.id, body.day, body.time, body.therapistId]
            )).rows;
            // One pupil per cell is all this route knows; a group (063) is a block's, whole.
            if (cell.length > 1) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: IS_GROUP, group: true });
            }
            const current = cell[0];
            const present = current?.student_public_id ?? null;
            if (body.expectedStudentPublicId !== undefined && present !== body.expectedStudentPublicId) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that session changed while you were editing',
                    expectedStudentPublicId: body.expectedStudentPublicId,
                    actualStudentPublicId: present,
                    actualStudentName: current?.student_name ?? null
                });
            }

            if (body.studentPublicId === null) {
                await client.query(
                    `DELETE FROM schedule_slots
                     WHERE school_year_id = $1 AND day = $2 AND time_slot = $3 AND therapist_id = $4`,
                    [year.id, body.day, body.time, body.therapistId]
                );
                await client.query('COMMIT');
                return {
                    ok: true, year: year.label, day: body.day, time: body.time,
                    therapistId: body.therapistId, studentPublicId: null,
                    previousStudentPublicId: present
                };
            }

            await lockScheduleStudents(client, year.id, body.day, [body.studentPublicId]);

            const student = (await client.query(
                `SELECT s.id, s.public_id, s.name
                 FROM students s
                 JOIN student_enrollments e ON e.student_id = s.id
                 WHERE s.public_id = $1
                   AND e.school_year_id = $2 AND e.active
                   AND (s.active OR NOT $3::boolean)`,
                [body.studentPublicId, year.id, year.is_current]
            )).rows[0];
            if (!student) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'that student is not active in this school year' });
            }

            const linked = await client.query(
                `SELECT 1 FROM therapist_students
                 WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
                [year.id, body.therapistId, student.id]
            );
            if (!linked.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that student is not in this therapist caseload',
                    notInCaseload: true
                });
            }

            const overlaps = await scheduleOverlaps(client, year.id, body.day, body.therapistId,
                body.time, body.studentPublicId, [body.time]);
            const refusal = overlapRefusal(overlaps, body.therapistId);
            if (refusal) {
                await client.query('ROLLBACK');
                return reply.code(409).send(refusal);
            }

            // The cell is replaced, as the old upsert did; the key now names the pupil (063).
            await client.query(
                `DELETE FROM schedule_slots WHERE school_year_id = $1 AND day = $2 AND time_slot = $3 AND therapist_id = $4`,
                [year.id, body.day, body.time, body.therapistId]);
            await client.query(
                `INSERT INTO schedule_slots
                    (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, $3, $4, $5, $6, 'api')`,
                [year.id, body.day, dayOrder, body.time, body.therapistId, student.id]
            );
            await client.query('COMMIT');
            return {
                ok: true, year: year.label, day: body.day, time: body.time,
                therapistId: therapist.id, therapistName: therapist.name,
                studentPublicId: student.public_id, studentName: student.name,
                previousStudentPublicId: present
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    server.put('/api/schedule/slot', async (req, reply) => {
        const body = SlotBody.parse(req.body);
        try { await assertOwnTherapistName(await scopeOf(req), body.therapist); }
        catch (err) { return refuseScope(reply, err); }
        const wanted = (body.student ?? '').trim();

        const yid = await yearId(body.year);
        if (yid == null) return reply.code(409).send({ error: 'no current school year is set' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await scheduleGate(client);
            const th = await client.query(
                `SELECT t.id, coalesce(ty.active, false) AS active_this_year
                 FROM therapists t
                 LEFT JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = $2
                 WHERE lower(btrim(t.name)) = $1`, [norm(body.therapist), yid]
            );
            if (!th.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `unknown therapist "${body.therapist}"` });
            }
            if (th.rows.length > 1) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'Therapist name is ambiguous; use a stable id.', ambiguous: true });
            }
            const therapistId = th.rows[0].id;
            await lockScheduleTherapist(client, yid, body.day, therapistId);

            // Lock the cell for the length of the decision, so two therapists
            // saving the same cell in the same instant cannot both read "free".
            const cur = await client.query(
                `SELECT sl.id, s.name AS student
                   FROM schedule_slots sl
                   JOIN therapists t ON t.id = sl.therapist_id
                   LEFT JOIN students s ON s.id = sl.student_id
                  WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.time_slot = $3
                    AND lower(btrim(t.name)) = $4
                  FOR UPDATE OF sl`,
                [yid, body.day, body.time, norm(body.therapist)]
            );
            if (cur.rows.length > 1) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: IS_GROUP, group: true });
            }
            const present: string | null = cur.rows.length ? (cur.rows[0].student ?? null) : null;

            // Someone else got here first with something different.
            if (body.expected !== undefined) {
                const expected = (body.expected ?? '') || null;
                if ((present ?? null) !== expected) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'that cell changed while you were editing',
                        day: body.day, time: body.time, therapist: body.therapist,
                        expected, actual: present
                    });
                }
            }

            if (!wanted) {
                await client.query(
                    `DELETE FROM schedule_slots
                      WHERE school_year_id = $1 AND day = $2 AND time_slot = $3 AND therapist_id = $4`,
                    [yid, body.day, body.time, therapistId]
                );
                await client.query('COMMIT');
                return { ok: true, day: body.day, time: body.time, therapist: body.therapist, student: null, previous: present };
            }
            if (!th.rows[0].active_this_year) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: `therapist "${body.therapist}" is not active in this school year` });
            }

            // A name that matches two students is the documented trap — refuse
            // rather than book the wrong child into the slot.
            const st = await client.query(
                `SELECT s.id, s.public_id, s.name FROM students s
                 JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = $2 AND e.active
                 WHERE lower(btrim(s.name)) = $1 AND s.active`, [norm(wanted), yid]
            );
            if (st.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `unknown or archived student "${wanted}"` });
            }
            if (st.rows.length > 1) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: `"${wanted}" matches ${st.rows.length} students — cannot tell which`, ambiguous: true });
            }

            if (!DAY_ORDER[norm(body.day)]) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'Unknown schedule day.' });
            }
            await lockScheduleStudents(client, yid, body.day, [st.rows[0].public_id]);
            const overlaps = await scheduleOverlaps(client, yid, body.day, therapistId,
                body.time, st.rows[0].public_id, [body.time]);
            const refusal = overlapRefusal(overlaps, therapistId);
            if (refusal) {
                await client.query('ROLLBACK');
                return reply.code(409).send(refusal);
            }

            await client.query(
                `DELETE FROM schedule_slots WHERE school_year_id = $1 AND day = $2 AND time_slot = $3 AND therapist_id = $4`,
                [yid, body.day, body.time, therapistId]);
            await client.query(
                `INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, $3, $4, $5, $6, 'api')`,
                [yid, body.day, DAY_ORDER[norm(body.day)] ?? 0, body.time, therapistId, st.rows[0].id]
            );
            await client.query('COMMIT');
            return { ok: true, day: body.day, time: body.time, therapist: body.therapist, student: st.rows[0].name, previous: present };

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });
}
