/**
 * Removing a row that should never have existed — and nothing else.
 *
 * Run the server first (`npm run dev`), then `npm run test:purge`.
 *
 * Everything here happens inside two school years of its own, created at the
 * start and dropped at the end, so the suite can be run against the machine
 * holding the real school without touching a lesson of it. The names are
 * invented and the classes are numbered beyond the school's own (rule 1).
 *
 * What is being proven, in order of how badly it fails when it is wrong:
 *
 *   1. a row that was on ANY other year's list is not a typo, whatever else
 *      is or is not recorded against it — that membership is the only trace
 *      migration 018 keeps of somebody who was there;
 *   2. anything that RECORDS something refuses — asserted against
 *      `pg_constraint` rather than against a list somebody remembered to
 *      update, and one level BELOW the swept tables too, because the sweep is
 *      itself a delete;
 *   3. the caller has to name the row it means, so a name corrected on one
 *      screen is not deleted by another that still shows the misspelling;
 *   4. a class is held by the children recorded in it under ANY spelling, in
 *      both places a class label is kept as plain text;
 *   5. and neither a term booked nor a class typed in WHILE the endpoint is
 *      counting is lost. Those two need two connections each, and they are
 *      the only assertions here that can tell a locked version from an
 *      unlocked one — single-threaded, both behave identically.
 */

import pg from 'pg';
import 'dotenv/config';
import { PURGE } from '../src/routes/roster-purge.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');

const TAG = 'roster-purge-test';
const YEAR = '1912/1913-purge';
const PRIOR = '1911/1912-purge';
const CLASS = 'XI-п';                 // beyond the school's own I–IX
const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (label: string, condition: boolean, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const same = (label: string, actual: unknown, expected: unknown) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any };
};
const count = async (table: string, where: string, args: unknown[]) =>
    Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, args))[0].n);

// Anything this suite may have left behind, in an order that does not depend
// on cascades working. Attendance has no school year of its own, so dropping
// the years would leave its rows pointing at a student we are about to remove.
async function cleanup() {
    await q(`DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE public_id LIKE $1)`, [`${TAG}%`]);
    await q('DELETE FROM school_years WHERE label IN ($1, $2)', [YEAR, PRIOR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM teachers WHERE name LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM school_classes WHERE label LIKE $1', [`${CLASS}%`]);
}

type Fixture = {
    student: number; teacher: number; therapist: number; class: number;
    publicId: string; label: string; name: Record<string, string>;
};

/** One directory row of each kind, on the year's list and referenced by nothing. */
async function fresh(yearId: number, suffix: string): Promise<Fixture> {
    const label = `${CLASS}${suffix}`;
    const name = {
        student: `${TAG} student ${suffix}`,
        teacher: `${TAG} teacher ${suffix}`,
        therapist: `${TAG} therapist ${suffix}`,
        class: label
    };
    const [student] = await q(
        `INSERT INTO students (public_id, name) VALUES ($1, $2) RETURNING id`,
        [`${TAG}-${suffix}`, name.student]);
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [name.teacher]);
    const [therapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name.therapist]);
    const [cls] = await q(
        `INSERT INTO school_classes (label, sort_key) VALUES ($1, $1) RETURNING id`, [label]);

    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, NULL, 'external', true)`, [student.id, yearId]);
    await q('INSERT INTO teacher_years (school_year_id, teacher_id) VALUES ($1, $2)', [yearId, teacher.id]);
    await q('INSERT INTO therapist_years (school_year_id, therapist_id) VALUES ($1, $2)', [yearId, therapist.id]);
    await q('INSERT INTO class_years (school_year_id, class_id) VALUES ($1, $2)', [yearId, cls.id]);
    return { student: student.id, teacher: teacher.id, therapist: therapist.id, class: cls.id,
             publicId: `${TAG}-${suffix}`, label, name };
}

const ENTITIES = ['student', 'teacher', 'therapist', 'class'] as const;

const address = (
    entity: typeof ENTITIES[number],
    row: Fixture,
    over: { year?: string | null; expected?: string | null } = {}
) => {
    const base = entity === 'student'
        ? `/api/roster/student/${encodeURIComponent(row.publicId)}`
        : `/api/roster/${entity}/${(row as any)[entity]}`;
    const year = over.year === undefined ? YEAR : over.year;
    const expected = over.expected === undefined ? row.name[entity] : over.expected;
    const parts: string[] = [];
    if (year !== null) parts.push(`year=${encodeURIComponent(year)}`);
    if (expected !== null) parts.push(`expected=${encodeURIComponent(expected)}`);
    return parts.length ? `${base}?${parts.join('&')}` : base;
};

async function run() {
    await cleanup();
    const [prior] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1911-09-01', '1912-08-31', false) RETURNING id`, [PRIOR]);
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1912-09-01', '1913-08-31', false) RETURNING id`, [YEAR]);
    console.log(`purge — two school years of its own (${PRIOR}, ${YEAR})\n`);

    // ---------------------------------------------------------------- drift
    // The split in the source is a judgement about which children are "the act
    // of adding"; that a judgement was made about EVERY child is a fact, and
    // this is where the fact is checked. A migration that adds a table
    // pointing at any of this fails here instead of quietly opening a hole in
    // an endpoint that deletes people.
    console.log('the blocker list is the live schema, not a memory of it');
    const parents = Object.fromEntries(Object.values(PURGE).map((s) => [s.table, s]));
    const swept = Object.values(PURGE).flatMap((s) => Object.keys(s.sweep));
    const referencing = async (tables: string[]) => await q(
        `SELECT c.confrelid::regclass::text AS parent,
                c.conrelid::regclass::text  AS child,
                a.attname                   AS col
         FROM pg_constraint c
         JOIN unnest(c.conkey) k(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.contype = 'f' AND c.confrelid::regclass::text = ANY($1)`,
        [tables]
    );

    const children = await referencing(Object.keys(parents));
    check('the four directory tables are all referenced by something', children.length > 0);
    for (const [table, spec] of Object.entries(parents)) {
        const schema = children.filter((r) => r.parent === table)
            .map((r) => `${r.child}.${r.col}`).sort();
        const declared = Object.entries({ ...spec.sweep, ...spec.refuse })
            .map(([child, col]) => `${child}.${col}`).sort();
        same(`${table}: every child is either swept or refuses`, declared, schema);
    }
    // A table can be swept OR refuse, never both — the count runs before the
    // sweep, so a table in both lists would be counted as a blocker and could
    // never be reached.
    for (const [entity, spec] of Object.entries(PURGE)) {
        same(`${entity}: no table is both swept and refused`,
            Object.keys(spec.sweep).filter((t) => t in spec.refuse), []);
    }
    // One level deeper, because the sweep is itself a DELETE. A table that
    // references an enrolment or a membership would be cascaded away by it,
    // and the direct check above cannot see that at all. Nothing references
    // them today; the day something does, this is the conversation to have
    // rather than a silent extra deletion.
    const grandchildren = await referencing(swept);
    same('and nothing at all references the swept tables',
        grandchildren.map((r) => `${r.parent} <- ${r.child}.${r.col}`), []);

    // --------------------------------------------------------- the address
    console.log('\na delete has to say which year, and which row it thinks it is');
    const asked = await fresh(year.id, 'а');
    same('no year at all is a 400', (await api('DELETE', address('teacher', asked, { year: null }))).status, 400);
    same('no expected name is a 400', (await api('DELETE', address('teacher', asked, { expected: null }))).status, 400);
    same('a year that does not exist is a 404',
        (await api('DELETE', address('teacher', asked, { year: '1800/1801-nope' }))).status, 404);
    let result = await api('DELETE', address('teacher', asked, { expected: `${TAG} teacher б` }));
    check('a name that is not the row is a 409', result.status === 409, JSON.stringify(result.body));
    same('and it says what the row really is', result.body.actual, asked.name.teacher);
    same('the row it would not delete is still there', await count('teachers', 'id = $1', [asked.teacher]), 1);
    // The class comparison goes through normalizeClassLabel, the one copy of
    // "these two labels are the same room" — so a caller that spells it with a
    // Cyrillic Х and a spaced slash still addresses the row it can see.
    result = await api('DELETE', address('class', asked, { expected: 'ХI / па' }));
    check('a differently spelt class label still names the same class',
        result.status === 200, JSON.stringify(result.body));

    // ------------------------------------------------------ the other year
    // The sharpest of the guards, and the one that has nothing to do with
    // references: each year's lists are entered from the годишна програма, so
    // a typo belongs to the year being typed. Anywhere else means a person.
    console.log('\na row that was on another year\'s list is not a typo');
    const carried = await fresh(year.id, 'б');
    await q('INSERT INTO teacher_years (school_year_id, teacher_id) VALUES ($1, $2)', [prior.id, carried.teacher]);
    await q('INSERT INTO therapist_years (school_year_id, therapist_id) VALUES ($1, $2)', [prior.id, carried.therapist]);
    await q('INSERT INTO class_years (school_year_id, class_id) VALUES ($1, $2)', [prior.id, carried.class]);
    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, NULL, 'external', false)`, [carried.student, prior.id]);
    for (const entity of ENTITIES) {
        result = await api('DELETE', address(entity, carried));
        check(`${entity} is refused`, result.status === 409, JSON.stringify(result.body));
        same(`${entity} names the year they were on`, result.body.years, [PRIOR]);
    }
    same('every archived membership survived', [
        await count('student_enrollments', 'student_id = $1 AND school_year_id = $2', [carried.student, prior.id]),
        await count('teacher_years', 'teacher_id = $1 AND school_year_id = $2', [carried.teacher, prior.id]),
        await count('therapist_years', 'therapist_id = $1 AND school_year_id = $2', [carried.therapist, prior.id]),
        await count('class_years', 'class_id = $1 AND school_year_id = $2', [carried.class, prior.id])
    ], [1, 1, 1, 1]);
    check('an inactive membership counts too — being taken off a year is not being absent from it',
        (await api('DELETE', address('student', carried))).status === 409);

    // ---------------------------------------------------- not ours to decide
    console.log('\nS-Dnevnik owns who is enrolled, and this screen does not argue');
    const diary = await fresh(year.id, 'в');
    await q('UPDATE students SET active = false WHERE id = $1', [diary.student]);
    result = await api('DELETE', address('student', diary));
    check('an archived student is refused', result.status === 409, JSON.stringify(result.body));
    await q('UPDATE students SET active = true, sdnevnik_id = 1234567890123 WHERE id = $1', [diary.student]);
    result = await api('DELETE', address('student', diary));
    check('so is one the diary already knows', result.status === 409, JSON.stringify(result.body));
    same('and they are still there', await count('students', 'id = $1', [diary.student]), 1);
    await q('UPDATE students SET sdnevnik_id = NULL WHERE id = $1', [diary.student]);

    // ----------------------------------------------------------- the typo
    console.log('\na name typed by mistake goes, with the membership typing it created');
    const typo = await fresh(year.id, 'г');
    for (const entity of ENTITIES) {
        result = await api('DELETE', address(entity, typo));
        check(`${entity} answers 200`, result.status === 200, JSON.stringify(result.body));
    }
    same('all four directory rows are gone', [
        await count('students', 'id = $1', [typo.student]),
        await count('teachers', 'id = $1', [typo.teacher]),
        await count('therapists', 'id = $1', [typo.therapist]),
        await count('school_classes', 'id = $1', [typo.class])
    ], [0, 0, 0, 0]);
    same('and so are the four membership rows', [
        await count('student_enrollments', 'student_id = $1', [typo.student]),
        await count('teacher_years', 'teacher_id = $1', [typo.teacher]),
        await count('therapist_years', 'therapist_id = $1', [typo.therapist]),
        await count('class_years', 'class_id = $1', [typo.class])
    ], [0, 0, 0, 0]);
    same('last year still has everybody it had',
        await count('teacher_years', 'school_year_id = $1', [prior.id]), 1);

    // ------------------------------------------------------------- records
    // Each of these is a CASCADE or a SET NULL in the schema, so an unguarded
    // DELETE would not fail — it would succeed and take the record with it.
    // Every case therefore asserts the RECORD as well as the refusal.
    console.log('\nanything that records what somebody did refuses, and nothing cascades');
    const held = await fresh(year.id, 'д');
    await q(`INSERT INTO lessons (day, day_order, ordinal, class_id, teacher_id, subject, school_year_id)
             VALUES ('понеделник', 1, 1, $1, $2, 'ТЕСТ', $3)`, [held.class, held.teacher, year.id]);
    await q(`INSERT INTO schedule_slots (day, day_order, time_slot, therapist_id, student_id, school_year_id)
             VALUES ('понеделник', 1, '08:00-08:20', $1, $2, $3)`, [held.therapist, held.student, year.id]);
    await q(`INSERT INTO attendance (student_id, date, slot_key, status)
             VALUES ($1, '1912-09-16', 'понеделник-0', 'present')`, [held.student]);

    for (const [entity, expected] of [
        ['class', { lessons: 1 }],
        ['teacher', { lessons: 1 }],
        ['therapist', { schedule_slots: 1 }],
        ['student', { schedule_slots: 1, attendance: 1 }]
    ] as const) {
        result = await api('DELETE', address(entity, held));
        check(`${entity} is refused with 409`, result.status === 409, JSON.stringify(result.body));
        same(`${entity} says what is holding it`, result.body.holding, expected);
        check(`${entity} says what to do instead`, typeof result.body.instead === 'string' && result.body.instead.length > 0);
    }
    same('the row it refused to delete is still there', [
        await count('students', 'id = $1', [held.student]),
        await count('teachers', 'id = $1', [held.teacher]),
        await count('therapists', 'id = $1', [held.therapist]),
        await count('school_classes', 'id = $1', [held.class])
    ], [1, 1, 1, 1]);
    same('and so is every record that refused it', [
        await count('lessons', 'class_id = $1', [held.class]),
        await count('schedule_slots', 'therapist_id = $1', [held.therapist]),
        await count('attendance', 'student_id = $1', [held.student]),
        await count('student_enrollments', 'student_id = $1', [held.student])
    ], [1, 1, 1, 1]);
    // The lesson keeps its teacher. `lessons.teacher_id` is ON DELETE SET
    // NULL, so an unguarded delete would have left a year of lessons taught
    // by nobody — which reads as a workbook that was imported badly.
    same('the lesson still names its teacher',
        (await q('SELECT teacher_id FROM lessons WHERE class_id = $1', [held.class]))[0].teacher_id, held.teacher);
    // Same shape, and worse: the student is silently unbooked rather than
    // the term being deleted, so the slot survives while pointing at nobody.
    same('the term still names its student',
        (await q('SELECT student_id FROM schedule_slots WHERE therapist_id = $1', [held.therapist]))[0].student_id, held.student);

    console.log('\na caseload link alone is enough to refuse');
    const listed = await fresh(year.id, 'ѓ');
    await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)`,
        [year.id, listed.therapist, listed.student]);
    for (const entity of ['therapist', 'student'] as const) {
        result = await api('DELETE', address(entity, listed));
        check(`${entity} is refused`, result.status === 409, JSON.stringify(result.body));
        same(`${entity} names the caseload`, result.body.holding, { therapist_students: 1 });
    }

    // ------------------------------------------------------- the label case
    // The only blockers that are not foreign keys, and so the only ones the
    // row lock cannot cover: a class is recorded against a child by its LABEL
    // as plain text, in TWO places — the enrolment, and `students.grade`,
    // which `roster-write.ts` still maintains.
    console.log('\na class is held by the children recorded in it, under any spelling');
    const named = await fresh(year.id, 'е');
    await q('UPDATE student_enrollments SET grade = $1, kind = $2 WHERE student_id = $3',
        [named.label, 'internal', named.student]);
    result = await api('DELETE', address('class', named));
    check('an enrolment naming it refuses', result.status === 409, JSON.stringify(result.body));
    same('and the reason is the children, not a constraint', result.body.holding, { enrolments_naming_it: 1 });

    await q('UPDATE student_enrollments SET grade = NULL, kind = $1 WHERE student_id = $2',
        ['external', named.student]);
    await q('UPDATE students SET grade = $1 WHERE id = $2', ['ХI / пе', named.student]);
    result = await api('DELETE', address('class', named));
    check('so does students.grade, which roster-write still writes', result.status === 409, JSON.stringify(result.body));
    same('spelt with a Cyrillic Х and a spaced slash, which = would have missed',
        result.body.holding, { students_naming_it: 1 });
    check('nothing in the schema would have stopped either',
        (await q(`SELECT count(*)::int AS n FROM pg_constraint
                  WHERE contype = 'f' AND confrelid = 'school_classes'::regclass
                    AND conrelid IN ('student_enrollments'::regclass, 'students'::regclass)`))[0].n === 0);
    same('the class is still there', await count('school_classes', 'id = $1', [named.class]), 1);

    // The address is half the guard. Rasporedi and S-Dnevnik reach the roster
    // through `/api/students` and `/api/therapists`, which have no DELETE at
    // all and must keep having none — a browser holding a list from this
    // morning must not be able to remove anybody, whatever it believes. This
    // capability lives at its own path, used by one screen with a person in
    // front of it. Asserted here rather than only in `roster-write.e2e.ts`
    // because this is the file whose reader is tempted to unify the two.
    console.log('\nRasporedi still cannot delete anybody, at its own addresses');
    const survivor = await fresh(year.id, 'ж');
    same('DELETE /api/students/:publicId is still not a route',
        (await api('DELETE', `/api/students/${encodeURIComponent(survivor.publicId)}`)).status, 404);
    same('nor DELETE /api/therapists/:name',
        (await api('DELETE', `/api/therapists/${encodeURIComponent(survivor.name.therapist)}`)).status, 404);
    same('and both are still there', [
        await count('students', 'id = $1', [survivor.student]),
        await count('therapists', 'id = $1', [survivor.therapist])
    ], [1, 1]);

    console.log('\nan address that names nothing is a 404, not a 500');
    same('an unknown public id',
        (await api('DELETE', `/api/roster/student/${TAG}-nobody?year=${encodeURIComponent(YEAR)}&expected=x`)).status, 404);
    same('an unknown numeric id',
        (await api('DELETE', `/api/roster/teacher/2000000000?year=${encodeURIComponent(YEAR)}&expected=x`)).status, 404);
    same('a numeric id that is not one', (await api('DELETE', '/api/roster/class/abc')).status, 400);
    same('a numeric id that is zero', (await api('DELETE', '/api/roster/therapist/0')).status, 400);

    // ------------------------------------------------------- the two locks
    /**
     * Neither check is atomic with its delete without one, and they need
     * different locks because only one of the two blockers is a foreign key.
     *
     * A therapist referenced by nothing is deleted the moment somebody books
     * them a term: the endpoint counts zero, `schedule_slots` CASCADES, and
     * the term created between the count and the delete goes with the
     * therapist behind an HTTP 200. `SELECT … FOR UPDATE` closes that one —
     * inserting a row that references a parent takes `FOR KEY SHARE` on the
     * parent, which conflicts.
     *
     * A class has no such protection, because `student_enrollments.grade` is
     * plain text and points at nothing. `LOCK TABLE … IN SHARE MODE` closes
     * that one, by conflicting with the `ROW EXCLUSIVE` every writer takes
     * whether it knows about this endpoint or not.
     */
    console.log('\na term booked while the endpoint is counting is not lost');
    const raced = await fresh(year.id, 'з');
    const booking = await pool.connect();
    let answered = '';
    try {
        await booking.query('BEGIN');
        await booking.query(
            `INSERT INTO schedule_slots (day, day_order, time_slot, therapist_id, student_id, school_year_id)
             VALUES ('вторник', 2, '09:40-10:20', $1, $2, $3)`,
            [raced.therapist, raced.student, year.id]
        );
        // Not committed: the booking holds FOR KEY SHARE on the therapist.
        const request = api('DELETE', address('therapist', raced))
            .then((r) => { answered = JSON.stringify(r); return r; });
        await new Promise((done) => setTimeout(done, 500));
        check('the endpoint is still waiting for the booking to finish', answered === '',
            `it answered ${answered} — it counted before taking the lock`);
        await booking.query('COMMIT');
        result = await request;
        check('it then refuses, having counted the term that arrived', result.status === 409, JSON.stringify(result.body));
        same('and names it', result.body.holding, { schedule_slots: 1 });
    } finally {
        await booking.query('ROLLBACK').catch(() => {});
        booking.release();
    }
    same('the therapist survived', await count('therapists', 'id = $1', [raced.therapist]), 1);
    same('and so did the term that was booked mid-flight',
        await count('schedule_slots', 'therapist_id = $1', [raced.therapist]), 1);

    console.log('\nnor a child put into the class while it is being counted');
    const typing = await fresh(year.id, 'ѕ');
    const entering = await pool.connect();
    answered = '';
    try {
        await entering.query('BEGIN');
        await entering.query('UPDATE student_enrollments SET grade = $1, kind = $2 WHERE student_id = $3',
            [typing.label, 'internal', typing.student]);
        // Not committed. This takes ROW EXCLUSIVE on student_enrollments and
        // nothing at all on school_classes — the row lock cannot see it.
        const request = api('DELETE', address('class', typing))
            .then((r) => { answered = JSON.stringify(r); return r; });
        await new Promise((done) => setTimeout(done, 500));
        check('the endpoint is waiting on the table, not counting', answered === '',
            `it answered ${answered} — it counted a class that was about to be filled`);
        await entering.query('COMMIT');
        result = await request;
        check('it then refuses, having counted the child', result.status === 409, JSON.stringify(result.body));
        same('and names them', result.body.holding, { enrolments_naming_it: 1 });
    } finally {
        await entering.query('ROLLBACK').catch(() => {});
        entering.release();
    }
    same('the class survived', await count('school_classes', 'id = $1', [typing.class]), 1);
    same('and so did the enrolment naming it',
        await count('student_enrollments', 'student_id = $1 AND grade = $2', [typing.student, typing.label]), 1);

    await cleanup();
    await pool.end();
    if (fails) { console.error(`\n${fails} failed`); process.exit(1); }
    console.log('\nall good');
}

run().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
