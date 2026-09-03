/**
 * Removing a row that should never have existed — and nothing else.
 *
 * „Бришење" means two different things, and only one of them belongs here:
 *
 *   1. **Not on this year's list.** A child who moved schools, a therapist who
 *      left in June, a ninth-grader who has finished. That is
 *      `PUT /api/roster/memberships` in `annual-roster.ts` — it sets
 *      `active = false` on the year's membership and removes nobody. This is
 *      the common case by a wide margin and it is NOT in this file.
 *   2. **A name typed with a slip of the hand five minutes ago.** Nothing
 *      points at it and it has never been on any other year's list, so the row
 *      can go. That is all this file does.
 *
 * The distinction is not pedantry. `lessons` CASCADES on `school_classes` and
 * `schedule_slots` CASCADES on `therapists`, so an unguarded DELETE on either
 * takes a year of timetable or a week of terms with it **and answers 200 while
 * doing so**.
 *
 * A YEAR IS REQUIRED, and it is the sharpest guard here. Each year's lists are
 * entered from the school's годишна програма, so a typo belongs to the year
 * being entered and to no other. A row that is on ANY other year's list is
 * therefore not a typo — it is somebody who was on a list — and the answer is
 * 409 naming those years, whether or not a lesson was ever recorded for them.
 * Without this the sweep below would quietly take an archived membership with
 * it, which is the one fact migration 018 exists to keep.
 *
 * WHAT MAY BE SWEPT, AND WHY ONLY THAT. Creating somebody through the API also
 * puts them on the chosen year's list — `POST /api/students` enrols, and the
 * membership endpoint writes a `*_years` row. Those are the ACT OF ADDING, so
 * refusing on them would make this useless in the exact case it exists for.
 * Everything else records what somebody DID, and records refuse.
 *
 *   swept:   this year's student_enrollments · teacher_years · therapist_years
 *            · class_years — and only this year's
 *   refuse:  every other table that references the row
 *
 * A student refuses on two more things that are not references at all: an
 * archived row (`active = false`) belongs to S-Dnevnik, which owns who is
 * enrolled (rule 5), and an `sdnevnik_id` means the diary already knows them,
 * so they were never a slip of the hand here.
 *
 * A class refuses on children recorded in it, which is NOT a foreign key:
 * `student_enrollments.grade` and `students.grade` hold the class LABEL as
 * plain text. Both are counted, through `normalizeClassLabel` — the single
 * copy of "these two labels mean the same room" — because `IV-а` and `iv / a`
 * are the same class to a person and different strings to `=`.
 *
 * TWO LOCKS, AND EACH COVERS WHAT THE OTHER CANNOT.
 *
 *   `SELECT … FOR UPDATE` on the directory row makes count-then-delete atomic
 *   for everything that IS a foreign key: PostgreSQL takes `FOR KEY SHARE` on
 *   a parent when a row referencing it is inserted, and that conflicts. So a
 *   term booked while this endpoint is counting waits, and is then counted.
 *
 *   It does nothing for the class label, because there is no foreign key to
 *   take a lock on: an `UPDATE student_enrollments SET grade = 'IV-а'` can
 *   land between the count and the delete and neither statement blocks the
 *   other. So the class path takes `LOCK TABLE … IN SHARE MODE` on both label
 *   holders instead, which conflicts with the `ROW EXCLUSIVE` every writer
 *   takes automatically — no cooperation required from the write paths, which
 *   is the point: an advisory lock that every future write path must remember
 *   to take is a rule that will be forgotten exactly once.
 *
 *   **The table lock is taken FIRST, before the row lock, and the order is
 *   load-bearing.** `annual-roster.ts` writes `student_enrollments` and then
 *   touches `school_classes` (it activates the class named by a grade); taking
 *   the row lock first here would make the two transactions wait on each other
 *   and PostgreSQL would abort one as a deadlock.
 *
 * The right long-term answer to the label is a `class_id` on the enrolment.
 * It is not done here because `grade` is what every read path uses, so a
 * second column would be a second owner of "which class is this child in"
 * (rule 5) — the migration has to move the readers too, and that is a change
 * of its own.
 *
 * `test/roster-purge.e2e.ts` asserts the blocker list against `pg_constraint`
 * itself — including one level below the swept tables — so a migration that
 * adds a table pointing at any of this fails the suite instead of silently
 * opening a hole.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { normalizeClassLabel } from '../lib/crossing.js';

interface PurgeSpec {
    /** The directory table the row lives in. */
    table: 'students' | 'teachers' | 'therapists' | 'school_classes';
    /** What to call it in the answer. */
    what: string;
    /**
     * Both maps are table -> the column that references this row, and together
     * they must name EVERY child in the schema. Writing the column out rather
     * than assuming one name per parent is what lets the suite compare these
     * lists against `pg_constraint` as they stand, instead of against a rule
     * about how columns are usually called.
     */
    /** Membership rows created by the act of adding, for THIS year only. */
    sweep: Record<string, string>;
    /** Any row here refuses the delete. */
    refuse: Record<string, string>;
    /** Advice when it is refused: what to do instead. */
    instead: string;
}

/**
 * Every table that references each directory row, split into the two kinds.
 *
 * Written out rather than derived at runtime on purpose: what counts as "the
 * act of adding" is a judgement, and a judgement belongs in source somebody can
 * argue with. The SUITE derives the list from the live schema and fails if this
 * one has drifted, which is the part a machine is better at.
 */
export const PURGE: Record<string, PurgeSpec> = {
    student: {
        table: 'students',
        what: 'student',
        sweep: { student_enrollments: 'student_id' },
        refuse: {
            schedule_slots: 'student_id',
            attendance: 'student_id',
            student_plan_progress: 'student_id',
            student_records: 'student_id',
            assessments: 'student_id',
            triage_tests: 'student_id',
            audiograms: 'student_id',
            diary_schedule: 'student_id',
            therapist_students: 'student_id'
        },
        instead: 'a student with any history is archived in S-Dnevnik, never removed'
    },
    teacher: {
        table: 'teachers',
        what: 'teacher',
        sweep: { teacher_years: 'teacher_id' },
        refuse: {
            lessons: 'teacher_id',
            teacher_classes: 'teacher_id'
        },
        instead: 'take them off the year with PUT /api/roster/memberships instead'
    },
    therapist: {
        table: 'therapists',
        what: 'therapist',
        sweep: { therapist_years: 'therapist_id' },
        refuse: {
            schedule_slots: 'therapist_id',
            therapist_students: 'therapist_id'
        },
        instead: 'take them off the year with PUT /api/roster/memberships instead'
    },
    class: {
        table: 'school_classes',
        what: 'class',
        sweep: { class_years: 'class_id' },
        refuse: {
            lessons: 'class_id',
            teacher_classes: 'class_id'
        },
        instead: 'take it off the year with PUT /api/roster/memberships instead'
    }
};

/**
 * The two tables that hold a class as plain TEXT, and are therefore invisible
 * to every foreign key in the schema. `students.grade` is still written by
 * `roster-write.ts`, so counting only the enrolment would miss half of it.
 */
/**
 * THE ORDER IS THE LOCK ORDER, and it is not alphabetical by accident.
 *
 * Every writer that touches both takes `students` first and
 * `student_enrollments` second — `POST /api/students` inserts the person and
 * then enrols them, and so does the projection. Locking them the other way
 * round here would make this transaction and that one wait on each other, and
 * PostgreSQL would abort one as a deadlock. Add a table to this list only
 * after checking where the writers take it.
 */
const LABEL_HOLDERS = [
    { table: 'students', key: 'students_naming_it' },
    { table: 'student_enrollments', key: 'enrolments_naming_it' }
] as const;

/** Both are required: neither a year nor an identity may be assumed here. */
const PurgeQuery = z.object({
    year: z.string().min(1).max(64),
    expected: z.string().min(1).max(200)
});

/** Only the counts that are not zero — the answer is a sentence, not a form. */
function held(row: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(row)) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
}

/**
 * Does the caller mean this row?
 *
 * A class is compared through `normalizeClassLabel` for the same reason the
 * blockers are: `IV-а` and `IV-a` are one room. A person's name is compared
 * on trimmed case, which is how every other name match in this API works.
 */
function meansTheSameRow(spec: PurgeSpec, expected: string, actual: string): boolean {
    if (spec.table === 'school_classes') {
        return normalizeClassLabel(expected) === normalizeClassLabel(actual);
    }
    return expected.trim().toLocaleLowerCase('mk') === String(actual ?? '').trim().toLocaleLowerCase('mk');
}

/** How many rows in each label holder name this class, however it is spelt. */
async function namedBy(client: any, label: string): Promise<Record<string, number>> {
    const wanted = normalizeClassLabel(label);
    const out: Record<string, number> = {};
    for (const holder of LABEL_HOLDERS) {
        const { rows } = await client.query(
            `SELECT grade, count(*)::int AS n FROM ${holder.table}
             WHERE grade IS NOT NULL AND btrim(grade) <> '' GROUP BY grade`
        );
        const n = rows
            .filter((r: any) => normalizeClassLabel(r.grade) === wanted)
            .reduce((sum: number, r: any) => sum + r.n, 0);
        if (n > 0) out[holder.key] = n;
    }
    return out;
}

async function purge(
    reply: any,
    spec: PurgeSpec,
    find: { where: string; value: string | number },
    query: unknown
) {
    const q = PurgeQuery.safeParse(query);
    if (!q.success) {
        return reply.code(400).send({
            error: 'both ?year= and ?expected= are required',
            why: 'a delete must name the year it belongs to and the row the caller believes it is removing'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Rather than wait for ever behind somebody's open transaction. A
        // refusal the caller can retry is a better answer than a hung request.
        await client.query("SET LOCAL lock_timeout = '3s'");

        // BEFORE the row lock — see the header. The class is the only kind
        // whose blockers are plain text, so it is the only one that needs it.
        if (spec.table === 'school_classes') {
            await client.query(
                `LOCK TABLE ${LABEL_HOLDERS.map((h) => h.table).join(', ')} IN SHARE MODE`
            );
        }

        const year = (await client.query(
            'SELECT id, label FROM school_years WHERE label = $1', [q.data.year]
        )).rows[0];
        if (!year) {
            await client.query('ROLLBACK');
            return reply.code(404).send({ error: `no such school year: ${q.data.year}` });
        }

        // FOR UPDATE, and it is doing real work: inserting a row that
        // references this one takes FOR KEY SHARE on it, which conflicts. So
        // nothing that IS a foreign key can become a blocker between the count
        // below and the delete.
        const { rows } = await client.query(
            `SELECT * FROM ${spec.table} WHERE ${find.where} = $1 FOR UPDATE`, [find.value]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return reply.code(404).send({ error: `no such ${spec.what}` });
        }
        const row = rows[0];
        const name: string = row.name ?? row.label;

        // Two screens, one row: somebody may have corrected the spelling since
        // this page drew its list, and correcting a name is exactly what turns
        // a typo into a person. Same row-level check as everywhere else.
        if (!meansTheSameRow(spec, q.data.expected, name)) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
                error: `this ${spec.what} is now "${name}", not "${q.data.expected}"`,
                expected: q.data.expected,
                actual: name,
                instead: 'reload the list and look again — a corrected name is not a typo'
            });
        }

        // Was this row ever on another year's list? Then it is not a typo, and
        // the sweep below would take an archived membership with it.
        const membership = Object.entries(spec.sweep)[0];
        const elsewhere = (await client.query(
            `SELECT y.label FROM ${membership[0]} m
             JOIN school_years y ON y.id = m.school_year_id
             WHERE m.${membership[1]} = $1 AND m.school_year_id <> $2
             ORDER BY y.starts_on`,
            [row.id, year.id]
        )).rows.map((r: any) => r.label);
        if (elsewhere.length) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
                error: `${name} is on the list for ${elsewhere.join(', ')} and is not a typo`,
                years: elsewhere,
                instead: spec.instead
            });
        }

        // Not references, and not this screen's to decide. An archived student
        // belongs to S-Dnevnik's archive; one the diary already knows was
        // never typed here by mistake.
        if (spec.table === 'students') {
            if (row.active === false) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: `${name} is archived, and the archive belongs to S-Dnevnik`,
                    instead: 'restore or leave them there — this screen does not decide enrolment'
                });
            }
            if (row.sdnevnik_id !== null && row.sdnevnik_id !== undefined) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: `${name} is linked to a diary in S-Dnevnik`,
                    instead: 'a child the diary knows is archived there, never removed here'
                });
            }
        }

        const counts = Object.entries(spec.refuse).map(
            ([table, column]) => `(SELECT count(*) FROM ${table} WHERE ${column} = $1) AS ${table}`
        );
        const { rows: measured } = await client.query(`SELECT ${counts.join(', ')}`, [row.id]);
        const blocking = {
            ...held(measured[0]),
            ...(spec.table === 'school_classes' ? await namedBy(client, row.label) : {})
        };

        if (Object.keys(blocking).length) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
                error: `${name} is referenced by records and cannot be removed`,
                holding: blocking,
                instead: spec.instead
            });
        }

        // Scoped to the year on purpose. The check above has already proven
        // there is no other one, so this changes nothing today — it is here so
        // that relaxing that check cannot silently start eating archives.
        for (const [table, column] of Object.entries(spec.sweep)) {
            await client.query(
                `DELETE FROM ${table} WHERE ${column} = $1 AND school_year_id = $2`, [row.id, year.id]
            );
        }
        await client.query(`DELETE FROM ${spec.table} WHERE id = $1`, [row.id]);
        await client.query('COMMIT');
        return { ok: true, removed: name, year: year.label, swept: Object.keys(spec.sweep) };
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        // 55P03 lock_not_available, 40P01 deadlock. Somebody is editing the
        // lists right now; that is a "try again", not a fault in the request.
        if (err?.code === '55P03' || err?.code === '40P01') {
            return reply.code(503).send({
                error: 'the lists are being edited right now',
                instead: 'try again in a moment'
            });
        }
        throw err;
    } finally {
        client.release();
    }
}

const numericId = (req: any) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
};

export async function rosterPurgeRoutes(server: FastifyInstance) {

    server.delete('/api/roster/student/:publicId', async (req, reply) => {
        const publicId = String((req.params as any).publicId || '').trim();
        if (!publicId) return reply.code(400).send({ error: 'bad student id' });
        return purge(reply, PURGE.student, { where: 'public_id', value: publicId }, req.query);
    });

    server.delete('/api/roster/teacher/:id', async (req, reply) => {
        const id = numericId(req);
        if (id == null) return reply.code(400).send({ error: 'bad teacher id' });
        return purge(reply, PURGE.teacher, { where: 'id', value: id }, req.query);
    });

    server.delete('/api/roster/therapist/:id', async (req, reply) => {
        const id = numericId(req);
        if (id == null) return reply.code(400).send({ error: 'bad therapist id' });
        return purge(reply, PURGE.therapist, { where: 'id', value: id }, req.query);
    });

    server.delete('/api/roster/class/:id', async (req, reply) => {
        const id = numericId(req);
        if (id == null) return reply.code(400).send({ error: 'bad class id' });
        return purge(reply, PURGE.class, { where: 'id', value: id }, req.query);
    });
}
