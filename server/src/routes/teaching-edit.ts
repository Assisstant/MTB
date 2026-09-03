/**
 * Editing the teaching timetable — the writes `Nastava.html` deliberately does
 * not have.
 *
 * The read-only page and this file are separate on purpose. `Nastava.html`
 * owns no data and can be handed to a teacher or to the director; the editor
 * is a different page, and these are the endpoints it uses. Nothing in the
 * read path writes, and nothing here draws.
 *
 *   PUT    /api/teaching/lesson        one cell: (year, day, period, class)
 *   DELETE /api/teaching/lesson/:id    remove one lesson
 *   POST   /api/teaching/class         add a class
 *   PATCH  /api/teaching/class/:id     rename one
 *   PUT    /api/teaching/class/:id/teachers   who holds it, THIS year
 *   POST   /api/teaching/teacher       add a teacher
 *   PUT    /api/teaching/teacher/:id   name, subject, kind
 *   PUT    /api/teaching/teacher/:id/classes   which classes, THIS year
 *   POST   /api/teaching/copy-year     last year's timetable as this year's start
 *   DELETE /api/teaching/year-lessons  empty a year, on purpose
 *   PUT    /api/teaching/bell/:id      when a period rings
 *
 * There is no DELETE for a class or a teacher, and that is not an oversight —
 * see the header of `lib/teaching-edit.ts`. Archived years point at both rows
 * and must keep reading correctly for ever.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { TEACHING_DAYS, classSortKey } from '../lib/teaching.js';
import { copyYearLessons, putLesson, upsertClass, setClassTeachers, setTeacherClasses, tidy } from '../lib/teaching-edit.js';
import { personName } from '../lib/import-core.js';

/** `school_years.label` is free text; a limit shorter than the column reads as a missing year. */
const YearRef = z.string().min(1).max(64);

const LessonBody = z.object({
    year: YearRef.optional(),
    day: z.string().min(1).max(40),
    ordinal: z.coerce.number().int().min(1).max(12),
    class: z.string().min(1).max(40),
    subject: z.string().max(120).nullable().optional(),
    /** A teacher's NAME, because that is what the page has. null clears it. */
    teacher: z.string().max(200).nullable().optional(),
    /** What the caller believes is in the cell; null means "empty". Omit to skip the check. */
    expected: z.object({
        subject: z.string().max(120).nullable().optional(),
        teacher: z.string().max(200).nullable().optional()
    }).nullable().optional()
});

const ClassBody = z.object({
    label: z.string().min(1).max(40),
    year: YearRef.optional()
});

const ClassTeachersBody = z.object({
    year: YearRef.optional(),
    homeroomTeacherId: z.number().int().positive().nullable(),
    subjectTeacherIds: z.array(z.number().int().positive()).max(100)
});

/** A class a teacher has, and in what sense they have it. */
const ClassRoleEntry = z.object({
    label: z.string().min(1).max(40),
    role: z.enum(['homeroom', 'subject']).optional()
});

const TeacherBody = z.object({
    name: z.string().min(1).max(200),
    kind: z.enum(['odd', 'pred']).optional(),
    subject: z.string().max(120).nullable().optional(),
    year: YearRef.optional(),
    /** The classes they have this year. A teacher can have several. */
    classes: z.array(ClassRoleEntry).max(40).optional()
});

const TeacherPatch = z.object({
    name: z.string().min(1).max(200).optional(),
    subject: z.string().max(120).nullable().optional(),
    kind: z.enum(['odd', 'pred']).optional()
});

const TeacherClassesBody = z.object({
    year: YearRef.optional(),
    classes: z.array(ClassRoleEntry).max(40)
});

const CopyBody = z.object({
    from: YearRef,
    to: YearRef.optional(),
    replace: z.boolean().optional(),
    apply: z.boolean().optional()
});

const BellBody = z.object({
    year: YearRef.optional(),
    label: z.string().max(20).nullable().optional(),
    startsAt: z.string().regex(/^\d{1,2}:\d{2}$/, 'startsAt must be HH:MM').optional(),
    minutes: z.coerce.number().int().min(1).max(240).optional()
});

/**
 * The labels in this list that the school has never heard of.
 *
 * Checked before anything is written, because a list where one name is
 * mistyped must not half-apply — that leaves a teacher holding three of their
 * four classes and nothing on screen to say which one went missing.
 */
async function unknownClasses(client: any, labels: string[]): Promise<string[]> {
    const wanted = Array.from(new Set(labels.map((l) => tidy(l)).filter(Boolean))) as string[];
    if (!wanted.length) return [];
    const { rows } = await client.query(
        'SELECT label FROM school_classes WHERE label = ANY($1::text[])', [wanted]
    );
    const known = new Set(rows.map((r: any) => r.label));
    return wanted.filter((l) => !known.has(l));
}

async function schoolYear(client: any, label?: string) {
    const { rows } = await client.query(
        `SELECT id, label, is_current FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    return rows[0] ?? null;
}

export async function teachingEditRoutes(server: FastifyInstance) {

    /**
     * One cell of the timetable.
     *
     * The class and the teacher are named, not numbered, because that is what
     * the person editing sees — and an unknown name is answered with a 404
     * that says how to fix it rather than being created silently. A typo that
     * quietly invents a class is exactly the sort of thing nobody notices
     * until a grid grows a row.
     */
    server.put('/api/teaching/lesson', async (req, reply) => {
        const body = LessonBody.parse(req.body);
        const day = body.day.trim().toLowerCase();
        if (!TEACHING_DAYS.includes(day)) {
            return reply.code(400).send({ error: `"${body.day}" is not a school day`, days: TEACHING_DAYS });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }

            const cls = await client.query('SELECT id, label FROM school_classes WHERE label = $1', [tidy(body.class)]);
            if (!cls.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such class: ${body.class}`, fix: 'POST /api/teaching/class first' });
            }

            let teacherId: number | null = null;
            const teacherName = body.teacher === undefined ? undefined : tidy(body.teacher);
            if (teacherName) {
                const t = await client.query('SELECT id FROM teachers WHERE lower(btrim(name)) = lower(btrim($1))', [teacherName]);
                if (!t.rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no such teacher: ${body.teacher}`, fix: 'POST /api/teaching/teacher first' });
                }
                teacherId = t.rows[0].id;
            }

            const key = { yearId: year.id, day, ordinal: body.ordinal, classId: cls.rows[0].id };
            const written = await putLesson(
                client, key,
                { subject: body.subject ?? null, teacherId },
                body.expected === undefined
                    ? undefined
                    : body.expected === null
                        ? null
                        : { subject: body.expected.subject ?? null, teacher: body.expected.teacher ?? null }
            );

            if (!written.ok) {
                await client.query('ROLLBACK');
                return reply.code(409).send(
                    written.code === 'clash'
                        ? {
                            error: 'this period already holds more than one lesson for this class',
                            fix: 'delete one of them first',
                            here: written.here
                        }
                        : { error: 'the cell is not what you expected', here: written.here[0] ?? null }
                );
            }

            await client.query('COMMIT');
            return {
                ok: true, action: written.action, year: year.label,
                day, ordinal: body.ordinal, class: cls.rows[0].label,
                lesson: written.lesson
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Remove one lesson.
     *
     * Deleting a LESSON is safe in a way that deleting a class or a teacher is
     * not: the row describes one period of one week of one year, and clearing
     * it says "this class has nothing then", which is a thing a timetable
     * really says.
     */
    server.delete('/api/teaching/lesson/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad lesson id' });
        const { rows } = await pool.query(
            `DELETE FROM lessons l USING school_classes c
             WHERE l.id = $1 AND c.id = l.class_id
             RETURNING l.day, l.ordinal, c.label AS class, l.subject`,
            [id]
        );
        if (!rows.length) return reply.code(404).send({ error: 'no such lesson' });
        return { ok: true, removed: rows[0] };
    });

    server.post('/api/teaching/class', async (req, reply) => {
        const body = ClassBody.parse(req.body);
        const label = tidy(body.label);
        if (!label) return reply.code(400).send({ error: 'a class needs a label' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const row = await upsertClass(client, label);
            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }
            await client.query(
                `INSERT INTO class_years (school_year_id, class_id, active)
                 VALUES ($1, $2, true)
                 ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
                [year.id, row.id]
            );
            await client.query('COMMIT');
            return reply.code(row.created ? 201 : 200).send(row);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Rename a class.
     *
     * This moves every lesson in every year at once, which is right — the row
     * IS the class, and a school that renames IV-б to IV-в means the same
     * children. It is refused when the new name already exists, because
     * merging two classes is not a rename and nothing here can tell them apart
     * afterwards (rule 2).
     */
    server.patch('/api/teaching/class/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad class id' });
        const label = tidy(ClassBody.parse(req.body).label);
        if (!label) return reply.code(400).send({ error: 'a class needs a label' });

        const taken = await pool.query('SELECT id FROM school_classes WHERE label = $1 AND id <> $2', [label, id]);
        if (taken.rows.length) {
            return reply.code(409).send({
                error: `"${label}" already exists`,
                note: 'renaming onto an existing class would merge two classes, which cannot be undone'
            });
        }
        const { rows } = await pool.query(
            `UPDATE school_classes SET label = $2, sort_key = $3 WHERE id = $1 RETURNING id, label`,
            [id, label, classSortKey(label)]
        );
        if (!rows.length) return reply.code(404).send({ error: 'no such class' });
        return { ok: true, ...rows[0] };
    });

    /** Replace the teaching staff for one class in one year, atomically. */
    server.put('/api/teaching/class/:id/teachers', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad class id' });
        const body = ClassTeachersBody.parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const cls = await client.query('SELECT id, label FROM school_classes WHERE id = $1', [id]);
            if (!cls.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'no such class' });
            }
            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }

            const wanted = Array.from(new Set([
                ...(body.homeroomTeacherId === null ? [] : [body.homeroomTeacherId]),
                ...body.subjectTeacherIds
            ]));
            const known = wanted.length
                ? (await client.query('SELECT id FROM teachers WHERE id = ANY($1::int[])', [wanted])).rows.map((row: any) => row.id)
                : [];
            const knownSet = new Set(known);
            const missing = wanted.filter((teacherId) => !knownSet.has(teacherId));
            if (missing.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such teacher id: ${missing.join(', ')}` });
            }

            await client.query(
                `INSERT INTO class_years (school_year_id, class_id, active)
                 VALUES ($1, $2, true)
                 ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
                [year.id, id]
            );
            for (const teacherId of wanted) {
                await client.query(
                    `INSERT INTO teacher_years (school_year_id, teacher_id, active)
                     VALUES ($1, $2, true)
                     ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`,
                    [year.id, teacherId]
                );
            }

            await setClassTeachers(
                client,
                year.id,
                id,
                body.homeroomTeacherId,
                body.subjectTeacherIds
            );
            const { rows } = await client.query(
                `SELECT t.id, t.name, tc.role FROM teacher_classes tc
                 JOIN teachers t ON t.id = tc.teacher_id
                 WHERE tc.school_year_id = $1 AND tc.class_id = $2
                 ORDER BY (tc.role = 'homeroom') DESC, t.name`,
                [year.id, id]
            );
            await client.query('COMMIT');
            return { ok: true, class: cls.rows[0].label, year: year.label, teachers: rows };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    server.post('/api/teaching/teacher', async (req, reply) => {
        const body = TeacherBody.parse(req.body);
        // One spelling for everybody, whichever screen types it — see
        // personName. A name typed in capitals here would otherwise sit
        // beside twenty title-cased ones and read as a different kind of row.
        const name = personName(tidy(body.name));
        if (!name) return reply.code(400).send({ error: 'a teacher needs a name' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const existing = await client.query('SELECT id, name, kind, subject FROM teachers WHERE lower(btrim(name)) = lower(btrim($1))', [name]);
            if (existing.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: `${name} is already in the timetable`, teacher: existing.rows[0] });
            }
            const { rows } = await client.query(
                `INSERT INTO teachers (name, kind, subject) VALUES ($1, $2, $3)
                 RETURNING id, name, kind, subject`,
                [name, body.kind ?? 'pred', tidy(body.subject)]
            );

            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }
            await client.query(
                `INSERT INTO teacher_years (school_year_id, teacher_id, active)
                 VALUES ($1, $2, true)
                 ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`,
                [year.id, rows[0].id]
            );

            let classes = 0;
            if (body.classes && body.classes.length) {
                const missing = await unknownClasses(client, body.classes.map((c) => c.label));
                if (missing.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no such class: ${missing.join(', ')}`, fix: 'POST /api/teaching/class first' });
                }
                classes = (await setTeacherClasses(client, year.id, rows[0].id,
                    body.classes.map((c) => ({ label: c.label, role: c.role ?? 'subject' })))).written;
                await client.query(
                    `INSERT INTO class_years (school_year_id, class_id, active)
                     SELECT $1, id, true FROM school_classes WHERE label = ANY($2::text[])
                     ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
                    [year.id, body.classes.map((c) => c.label)]
                );
            }
            await client.query('COMMIT');
            return reply.code(201).send({ ...rows[0], classes });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * The workbook records a subject teacher's homeroom but never their
     * subject, so somebody has to type it once. Kept as an endpoint rather
     * than a re-import because it is knowledge the spreadsheet does not hold —
     * and a re-import must not wipe it (see teaching-write.ts).
     */
    server.put('/api/teaching/teacher/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad teacher id' });
        const patch = TeacherPatch.parse(req.body);
        if (patch.subject === undefined && patch.name === undefined && patch.kind === undefined) {
            return reply.code(400).send({ error: 'nothing to change' });
        }

        // `subject: null` means clear it, `subject` absent means leave it —
        // COALESCE cannot tell those apart, so the SET list is built instead.
        const sets: string[] = [];
        const args: unknown[] = [id];
        if (patch.subject !== undefined) {
            args.push(patch.subject === null ? null : tidy(patch.subject));
            sets.push(`subject = $${args.length}`);
        }
        if (patch.name !== undefined) {
            args.push(tidy(patch.name));
            sets.push(`name = $${args.length}`);
        }
        if (patch.kind !== undefined) {
            args.push(patch.kind);
            sets.push(`kind = $${args.length}`);
        }
        const { rows } = await pool.query(
            `UPDATE teachers SET ${sets.join(', ')} WHERE id = $1
             RETURNING id, name, kind, subject`,
            args
        );
        if (!rows.length) return reply.code(404).send({ error: 'no such teacher' });
        return rows[0];
    });

    /**
     * Which classes this teacher has, this year.
     *
     * A separate endpoint from the teacher's own fields because it is a
     * separate fact with a separate lifetime: a name is true for as long as the
     * person works here, a class list is true for one year. They used to be one
     * column on the teacher and that is precisely what made an archived
     * timetable name the wrong person (migration 016).
     *
     * The list is REPLACED. See `setTeacherClasses` for why that is right here
     * and wrong for a schedule cell.
     */
    server.put('/api/teaching/teacher/:id/classes', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad teacher id' });
        const body = TeacherClassesBody.parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const teacher = await client.query('SELECT id, name FROM teachers WHERE id = $1', [id]);
            if (!teacher.rows.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'no such teacher' });
            }
            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }
            // Every label is checked BEFORE anything is written: a list where
            // one name is mistyped must not half-apply and leave the teacher
            // with three of their four classes.
            const missing = await unknownClasses(client, body.classes.map((c) => c.label));
            if (missing.length) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such class: ${missing.join(', ')}`, fix: 'POST /api/teaching/class first' });
            }

            await setTeacherClasses(client, year.id, id,
                body.classes.map((c) => ({ label: c.label, role: c.role ?? 'subject' })));
            await client.query(
                `INSERT INTO teacher_years (school_year_id, teacher_id, active)
                 VALUES ($1, $2, true)
                 ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`,
                [year.id, id]
            );
            if (body.classes.length) {
                await client.query(
                    `INSERT INTO class_years (school_year_id, class_id, active)
                     SELECT $1, id, true FROM school_classes WHERE label = ANY($2::text[])
                     ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
                    [year.id, body.classes.map((c) => c.label)]
                );
            }

            const { rows } = await client.query(
                `SELECT c.label, tc.role FROM teacher_classes tc
                 JOIN school_classes c ON c.id = tc.class_id
                 WHERE tc.school_year_id = $1 AND tc.teacher_id = $2
                 ORDER BY (tc.role = 'homeroom') DESC, c.sort_key, c.label`,
                [year.id, id]
            );
            await client.query('COMMIT');
            return { ok: true, teacher: teacher.rows[0].name, year: year.label, classes: rows };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Last year's timetable as this year's starting point.
     *
     * Dry run unless `apply: true`, and it refuses to write over a year that
     * already has lessons unless `replace: true` as well — two separate words
     * for two separate decisions, because "copy last year" and "throw this
     * year away" are not the same intention and one button should not mean
     * both.
     */
    server.post('/api/teaching/copy-year', async (req, reply) => {
        const body = CopyBody.parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const from = await schoolYear(client, body.from);
            const to = await schoolYear(client, body.to);
            if (!from) { await client.query('ROLLBACK'); return reply.code(404).send({ error: `no such school year: ${body.from}` }); }
            if (!to)   { await client.query('ROLLBACK'); return reply.code(404).send({ error: `no such school year: ${body.to ?? '(current)'}` }); }

            const result = await copyYearLessons(client, from, to, { replace: body.replace, apply: body.apply });
            if (result.problems.length) {
                await client.query('ROLLBACK');
                return reply.code(409).send(result);
            }
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Empty a year's timetable, on purpose.
     *
     * September starts from nothing when the mapping of teachers to classes
     * has changed enough that last year's grid is worse than a blank one, and
     * 451 individual deletions is not a thing anybody will do. It is one
     * statement, so it is one intention, stated once.
     *
     * `expect` is the guard, and it is not ceremony: the caller says how many
     * lessons it believes it is throwing away, and a different number means the
     * screen was drawn before somebody else imported a timetable. Refusing is
     * the only answer that cannot destroy work nobody has seen yet.
     */
    server.delete('/api/teaching/year-lessons', async (req, reply) => {
        const body = z.object({ year: YearRef.optional(), expect: z.coerce.number().int().min(0) }).parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const year = await schoolYear(client, body.year);
            if (!year) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: `no such school year: ${body.year ?? '(current)'}` });
            }
            // The rows are locked, not counted, because `count(*)` and
            // `FOR UPDATE` cannot appear in the same statement — and a count
            // taken without the lock is a number that can change before the
            // DELETE runs, which is the whole thing `expect` is guarding.
            const { rows } = await client.query(
                'SELECT id FROM lessons WHERE school_year_id = $1 FOR UPDATE', [year.id]
            );
            if (rows.length !== body.expect) {
                await client.query('ROLLBACK');
                return reply.code(409).send({
                    error: `${year.label} holds ${rows.length} lessons, not ${body.expect}`,
                    here: rows.length,
                    fix: 'reload and look at what is there now'
                });
            }
            const gone = await client.query('DELETE FROM lessons WHERE school_year_id = $1', [year.id]);
            await client.query('COMMIT');
            return { ok: true, year: year.label, removed: gone.rowCount ?? 0 };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * When a period rings.
     *
     * The base row identifies which bell is being edited. Its effective value
     * is stored as an override for one school year, so an archived crossing
     * continues to use the times that actually rang in that year.
     */
    server.put('/api/teaching/bell/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad bell id' });
        const body = BellBody.parse(req.body);
        if (body.label === undefined && body.startsAt === undefined && body.minutes === undefined) {
            return reply.code(400).send({ error: 'nothing to change' });
        }
        const year = await schoolYear(pool, body.year);
        if (!year) return reply.code(404).send({ error: `no such school year: ${body.year}` });

        const effective = (await pool.query(
            `SELECT b.schedule, b.ordinal,
                    coalesce(o.label, b.label) AS label,
                    to_char(coalesce(o.starts_at, b.starts_at), 'HH24:MI') AS starts_at,
                    coalesce(o.minutes, b.minutes) AS minutes
             FROM bell_periods b
             LEFT JOIN bell_period_overrides o
               ON o.bell_period_id = b.id AND o.school_year_id = $2
             WHERE b.id = $1`,
            [id, year.id]
        )).rows[0];
        if (!effective) return reply.code(404).send({ error: 'no such bell period' });

        let startsAt = effective.starts_at as string;
        if (body.startsAt !== undefined) {
            const [h, m] = body.startsAt.split(':').map(Number);
            if (h > 23 || m > 59) return reply.code(400).send({ error: `${body.startsAt} is not a time of day` });
            startsAt = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        const label = body.label === undefined ? effective.label : tidy(body.label);
        const duration = body.minutes === undefined ? Number(effective.minutes) : body.minutes;

        const { rows } = await pool.query(
            `INSERT INTO bell_period_overrides
                    (school_year_id, bell_period_id, label, starts_at, minutes)
             VALUES ($1, $2, $3, $4::time, $5)
             ON CONFLICT (school_year_id, bell_period_id) DO UPDATE
                 SET label = EXCLUDED.label,
                     starts_at = EXCLUDED.starts_at,
                     minutes = EXCLUDED.minutes
             RETURNING label, to_char(starts_at, 'HH24:MI') AS "startsAt", minutes`,
            [year.id, id, label, startsAt, duration]
        );
        return {
            ok: true,
            id,
            year: year.label,
            schedule: effective.schedule,
            ordinal: effective.ordinal,
            ...rows[0]
        };
    });
}
