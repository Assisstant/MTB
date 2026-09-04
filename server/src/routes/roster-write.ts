import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { norm, asText, stableStudentIdForName } from '../lib/import-core.js';
import { assertOwner, assertOwnTherapistName, refuseScope, scopeOf } from '../lib/colleague.js';

/**
 * Stage B of moving Rasporedi onto the database: the ROSTER, one person at a
 * time — the same move Stage A made for schedule cells.
 *
 * Stage A left a hole. With per-cell writes on, the blob no longer carries the
 * schedule, so a cell that names a student the database has never heard of is
 * refused with 404 and the term is silently missing on the server. Adding a
 * student had no path of its own; it rode along inside the whole-document save,
 * which is exactly what Stage A stopped doing. These endpoints are that path.
 *
 * WHAT IS DELIBERATELY ABSENT: delete.
 *
 * Removing a student from Rasporedi's list means "not on my schedule", which is
 * not the same fact as "left the school" — a child can be untimetabled for a
 * term and still be enrolled. Enrolment has exactly one owner, S-Dnevnik's
 * archive (CLAUDE.md rule 5), and `applyStudentStatus` is how that owner's
 * decision reaches this database. If Rasporedi could deactivate rows there
 * would be two deciders for one fact, and the next payload from the other side
 * would switch them straight back — the precise failure `rollover-year` already
 * had and had to give up.
 *
 * So the roster here only ever grows or is corrected. What Rasporedi drops
 * locally, it drops locally.
 */

const StudentBody = z.object({
    /** The app's own stable id. Omitted only when creating from a bare name. */
    publicId: z.string().min(1).max(80).optional(),
    name: z.string().min(1).max(200),
    grade: z.string().max(40).nullable().optional(),
    year: z.string().min(1).max(64).optional(),
    kind: z.enum(['internal', 'boarding', 'external']).optional()
});

const StudentPatch = z.object({
    name: z.string().min(1).max(200).optional(),
    grade: z.string().max(40).nullable().optional(),
    /** Row-level optimistic concurrency: the name the caller believes is stored. */
    expected: z.string().max(200).optional(),
    /**
     * Which year's enrolment the grade belongs to. Absent means the current
     * one, which is what Rasporedi has always meant — a child's class is a fact
     * about a year, and a screen that is looking at 2025/2026 must not write
     * its answer onto 2026/2027.
     */
    year: z.string().min(1).max(64).optional(),
    /**
     * internal / boarding / external, for that year's enrolment. An external
     * child belongs to no class and never will; recording it is what stops the
     * crossing listing them for ever as a class somebody forgot to type in.
     */
    kind: z.enum(['internal', 'boarding', 'external']).optional()
});

const TherapistBody = z.object({
    name: z.string().min(1).max(120),
    year: z.string().min(1).max(64).optional()
});
const TherapistPatch = z.object({
    name: z.string().min(1).max(120),
    expected: z.string().max(120).optional()
});
const YearQuery = z.object({
    year: z.string().min(1).max(64).optional()
});

async function currentYearId(client: any, label?: string): Promise<number | null> {
    const { rows } = await client.query(
        `SELECT id FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    return rows.length ? rows[0].id : null;
}

export async function rosterWriteRoutes(server: FastifyInstance) {

    /**
     * Add a student, or correct one that is already there.
     *
     * Idempotent on `publicId`, because the app resends its whole roster
     * whenever it is unsure — a retry after a dropped connection must not
     * create a second row for the same child.
     */
    server.post('/api/students', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'списокот на ученици'); }
        catch (err) { return refuseScope(reply, err); }
        const body = StudentBody.parse(req.body);
        const name = body.name.trim();
        const kind = body.kind ?? 'internal';
        const grade = kind === 'external' ? null : asText(body.grade);
        const explicitEnrollment = body.kind !== undefined || body.grade !== undefined;
        // The app computes this id the same way, byte for byte, so a student
        // created here and one created there converge on one row.
        const publicId = body.publicId?.trim() || stableStudentIdForName(name);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const existing = await client.query(
                'SELECT id, name, grade, active FROM students WHERE public_id = $1 FOR UPDATE',
                [publicId]
            );

            // Archived means S-Dnevnik decided this child has left. Rasporedi
            // listing them is not evidence to the contrary — an app that has
            // not pulled yet still shows last year's roster. Say so and stop;
            // do not quietly re-enrol anyone.
            if (existing.rows.length && !existing.rows[0].active) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: `"${existing.rows[0].name}" is archived — S-Dnevnik decides who is enrolled`,
                    archived: true, publicId
                });
            }

            const yid = await currentYearId(client, body.year);
            if (body.year !== undefined && yid == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year}` });
            }
            if (existing.rows.length && yid != null) {
                const membership = await client.query(
                    `SELECT active FROM student_enrollments
                     WHERE student_id = $1 AND school_year_id = $2`,
                    [existing.rows[0].id, yid]
                );
                if (!membership.rows[0]?.active) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${existing.rows[0].name}" is not active in this school year — add them from Podatoci suggestions`,
                        inactiveThisYear: true,
                        publicId
                    });
                }
            }

            // A different student already holding this name is the documented
            // trap (there are two „Јана Пробева"). Allowed — grade tells them
            // apart — but the caller is told, because a name typed twice by
            // accident looks exactly like this.
            const clash = await client.query(
                'SELECT public_id, grade FROM students WHERE lower(btrim(name)) = $1 AND public_id <> $2 AND active',
                [norm(name), publicId]
            );

            const { rows } = await client.query(
                `INSERT INTO students (public_id, name, grade)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (public_id) DO UPDATE
                 SET name = EXCLUDED.name,
                     grade = COALESCE(EXCLUDED.grade, students.grade),
                     updated_at = now()
                 RETURNING id, public_id, name, grade`,
                [publicId, name, grade]
            );

            // Being on the roster is being enrolled this year — the same row
            // writeAll() creates, so the two paths cannot disagree.
            if (yid != null) {
                await client.query(
                    `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (student_id, school_year_id) DO UPDATE
                     SET grade = CASE WHEN $5::boolean
                                      THEN EXCLUDED.grade
                                      ELSE COALESCE(EXCLUDED.grade, student_enrollments.grade)
                                 END,
                         kind = COALESCE($6::text, student_enrollments.kind)`,
                    [rows[0].id, yid, grade, kind, explicitEnrollment, body.kind ?? null]
                );
            }

            await client.query('COMMIT');
            return {
                ok: true,
                created: existing.rows.length === 0,
                student: rows[0],
                sameName: clash.rows.map((r: any) => ({ publicId: r.public_id, grade: r.grade }))
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Rename or re-grade one student. The id does not move, so every term,
     * attendance mark and dossier hanging off it follows the rename for free —
     * which is the whole reason the apps carry a stable id instead of keying
     * children by their name.
     */
    server.patch('/api/students/:publicId', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'податоците на ученик'); }
        catch (err) { return refuseScope(reply, err); }
        const publicId = String((req.params as any).publicId || '').trim();
        const body = StudentPatch.parse(req.body);
        if (body.name === undefined && body.grade === undefined && body.kind === undefined) {
            return reply.code(400).send({ error: 'nothing to change' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const cur = await client.query(
                'SELECT id, name, grade, active FROM students WHERE public_id = $1 FOR UPDATE',
                [publicId]
            );
            if (!cur.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no student with id "${publicId}"` });
            }
            if (!cur.rows[0].active) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: `"${cur.rows[0].name}" is archived — edit them in S-Dnevnik`,
                    archived: true
                });
            }

            // Someone renamed this child on another machine while this browser
            // held the old name. Refuse rather than undo their correction.
            if (body.expected !== undefined && norm(body.expected) !== norm(cur.rows[0].name)) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: 'that student was renamed while you were editing',
                    expected: body.expected, actual: cur.rows[0].name
                });
            }

            const name = body.name === undefined ? cur.rows[0].name : body.name.trim();
            const grade = body.kind === 'external'
                ? null
                : (body.grade === undefined ? cur.rows[0].grade : asText(body.grade));

            const { rows } = await client.query(
                `UPDATE students SET name = $2, grade = $3, updated_at = now()
                  WHERE id = $1 RETURNING id, public_id, name, grade`,
                [cur.rows[0].id, name, grade]
            );

            const yid = await currentYearId(client, body.year);
            if (body.year !== undefined && yid == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year}` });
            }
            // Zero rows means the child is not enrolled in that year. Saying so
            // beats creating the enrolment quietly: who is enrolled has one
            // owner, and it is S-Dnevnik's archive, not this endpoint.
            let enrolled = true;
            if (yid != null) {
                const touched = await client.query(
                    `UPDATE student_enrollments
                        SET grade = $3,
                            kind = COALESCE($4, kind)
                      WHERE student_id = $1 AND school_year_id = $2`,
                    [cur.rows[0].id, yid, grade, body.kind ?? null]
                );
                enrolled = (touched.rowCount ?? 0) > 0;
            }

            await client.query('COMMIT');
            return {
                ok: true, student: rows[0], enrolled,
                previous: { name: cur.rows[0].name, grade: cur.rows[0].grade }
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /** Add a therapist. Idempotent on the name — that is all a therapist has. */
    server.post('/api/therapists', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'списокот на терапевти'); }
        catch (err) { return refuseScope(reply, err); }
        const body = TherapistBody.parse(req.body);
        const name = body.name.trim();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            let { rows } = await client.query(
                'SELECT id, name FROM therapists WHERE lower(btrim(name)) = $1', [norm(name)]
            );
            const created = rows.length === 0;
            if (created) {
                rows = (await client.query(
                    'INSERT INTO therapists (name) VALUES ($1) RETURNING id, name', [name]
                )).rows;
            }
            const yid = await currentYearId(client, body.year);
            if (yid == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }
            if (!created) {
                const membership = await client.query(
                    `SELECT active FROM therapist_years
                     WHERE school_year_id = $1 AND therapist_id = $2`,
                    [yid, rows[0].id]
                );
                if (!membership.rows[0]?.active) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${rows[0].name}" is not active in this school year — add them from Podatoci suggestions`,
                        inactiveThisYear: true
                    });
                }
            }
            await client.query(
                `INSERT INTO therapist_years (school_year_id, therapist_id, active)
                 VALUES ($1, $2, true)
                 ON CONFLICT (school_year_id, therapist_id) DO UPDATE SET active = true`,
                [yid, rows[0].id]
            );
            await client.query('COMMIT');
            return reply.code(created ? 201 : 200).send({ ok: true, created, therapist: rows[0] });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Who a therapist sees — one child at a time.
     *
     * This IS a delete, and that is not a contradiction of the rule above. The
     * rule protects PEOPLE: Rasporedi may not decide that a child has left the
     * school. A link is a different fact — "this therapist works with this
     * child" is Rasporedi's own decision, made with a checkbox, and unticking
     * it must actually mean something.
     *
     * Per link rather than per caseload, for the same reason cells are written
     * per cell: sending a therapist's whole list would replace it with one
     * browser's view of it, and two people ticking different boxes would undo
     * each other.
     */
    async function linkRoute(
        reply: any, therapistName: string, publicId: string, add: boolean, yearLabel?: string
    ) {
        const yid = await currentYearId(pool, yearLabel);
        if (yid == null) return reply.code(404).send({ error: `no such school year: ${yearLabel ?? '(current)'}` });

        const th = await pool.query(
            `SELECT t.id FROM therapists t
             JOIN therapist_years ty ON ty.therapist_id = t.id
             WHERE lower(btrim(t.name)) = $1 AND ty.school_year_id = $2 AND ty.active`,
            [norm(therapistName), yid]
        );
        if (!th.rows.length) {
            return reply.code(404).send({ error: `unknown or inactive therapist "${therapistName}" for that school year` });
        }

        const st = await pool.query(
            `SELECT s.id, s.active FROM students s
             JOIN student_enrollments e ON e.student_id = s.id
             WHERE s.public_id = $1 AND e.school_year_id = $2 AND e.active`,
            [publicId, yid]
        );
        if (!st.rows.length) {
            return reply.code(404).send({ error: `no active student with id "${publicId}" for that school year` });
        }

        if (add) {
            // Linking an archived child would put them back on a caseload
            // without anyone deciding they had returned.
            if (!st.rows[0].active) {
                return reply.code(409).send({ error: 'that student is archived in S-Dnevnik', archived: true });
            }
            await pool.query(
                `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [yid, th.rows[0].id, st.rows[0].id]
            );
        } else {
            await pool.query(
                `DELETE FROM therapist_students
                 WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
                [yid, th.rows[0].id, st.rows[0].id]
            );
        }
        return { ok: true, therapist: therapistName, student: publicId, schoolYearId: yid, linked: add };
    }

    server.put('/api/therapists/:name/students/:publicId', async (req, reply) => {
        const p = req.params as any;
        const q = YearQuery.parse(req.query);
        const name = String(p.name || '').trim();
        try { await assertOwnTherapistName(await scopeOf(req), name); }
        catch (err) { return refuseScope(reply, err); }
        return linkRoute(reply, name, String(p.publicId || '').trim(), true, q.year);
    });

    server.delete('/api/therapists/:name/students/:publicId', async (req, reply) => {
        const p = req.params as any;
        const q = YearQuery.parse(req.query);
        const name = String(p.name || '').trim();
        try { await assertOwnTherapistName(await scopeOf(req), name); }
        catch (err) { return refuseScope(reply, err); }
        return linkRoute(reply, name, String(p.publicId || '').trim(), false, q.year);
    });

    /**
     * Rename a therapist.
     *
     * Therapists have no stable id — the name IS the key, here and in every
     * schedule row that references them. So this is the one roster operation
     * the app cannot express as a diff: dropping "Ана" and adding "Ана С."
     * looks identical to a rename, and guessing wrong either orphans a week of
     * terms or merges two people. Rasporedi therefore states the intent, and
     * the foreign key carries the terms across.
     */
    server.patch('/api/therapists/:name', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'името на терапевт'); }
        catch (err) { return refuseScope(reply, err); }
        const from = String((req.params as any).name || '').trim();
        const to = TherapistPatch.parse(req.body).name.trim();

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const cur = await client.query(
                'SELECT id, name FROM therapists WHERE lower(btrim(name)) = $1 FOR UPDATE', [norm(from)]
            );
            if (!cur.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `unknown therapist "${from}"` });
            }
            if (norm(from) === norm(to)) {
                await client.query('ROLLBACK');
                return { ok: true, therapist: cur.rows[0], unchanged: true };
            }

            // Merging two therapists would silently pool their weeks together
            // and there would be no way back. Refuse; a human decides.
            const taken = await client.query(
                'SELECT id FROM therapists WHERE lower(btrim(name)) = $1 AND id <> $2', [norm(to), cur.rows[0].id]
            );
            if (taken.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: `"${to}" already exists — renaming would merge two therapists` });
            }

            const { rows } = await client.query(
                'UPDATE therapists SET name = $2 WHERE id = $1 RETURNING id, name', [cur.rows[0].id, to]
            );
            await client.query('COMMIT');
            return { ok: true, therapist: rows[0], previous: cur.rows[0].name };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });
}
