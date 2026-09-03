import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { deriveProgress } from '../lib/progress.js';

/**
 * Stage D of moving the apps onto the database: S-Dnevnik's ATTENDANCE, one
 * mark at a time -- the same move Stage A made for a schedule cell.
 *
 * S-Dnevnik has one user, so this is not about two therapists colliding. It is
 * about one therapist and two machines. The diary is saved as a whole document,
 * so the work/home split has exactly one safe answer per sync: whichever side
 * changed since the two last agreed wins the WHOLE year. Mark Tuesday at school
 * and Wednesday at home before the two ever meet and there is nothing to merge
 * -- sync-peer refuses, correctly, and a human has to choose which day to
 * throw away. At the granularity of a mark that situation stops existing: two
 * marks on two dates are two rows and both survive.
 *
 * A mark is (student, date, slot key). Same-mark edits are the only real
 * contention, and `expected` turns those into a reported 409 instead of a
 * silent overwrite -- baseVersion per row rather than per document.
 *
 * WHAT IS DELIBERATELY ABSENT: any way to write progress. See lib/progress.ts.
 * Progress is derived here from the mark that was just written, in the same
 * transaction, because attendance is the fact and progress is a view of it.
 *
 * WHAT IS DELIBERATELY STILL IN THE BLOB: the diary's students. Stage A left a
 * hole by stopping the blob from carrying the schedule while names still rode
 * inside it, so a cell naming an unknown student 404'd and the term went
 * missing. Nothing like that can happen here, because this stage does not stop
 * the blob carrying anything except attendance and progress -- a new student
 * still reaches the database the way they always did. A mark for a student the
 * database has not linked yet is answered 404 and the app says so out loud
 * rather than dropping it.
 */

const MarkBody = z.object({
    /** The diary's own student id (Date.now(), hence a number, hence bigint). */
    sdnevnikId: z.union([z.number(), z.string()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** "monday-0": the day plus the slot's position. */
    slotKey: z.string().min(1).max(60),
    /** null clears the mark -- the diary's third click, "not addressed". */
    status: z.enum(['present', 'absent']).nullable(),
    /** The diary's time label. Two marks sharing date+time are one session. */
    time: z.string().max(120).nullable().optional(),
    /** Row-level optimistic concurrency: the status the caller believes is stored. */
    expected: z.enum(['present', 'absent']).nullable().optional()
});

/**
 * Stage E: the diary's own weekly plan, one slot at a time.
 *
 * A slot is (day, position) and it holds an ORDERED LIST of students, not one
 * — two children can share a term, and the order they are listed in is the
 * order the therapist put them in. That is why migration 009 added `ordinal`:
 * without it the round trip returns them in whatever order the query yields,
 * which is a quiet change to the file even though no information is missing.
 *
 * Positions are not decoration either. `attendance.slot_key` is literally
 * day || '-' || position, so a slot's index is part of the identity of every
 * mark filed against it.
 */
const SlotBody = z.object({
    day: z.string().min(1).max(20),
    position: z.number().int().min(0).max(50),
    /** The whole list for this slot, in order. Empty clears it. */
    students: z.array(z.union([z.number(), z.string()])).max(20),
    /** Row-level optimistic concurrency: the list the caller believes is stored. */
    expected: z.array(z.union([z.number(), z.string()])).max(20).optional()
});

const HistoryBody = z.object({
    payload: z.record(z.unknown())
});

const ClearBody = z.object({
    /**
     * The year the APP believes it is closing. Not the one it is opening: at
     * the moment „Заврши учебна година" runs, the diary's calendar still says
     * the old year and the therapist updates it afterwards.
     */
    closingYear: z.string().min(1).max(20)
});

function asSdnId(value: number | string): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export async function diaryWriteRoutes(server: FastifyInstance) {

    /**
     * One attendance mark.
     *
     * Idempotent: the diary re-sends whatever its diff still disagrees about,
     * so writing the same mark twice must be the same as writing it once.
     */
    server.put('/api/diary/attendance', async (req, reply) => {
        const body = MarkBody.parse(req.body);
        const sdnId = asSdnId(body.sdnevnikId);
        if (sdnId == null) return reply.code(400).send({ error: 'sdnevnikId is not a usable id' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const st = await client.query(
                'SELECT id, name, active FROM students WHERE sdnevnik_id = $1', [sdnId]
            );
            if (!st.rows.length) {
                await client.query('ROLLBACK');
                // Not an error the app can fix by retrying, so name the cure.
                return reply.code(404).send({
                    error: `no student is linked to diary id ${sdnId} -- save the diary once so the roster is projected first`,
                    sdnevnikId: sdnId, unlinked: true
                });
            }
            const studentId: number = st.rows[0].id;

            // Lock the mark for the length of the decision, so two saves of the
            // same mark in the same instant cannot both read "nothing there".
            const cur = await client.query(
                `SELECT status FROM attendance
                  WHERE student_id = $1 AND date = $2 AND slot_key = $3
                  FOR UPDATE`,
                [studentId, body.date, body.slotKey]
            );
            const present: 'present' | 'absent' | null = cur.rows.length ? cur.rows[0].status : null;

            if (body.expected !== undefined && present !== (body.expected ?? null)) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that mark changed while you were editing',
                    date: body.date, slotKey: body.slotKey, sdnevnikId: sdnId,
                    student: st.rows[0].name,
                    expected: body.expected ?? null, actual: present
                });
            }

            if (body.status === null) {
                await client.query(
                    'DELETE FROM attendance WHERE student_id = $1 AND date = $2 AND slot_key = $3',
                    [studentId, body.date, body.slotKey]
                );
            } else {
                await client.query(
                    `INSERT INTO attendance (student_id, date, slot_key, status, time_slot)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (student_id, date, slot_key)
                     DO UPDATE SET status = EXCLUDED.status, time_slot = EXCLUDED.time_slot`,
                    [studentId, body.date, body.slotKey, body.status, body.time || null]
                );
            }

            // In the same transaction as the mark, because progress that
            // disagrees with the attendance it was computed from is worse than
            // no progress at all.
            const progress = await deriveProgress(client, studentId);

            await client.query('COMMIT');
            return {
                ok: true,
                student: st.rows[0].name,
                date: body.date, slotKey: body.slotKey,
                status: body.status, previous: present,
                progress
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Attendance in the diary's own shape:
     *   { "2026-05-11": { "101": { "monday-0": { status, date, time } } } }
     *
     * Returned exactly as the app holds it so that reading needs no
     * translation, for the same reason GET /api/schedule already matches
     * scheduleData.schedule. Defaults to the current school year: the diary
     * only ever displays one year, and sending every year would grow without
     * limit while answering a question nobody asked.
     */
    server.get('/api/diary/attendance', async (req) => {
        const q = req.query as any;
        const { rows } = await pool.query(
            `WITH span AS (
                 SELECT COALESCE($1::date, (SELECT starts_on FROM school_years WHERE is_current)) AS from_day,
                        COALESCE($2::date, (SELECT ends_on   FROM school_years WHERE is_current)) AS to_day
             )
             SELECT s.sdnevnik_id::text AS sdnevnik_id, a.date, a.slot_key, a.status, a.time_slot
             FROM attendance a
             JOIN students s ON s.id = a.student_id
             CROSS JOIN span
             WHERE s.sdnevnik_id IS NOT NULL
               AND (span.from_day IS NULL OR a.date >= span.from_day)
               AND (span.to_day   IS NULL OR a.date <= span.to_day)
             ORDER BY a.date, s.sdnevnik_id, a.slot_key`,
            [q?.from ?? null, q?.to ?? null]
        );

        const out: Record<string, Record<string, Record<string, unknown>>> = {};
        for (const r of rows) {
            const day = (out[r.date] ||= {});
            const student = (day[r.sdnevnik_id] ||= {});
            student[r.slot_key] = { status: r.status, date: r.date, time: r.time_slot ?? '' };
        }
        return out;
    });

    /**
     * Progress in the diary's own shape:
     *   { "101": { "3": [ { index, date, time } ] } }
     *
     * Read-only on purpose. The app rebuilds its own copy from attendance with
     * the function it already has; this exists so that the two derivations can
     * be compared instead of trusted, and so the overview screens can read
     * progress without re-deriving it.
     */
    server.get('/api/diary/progress', async () => {
        const { rows } = await pool.query(
            `SELECT s.sdnevnik_id::text AS sdnevnik_id,
                    p.sdnevnik_id::text AS plan_id,
                    pa.position, spp.completed_on, spp.time_slot
             FROM student_plan_progress spp
             JOIN plan_activities pa ON pa.id = spp.activity_id
             JOIN plans p  ON p.id = pa.plan_id
             JOIN students s ON s.id = spp.student_id
             WHERE s.sdnevnik_id IS NOT NULL AND p.sdnevnik_id IS NOT NULL
             ORDER BY s.sdnevnik_id, p.sdnevnik_id, pa.position`
        );

        const out: Record<string, Record<string, unknown[]>> = {};
        for (const r of rows) {
            const student = (out[r.sdnevnik_id] ||= {});
            const plan = (student[r.plan_id] ||= []);
            plan.push({ index: r.position, date: r.completed_on, time: r.time_slot ?? '' });
        }
        return out;
    });

    /**
     * Recompute one student's progress, or everyone's, from attendance.
     *
     * The server-side twin of the diary's "Реконструирај" button, and the
     * repair path for the refusal in lib/progress.ts: once the missing times
     * have arrived, this is how the numbers are put right without anyone
     * having to save the whole document.
     */
    server.post('/api/diary/progress/rebuild', async (req) => {
        const body = (req.body ?? {}) as any;
        const one = body.sdnevnikId != null ? asSdnId(body.sdnevnikId) : null;

        const targets = await pool.query(
            `SELECT id, name, sdnevnik_id::text AS sdnevnik_id FROM students
              WHERE sdnevnik_id IS NOT NULL AND plan_id IS NOT NULL
                AND ($1::bigint IS NULL OR sdnevnik_id = $1)
              ORDER BY name`,
            [one]
        );

        const results: unknown[] = [];
        for (const s of targets.rows) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const r = await deriveProgress(client, s.id);
                await client.query('COMMIT');
                results.push({ student: s.name, sdnevnikId: s.sdnevnik_id, ...r });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }
        return { ok: true, students: results.length, results };
    });

    // ─────────────────────────────────────────────────────────────────────
    // Stage E — the diary's own week.
    // ─────────────────────────────────────────────────────────────────────

    /** One slot: (day, position) → the ordered list of students in it. */
    server.put('/api/diary/schedule/slot', async (req, reply) => {
        const body = SlotBody.parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const yr = await client.query('SELECT id FROM school_years WHERE is_current');
            const yid: number | undefined = yr.rows[0]?.id;
            if (yid == null) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'no current school year is set' });
            }

            // Lock the slot for the length of the decision.
            const cur = await client.query(
                `SELECT s.sdnevnik_id::text AS sdnevnik_id
                   FROM diary_schedule d JOIN students s ON s.id = d.student_id
                  WHERE d.school_year_id = $1 AND d.day = $2 AND d.position = $3
                  ORDER BY d.ordinal
                  FOR UPDATE OF d`,
                [yid, body.day, body.position]
            );
            const present: string[] = cur.rows.map((r: any) => r.sdnevnik_id);

            if (body.expected !== undefined) {
                const expected = body.expected.map(String);
                if (expected.length !== present.length || expected.some((v, i) => v !== present[i])) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'that slot changed while you were editing',
                        day: body.day, position: body.position,
                        expected, actual: present
                    });
                }
            }

            // Resolve every student BEFORE writing anything: a slot half
            // applied is worse than one refused, because the therapist sees a
            // term with a child missing from it and no reason given.
            const ids: number[] = [];
            for (const raw of body.students) {
                const sdnId = asSdnId(raw);
                if (sdnId == null) {
                    await client.query('ROLLBACK');
                    return reply.code(400).send({ error: `"${raw}" is not a usable diary id` });
                }
                const st = await client.query('SELECT id FROM students WHERE sdnevnik_id = $1', [sdnId]);
                if (!st.rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({
                        error: `no student is linked to diary id ${sdnId} -- save the diary once so the roster is projected first`,
                        sdnevnikId: sdnId, unlinked: true
                    });
                }
                ids.push(st.rows[0].id);
            }

            await client.query(
                'DELETE FROM diary_schedule WHERE school_year_id = $1 AND day = $2 AND position = $3',
                [yid, body.day, body.position]
            );
            for (let ordinal = 0; ordinal < ids.length; ordinal++) {
                await client.query(
                    `INSERT INTO diary_schedule (school_year_id, day, position, student_id, ordinal)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [yid, body.day, body.position, ids[ordinal], ordinal]
                );
            }

            await client.query('COMMIT');
            return { ok: true, day: body.day, position: body.position, students: body.students.map(String), previous: present };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * The week in the diary's own shape:
     *   { monday: [[9001], [], [9001, 9002], [], []], tuesday: [...] }
     *
     * Padded to the diary's five slots so an empty database still returns
     * something the app can render, and longer if anything sits past the fifth
     * — the number of slots is the app's business, not this table's, and
     * truncating would silently drop a term.
     */
    server.get('/api/diary/schedule', async () => {
        const { rows } = await pool.query(
            `SELECT d.day, d.position, d.ordinal, s.sdnevnik_id::text AS sdnevnik_id
             FROM diary_schedule d
             JOIN students s ON s.id = d.student_id
             JOIN school_years y ON y.id = d.school_year_id AND y.is_current
             WHERE s.sdnevnik_id IS NOT NULL
             ORDER BY d.day, d.position, d.ordinal`
        );

        const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
        const SLOTS = 5;
        const out: Record<string, string[][]> = {};
        for (const day of DAYS) out[day] = Array.from({ length: SLOTS }, () => [] as string[]);

        for (const r of rows) {
            const day = (out[r.day] ||= Array.from({ length: SLOTS }, () => [] as string[]));
            while (day.length <= r.position) day.push([]);
            day[r.position].push(r.sdnevnik_id);
        }
        return out;
    });

    /**
     * Empty the week, deliberately — the „Заврши учебна година" step.
     *
     * This exists because of an ordering trap, not because the app could not
     * send twenty-five empty slots itself. Everything the apps save lands in
     * whichever year is `is_current`, so the September routine is: roll the
     * DATABASE over first, then close the year in the diary. Done the other way
     * round, twenty-five individual "this slot is now empty" writes are twenty-
     * five deletions from the year that is still current — and unlike a
     * whole-document save there is no empty-payload guard to catch it, because
     * each one is an explicit intent rather than an absence.
     *
     * So the app names the year it believes it is closing, and if the database
     * still calls that year current, this refuses and says what to run. The
     * trap becomes a sentence instead of a year of terms.
     */
    server.delete('/api/diary/schedule', async (req, reply) => {
        // A DELETE with no body is easy to send by accident (curl, a retry, a
        // client that drops the payload). Refusing it clearly beats a 500 that
        // looks like the server is broken.
        const parsed = ClearBody.safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send({
                error: 'name the year being closed: { "closingYear": "2025/2026" }'
            });
        }
        const closing = parsed.data.closingYear.trim();

        const cur = await pool.query('SELECT id, label FROM school_years WHERE is_current');
        if (!cur.rows.length) return reply.code(409).send({ error: 'no current school year is set' });

        if (cur.rows[0].label === closing) {
            return reply.code(409).send({
                error: `the database still has ${closing} as the current year, so emptying the week would empty ${closing} itself. ` +
                       'Roll the database over first: npm run rollover -- --to <new year> --apply',
                rollFirst: true,
                currentYear: cur.rows[0].label
            });
        }

        const { rowCount } = await pool.query(
            'DELETE FROM diary_schedule WHERE school_year_id = $1', [cur.rows[0].id]
        );
        return { ok: true, closed: closing, currentYear: cur.rows[0].label, cleared: rowCount ?? 0 };
    });

    /**
     * One week's snapshot of the schedule.
     *
     * FIRST WRITE WINS, because that is what the diary itself does
     * (`if (!scheduleHistory[weekKey])`) and what the snapshot means: how the
     * week looked, not how it looks now. A second machine arriving later with
     * its own view must not restate it.
     */
    server.put('/api/diary/schedule/history/:weekOf', async (req, reply) => {
        const weekOf = String((req.params as any).weekOf || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
            return reply.code(400).send({ error: `"${weekOf}" is not a week start date` });
        }
        const body = HistoryBody.parse(req.body);

        const yr = await pool.query('SELECT id FROM school_years WHERE is_current');
        if (!yr.rows.length) return reply.code(409).send({ error: 'no current school year is set' });

        const { rowCount } = await pool.query(
            `INSERT INTO diary_schedule_history (school_year_id, week_of, payload)
             VALUES ($1, $2, $3)
             ON CONFLICT (school_year_id, week_of) DO NOTHING`,
            [yr.rows[0].id, weekOf, JSON.stringify(body.payload)]
        );
        return { ok: true, weekOf, created: (rowCount ?? 0) > 0 };
    });

    /** Every snapshot for the current year, in the diary's own shape. */
    server.get('/api/diary/schedule/history', async () => {
        const { rows } = await pool.query(
            `SELECT h.week_of, h.payload FROM diary_schedule_history h
             JOIN school_years y ON y.id = h.school_year_id AND y.is_current
             ORDER BY h.week_of`
        );
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.week_of] = r.payload;
        return out;
    });
}
