import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { norm, DAY_ORDER } from '../lib/import-core.js';
import { minutesOf, slotBell, timeOf } from '../lib/crossing.js';
import { assertOwnTherapistId, assertOwnTherapistName, refuseScope, scopeOf } from '../lib/colleague.js';

/**
 * Stage A of moving Rasporedi onto the database: ONE schedule cell at a time.
 *
 * Today both apps save by replacing the whole document, which is why two
 * therapists cannot use Rasporedi at once — each save overwrites the other's
 * week wholesale, silently, even when they edited different cells. There is
 * nothing to merge because the unit of change is "everything".
 *
 * A cell is (day, time, therapist). Two therapists edit different cells, so at
 * this granularity their writes do not touch and there is no conflict to
 * resolve. Same-cell edits are the only genuine contention, and `expected`
 * turns those into a reported 409 instead of a silent overwrite — the same
 * idea as baseVersion on the blob, applied per row rather than per document.
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

const BlockBody = z.object({
    year: z.string().min(1).max(64).optional(),
    day: z.string().min(1).max(40),
    /** The containing cabinet bell, always one 40-minute range. */
    time: z.string().min(1).max(80),
    therapistId: z.number().int().positive(),
    /** 0 clears; 1 owns all 40 minutes; 2 are ordered 20-minute halves. */
    studentPublicIds: z.array(z.string().min(1).max(80)).max(2),
    /** Semantic block state, irrespective of whether one legacy pupil used two equal half-rows. */
    expectedStudentPublicIds: z.array(z.string().min(1).max(80)).max(2).optional()
});

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function blockTimes(label: string): { full: string; halves: [string, string] } | null {
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

function semanticBlock(rows: any[], times: { full: string; halves: [string, string] }): string[] | null {
    const full = rows.find((row) => row.time_slot === times.full)?.student_public_id;
    const halves = times.halves.map((time) =>
        rows.find((row) => row.time_slot === time)?.student_public_id).filter(Boolean);
    if (full && halves.length) return null; // contradictory overlap; never silently choose one
    if (full) return [String(full)];
    if (halves.length === 2 && halves[0] === halves[1]) return [String(halves[0])];
    return halves.map(String);
}

async function yearId(label?: string): Promise<number | null> {
    const { rows } = await pool.query(
        `SELECT id FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    return rows.length ? rows[0].id : null;
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
        const body = BlockBody.parse(req.body);
        try { assertOwnTherapistId(await scopeOf(req), body.therapistId); }
        catch (err) { return refuseScope(reply, err); }
        const times = blockTimes(body.time);
        if (!times) return reply.code(400).send({ error: 'a block must name one 40-minute time range' });
        if (new Set(body.studentPublicIds).size !== body.studentPublicIds.length) {
            return reply.code(400).send({ error: 'leave the second pupil empty when one pupil owns all 40 minutes' });
        }
        const dayOrder = DAY_ORDER[norm(body.day)];
        if (!dayOrder) return reply.code(400).send({ error: `unknown working day "${body.day}"` });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
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

            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext(
                    'fusion-therapist:' || $1::text || ':' || $2 || ':' || $3::text
                ))`,
                [year.id, body.day, body.therapistId]
            );

            const exactTimes = [times.full, ...times.halves];
            const currentRows = (await client.query(
                `SELECT sl.time_slot, s.public_id AS student_public_id, s.name AS student_name
                 FROM schedule_slots sl LEFT JOIN students s ON s.id = sl.student_id
                 WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.therapist_id = $3
                   AND sl.time_slot = ANY($4::text[])
                 ORDER BY sl.time_slot FOR UPDATE OF sl`,
                [year.id, body.day, body.therapistId, exactTimes]
            )).rows;
            const present = semanticBlock(currentRows, times);
            if (present == null) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that block contains overlapping full and half rows; clear them explicitly first',
                    blockOverlap: true
                });
            }
            if (body.expectedStudentPublicIds !== undefined &&
                !sameIds(present, body.expectedStudentPublicIds)) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that block changed while you were editing',
                    expectedStudentPublicIds: body.expectedStudentPublicIds,
                    actualStudentPublicIds: present
                });
            }

            const fullSpan = slotBell(times.full)!;
            const otherOwnRows = (await client.query(
                `SELECT sl.time_slot, s.name AS student_name
                 FROM schedule_slots sl LEFT JOIN students s ON s.id = sl.student_id
                 WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.therapist_id = $3
                   AND NOT (sl.time_slot = ANY($4::text[]))`,
                [year.id, body.day, body.therapistId, exactTimes]
            )).rows;
            const blockStart = minutesOf(fullSpan.startsAt);
            const blockEnd = blockStart + fullSpan.minutes;
            const foreignOverlap = otherOwnRows.find((row) => {
                const other = slotBell(row.time_slot);
                if (!other) return false;
                const start = minutesOf(other.startsAt);
                return blockStart < start + other.minutes && start < blockEnd;
            });
            if (foreignOverlap) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that therapist has another row overlapping this block',
                    therapistOccupied: true, time: foreignOverlap.time_slot,
                    studentName: foreignOverlap.student_name
                });
            }

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
                        error: 'that student is not in this therapist caseload', notInCaseload: true
                    });
                }
                students.push(student);
            }

            for (const publicId of [...body.studentPublicIds].sort()) {
                await client.query(
                    `SELECT pg_advisory_xact_lock(hashtext(
                        'fusion-student:' || $1::text || ':' || $2 || ':' || $3
                    ))`,
                    [year.id, body.day, publicId]
                );
            }

            const desiredTimes = students.length === 1 ? [times.full] : times.halves.slice(0, students.length);
            if (students.length) {
                const conflicts = (await client.query(
                    `SELECT sl.time_slot, s.public_id AS student_public_id,
                            t.id AS therapist_id, t.name AS therapist_name
                     FROM schedule_slots sl
                     JOIN students s ON s.id = sl.student_id
                     JOIN therapists t ON t.id = sl.therapist_id
                     WHERE sl.school_year_id = $1 AND sl.day = $2
                       AND sl.therapist_id <> $3
                       AND s.public_id = ANY($4::text[])`,
                    [year.id, body.day, body.therapistId, body.studentPublicIds]
                )).rows;
                for (let index = 0; index < students.length; index++) {
                    const wanted = slotBell(desiredTimes[index])!;
                    const wantedStart = minutesOf(wanted.startsAt);
                    const wantedEnd = wantedStart + wanted.minutes;
                    const duplicate = conflicts.find((row) => {
                        if (row.student_public_id !== students[index].public_id) return false;
                        const other = slotBell(row.time_slot);
                        if (!other) return false;
                        const otherStart = minutesOf(other.startsAt);
                        return wantedStart < otherStart + other.minutes && otherStart < wantedEnd;
                    });
                    if (duplicate) {
                        await client.query('ROLLBACK');
                        return reply.code(409).send({
                            error: 'that student already has an overlapping session',
                            doubleBooked: true, therapistId: duplicate.therapist_id,
                            therapistName: duplicate.therapist_name, time: duplicate.time_slot
                        });
                    }
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
            await client.query('COMMIT');
            return {
                ok: true, year: year.label, day: body.day, time: times.full,
                therapistId: therapist.id, therapistName: therapist.name,
                studentPublicIds: students.map((student) => student.public_id),
                previousStudentPublicIds: present,
                sessions: students.map((student, index) => ({
                    day: body.day, time: desiredTimes[index], therapist_id: therapist.id,
                    therapist_name: therapist.name, student_public_id: student.public_id,
                    student_name: student.name
                }))
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
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

            // Different labels can still overlap (08:00-08:40 versus
            // 08:00-08:20). Serialize the therapist's whole day before
            // checking, otherwise two concurrent requests could each see the
            // other overlapping cell as absent and both commit.
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext(
                    'fusion-therapist:' || $1::text || ':' || $2 || ':' || $3::text
                ))`,
                [year.id, body.day, body.therapistId]
            );

            const current = (await client.query(
                `SELECT sl.id, s.public_id AS student_public_id, s.name AS student_name
                 FROM schedule_slots sl
                 LEFT JOIN students s ON s.id = sl.student_id
                 WHERE sl.school_year_id = $1 AND sl.day = $2 AND sl.time_slot = $3
                   AND sl.therapist_id = $4
                 FOR UPDATE OF sl`,
                [year.id, body.day, body.time, body.therapistId]
            )).rows[0];
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

            // Two therapists assigning the same child to overlapping time
            // ranges must queue behind each other even though the text labels
            // and the therapist rows differ.
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext(
                    'fusion-student:' || $1::text || ':' || $2 || ':' || $3
                ))`,
                [year.id, body.day, body.studentPublicId]
            );

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

            const possibleOverlaps = (await client.query(
                `SELECT sl.time_slot, sl.therapist_id,
                        t.name AS therapist_name,
                        s.public_id AS student_public_id, s.name AS student_name
                 FROM schedule_slots sl
                 JOIN therapists t ON t.id = sl.therapist_id
                 LEFT JOIN students s ON s.id = sl.student_id
                 WHERE sl.school_year_id = $1 AND sl.day = $2
                   AND (sl.therapist_id = $4 OR sl.student_id = $5)
                   AND NOT (sl.time_slot = $3 AND sl.therapist_id = $4)`,
                [year.id, body.day, body.time, body.therapistId, student.id]
            )).rows.filter((row) => {
                const other = slotBell(row.time_slot);
                if (!other) return false;
                const start = minutesOf(span.startsAt);
                const end = start + span.minutes;
                const otherStart = minutesOf(other.startsAt);
                const otherEnd = otherStart + other.minutes;
                return start < otherEnd && otherStart < end;
            });

            const occupied = possibleOverlaps.find((row) =>
                Number(row.therapist_id) === body.therapistId);
            if (occupied) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that therapist already has an overlapping session',
                    therapistOccupied: true,
                    time: occupied.time_slot,
                    studentPublicId: occupied.student_public_id,
                    studentName: occupied.student_name
                });
            }

            const duplicate = possibleOverlaps.find((row) =>
                row.student_public_id === body.studentPublicId &&
                Number(row.therapist_id) !== body.therapistId);
            if (duplicate) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that student already has a session at this time',
                    doubleBooked: true,
                    therapistId: duplicate.therapist_id,
                    therapistName: duplicate.therapist_name,
                    time: duplicate.time_slot
                });
            }

            await client.query(
                `INSERT INTO schedule_slots
                    (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, $3, $4, $5, $6, 'api')
                 ON CONFLICT (school_year_id, day, time_slot, therapist_id)
                 DO UPDATE SET student_id = EXCLUDED.student_id, source = 'api'`,
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
            const therapistId = th.rows[0].id;

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
                `SELECT s.id, s.name FROM students s
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

            await client.query(
                `INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, $3, $4, $5, $6, 'api')
                 ON CONFLICT (school_year_id, day, time_slot, therapist_id)
                 DO UPDATE SET student_id = EXCLUDED.student_id, source = 'api'`,
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
