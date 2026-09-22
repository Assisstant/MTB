import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { asText } from '../lib/import-core.js';
import { ORDER_LISTS, arrangementAvailable } from '../lib/roster-order.js';

const Entity = z.enum(['student', 'teacher', 'therapist', 'class']);
const Member = z.object({
    id: z.union([z.string().min(1).max(80), z.number().int().positive()]),
    grade: z.string().max(40).nullable().optional(),
    kind: z.enum(['internal', 'boarding', 'external']).optional()
});
/**
 * Which list is being arranged, and how each one names its members.
 *
 * A pupil is keyed by `students.public_id` and the other three by their
 * numeric id, because that is what `/api/roster` already hands the screen —
 * no second identity rule, and nothing here has to resolve a name.
 */
const OrderBody = z.object({
    year: z.string().min(1).max(64),
    list: z.enum(ORDER_LISTS),
    order: z.array(z.string().trim().min(1).max(80)).max(1000)
}).strict();
const MembershipBody = z.object({
    year: z.string().min(1).max(64),
    entity: Entity,
    active: z.boolean(),
    members: z.array(Member).min(1).max(500)
});

async function setStudent(
    client: any,
    yearId: number,
    member: z.infer<typeof Member>,
    active: boolean
) {
    if (typeof member.id !== 'string') throw new Error('student membership needs a public id');
    const { rows } = await client.query(
        'SELECT id, name, active FROM students WHERE public_id = $1', [member.id]
    );
    if (!rows.length) return { missing: member.id };
    if (active && !rows[0].active) return { archived: member.id, name: rows[0].name };

    if (!active) {
        const result = await client.query(
            `UPDATE student_enrollments SET active = false
             WHERE student_id = $1 AND school_year_id = $2 AND active`,
            [rows[0].id, yearId]
        );
        return { changed: result.rowCount ?? 0 };
    }

    const previous = (await client.query(
        `SELECT e.grade, e.kind FROM student_enrollments e
         JOIN school_years y ON y.id = e.school_year_id
         WHERE e.student_id = $1
         ORDER BY (e.school_year_id = $2) DESC, y.starts_on DESC, y.id DESC LIMIT 1`,
        [rows[0].id, yearId]
    )).rows[0] ?? {};
    const kind = member.kind ?? previous.kind ?? 'internal';
    // External describes enrolment, not whether the pupil attends a local
    // preparatory group or modified teaching. Only an explicit null clears it.
    const grade = member.grade !== undefined ? asText(member.grade) : asText(previous.grade);
    const result = await client.query(
        `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (student_id, school_year_id) DO UPDATE
         SET grade = EXCLUDED.grade, kind = EXCLUDED.kind, active = true`,
        [rows[0].id, yearId, grade, kind]
    );
    if (grade) {
        await client.query(
            `INSERT INTO class_years (school_year_id, class_id, active)
             SELECT $1, id, true FROM school_classes WHERE label = $2
             ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
            [yearId, grade]
        );
    }
    return { changed: result.rowCount ?? 0 };
}

async function setNumbered(
    client: any,
    yearId: number,
    entity: Exclude<z.infer<typeof Entity>, 'student'>,
    member: z.infer<typeof Member>,
    active: boolean
) {
    if (typeof member.id !== 'number') throw new Error(`${entity} membership needs a numeric id`);
    const config = {
        teacher: { directory: 'teachers', membership: 'teacher_years', key: 'teacher_id' },
        therapist: { directory: 'therapists', membership: 'therapist_years', key: 'therapist_id' },
        class: { directory: 'school_classes', membership: 'class_years', key: 'class_id' }
    }[entity];
    const exists = await client.query(`SELECT id FROM ${config.directory} WHERE id = $1`, [member.id]);
    if (!exists.rows.length) return { missing: member.id };
    const result = await client.query(
        `INSERT INTO ${config.membership} (school_year_id, ${config.key}, active)
         VALUES ($1, $2, $3)
         ON CONFLICT (school_year_id, ${config.key}) DO UPDATE SET active = EXCLUDED.active`,
        [yearId, member.id, active]
    );
    return { changed: result.rowCount ?? 0 };
}

export async function annualRosterRoutes(server: FastifyInstance) {
    /**
     * Select permanent directory entries for one school year, atomically.
     * `active=false` removes them only from that year's working lists; no
     * person, lesson, dossier or archived enrolment is deleted.
     */
    server.put('/api/roster/memberships', async (req, reply) => {
        const body = MembershipBody.parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const year = (await client.query(
                'SELECT id, label FROM school_years WHERE label = $1 FOR UPDATE', [body.year]
            )).rows[0];
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year}` });
            }

            let changed = 0;
            const missing: Array<string | number> = [];
            const archived: Array<{ id: string; name: string }> = [];
            for (const member of body.members) {
                const result = body.entity === 'student'
                    ? await setStudent(client, year.id, member, body.active)
                    : await setNumbered(client, year.id, body.entity, member, body.active);
                changed += result.changed ?? 0;
                if (result.missing !== undefined) missing.push(result.missing);
                if ('archived' in result && result.archived !== undefined) {
                    archived.push({ id: result.archived, name: result.name! });
                }
            }
            if (missing.length || archived.length) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: missing.length ? 'some directory entries no longer exist' : 'archived students cannot be re-enrolled',
                    missing,
                    archived
                });
            }

            await client.query('COMMIT');
            return { ok: true, year: year.label, entity: body.entity, active: body.active, changed };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * The order one year's list is READ in. Display only.
     *
     * WHOLE LIST, NOT ONE ROW, and that is the opposite of a schedule cell on
     * purpose: moving a row changes at least two places, one person arranges
     * one list on one screen, and there is no `expected` for "the order" that
     * would mean anything. What a stale tab can do is bounded — it can place
     * the members it knows about and leave a newcomer unplaced, which the
     * reader then sorts last and a person moves once. It cannot remove
     * anybody, add anybody, change a name or touch a membership: this table
     * holds nothing but a position.
     *
     * Keys are NOT checked against the year's membership, deliberately. That
     * check would be a second copy of the four filters in `/api/roster`, and
     * the two would drift; a key that names nobody costs one unused row and
     * is gone the next time the list is arranged.
     */
    server.put('/api/roster/order', async (req, reply) => {
        const parsed = OrderBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid order payload' });
        const body = parsed.data;
        if (new Set(body.order).size !== body.order.length) {
            return reply.code(400).send({ error: 'the submitted order repeats a member' });
        }
        // An installation held at an older migration reads every list in the
        // reader's own order and cannot store an arrangement at all. Say that,
        // rather than answering 500 with a missing-relation message.
        if (!await arrangementAvailable(pool)) {
            return reply.code(503).send({
                error: 'Оваа база сè уште нема поддршка за редослед на списоците; потребна е надградба.',
                needsMigration: '038_roster_order.sql'
            });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const year = (await client.query(
                'SELECT id, label FROM school_years WHERE label = $1 FOR UPDATE', [body.year]
            )).rows[0];
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year}` });
            }
            await client.query(
                'DELETE FROM roster_order WHERE school_year_id = $1 AND list = $2', [year.id, body.list]
            );
            if (body.order.length) {
                await client.query(
                    `INSERT INTO roster_order (school_year_id, list, member_key, position)
                     SELECT $1, $2, member.key, member.ordinality - 1
                     FROM unnest($3::text[]) WITH ORDINALITY AS member(key, ordinality)`,
                    [year.id, body.list, body.order]
                );
            }
            await client.query('COMMIT');
            return { ok: true, year: year.label, list: body.list, placed: body.order.length };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });
}
