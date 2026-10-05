/**
 * Tests for projecting app state into the tables, against a real PostgreSQL.
 *
 * These exist because of an actual incident: a save from an app that had not
 * pulled yet replaced a full week's schedule with nothing. Row counts alone
 * would not have caught it, so the safeguards are asserted directly.
 *
 * Uses a throwaway schema created and dropped per run. The application role
 * owns therapy_dev and may create schemas there, but deliberately does not
 * have PostgreSQL's CREATEDB privilege. Keeping the tests inside an isolated
 * schema therefore matches the real installation without touching the live
 * public tables or granting the server account unnecessary power.
 *
 * Run: npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { projectPayload } from '../src/lib/import-core.js';

pg.types.setTypeParser(1082, (v) => v);   // DATE as 'YYYY-MM-DD', as in src/db.ts

const TEST_URL = process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || 'postgres://therapy:therapy_local@localhost:5432/therapy_dev';
// pid contains digits only, so this generated identifier is safe to use in SQL.
const TEST_SCHEMA = `therapy_test_${process.pid}`;

let pool: pg.Pool | null = null;

/**
 * The pool, or a clear error.
 *
 * Two call sites already threw this exact sentence and the rest reached
 * `pool` directly, which the compiler could not prove was set — eight errors
 * the moment the test files were type-checked at all. One accessor is both
 * the fix and the honest version: a test that runs before `before()` should
 * say so, not dereference null.
 */
function db(): pg.Pool {
    if (!pool) throw new Error('test database pool was not initialized');
    return pool;
}

const migrationsDir = resolve(import.meta.dirname, '..', '..', 'database', 'migrations');

before(async () => {
    const setup = new pg.Client({ connectionString: TEST_URL });
    await setup.connect();
    await setup.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await setup.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await setup.end();

    // Every connection used by projectPayload resolves unqualified table names
    // inside the disposable schema, never in therapy_dev.public.
    // pg gives connection-string options precedence over Pool.options. When
    // a caller already isolates its URL, our override must live in that URL
    // too, otherwise migrations run against the caller's existing tables.
    const isolatedUrl = new URL(TEST_URL);
    const inherited = isolatedUrl.searchParams.get('options') || '';
    isolatedUrl.searchParams.set('options', `${inherited} -c search_path=${TEST_SCHEMA}`.trim());
    pool = new pg.Pool({ connectionString: isolatedUrl.href });
    assert.equal((await db().query('SELECT current_schema() AS name')).rows[0].name, TEST_SCHEMA,
        'refuse migrations outside the projection test schema');
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
        await db().query(readFileSync(resolve(migrationsDir, file), 'utf8'));
    }
});

after(async () => {
    if (pool) await pool.end();
    const cleanup = new pg.Client({ connectionString: TEST_URL });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await cleanup.end();
});

/** Runs a projection in its own transaction, like the API does. */
async function project(payload: any) {
    const client = await db().connect();
    try {
        await client.query('BEGIN');
        const result = await projectPayload(client, payload);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}


/**
 * Empties the tables between the regression cases below.
 *
 * The older tests build on each other on purpose; these three each need a
 * known starting point, because what they assert is which ROW a student ends
 * up in.
 */
async function reset() {
    await db().query(`TRUNCATE students, therapists, schedule_slots, student_enrollments,
                               therapist_students, attendance, student_plan_progress,
                               plans, plan_activities, audiograms, assessments, triage_tests,
                               student_records, scale_templates, diary_schedule
                      RESTART IDENTITY CASCADE`);
}

const counts = async () => {
    if (!pool) throw new Error('test database pool was not initialized');
    return (await db().query(
        `SELECT (SELECT count(*)::int FROM students) AS students,
                (SELECT count(*)::int FROM schedule_slots) AS slots,
                (SELECT count(*)::int FROM therapist_students) AS links`
    )).rows[0];
};

/** A small but complete Rasporedi payload. */
function fullPayload(studentCount = 12) {
    const students = Array.from({ length: studentCount }, (_, i) => `I-а - Ученик ${i + 1}`);
    const studentMeta: Record<string, any> = {};
    students.forEach((n, i) => { studentMeta[n] = { studentId: `RS-test-${i + 1}`, grade: 'I-а' }; });
    return {
        students: ['Избери Ученик', ...students],
        therapists: ['Терапевт А', 'Терапевт Б'],
        therapistStudents: { 'Терапевт А': students.slice(0, 6), 'Терапевт Б': students.slice(6) },
        studentMeta,
        schedule: [
            { day: 'понеделник', time: '08:00-08:20', assignments: { 'Терапевт А': students[0], 'Терапевт Б': students[6] } },
            { day: 'вторник', time: '09:00-09:20', assignments: { 'Терапевт А': students[1] } }
        ]
    };
}

test('a full payload lands in the tables', async () => {
    const result = await project(fullPayload());
    assert.equal(result.kind, 'rasporedi');
    assert.deepEqual(result.report.problems, []);

    const c = await counts();
    assert.equal(c.students, 12);
    assert.equal(c.slots, 3);
    assert.equal(c.links, 12);

    // The roster is enrolled in the current school year.
    const enrolled = await db().query(
        `SELECT count(*)::int AS n FROM student_enrollments e
         JOIN school_years y ON y.id = e.school_year_id WHERE y.is_current`
    );
    assert.equal(enrolled.rows[0].n, 12);
});

test('re-projecting the same payload changes nothing', async () => {
    const before = await counts();
    await project(fullPayload());
    assert.deepEqual(await counts(), before);
});

test('an empty schedule does not erase the week', async () => {
    // The real incident: an app that had not pulled yet saved its blank state.
    const payload = fullPayload();
    payload.schedule = [];

    const result = await project(payload);
    const c = await counts();
    assert.equal(c.slots, 3, 'existing slots survive');
    assert.ok(
        result.report.problems.some((p) => p.includes('empty schedule')),
        'and the caller is told why nothing changed'
    );
});

test('a document cannot replace a schedule written cell by cell', async () => {
    // The live danger this guard exists for. RasporediFusion writes each cell
    // through /api/schedule/*; S-Dnevnik saves a whole document and does not set
    // `slotWrites`. Before this, one save from a diary whose copy was a fortnight
    // old replaced the school's plan with it, and every slot whose pupil had been
    // renamed since was dropped as "unknown student".
    await db().query("UPDATE schedule_slots SET source = 'api'");
    const before = (await db().query(
        'SELECT day, time_slot, student_id FROM schedule_slots ORDER BY day, time_slot'
    )).rows;

    const payload = fullPayload();
    payload.schedule = [{
        day: 'среда', time: '10:00-10:20',
        assignments: { 'Терапевт А': 'I-а - Ученик 3' }   // a week the database has never seen
    }];
    const result = await project(payload);

    assert.deepEqual(
        (await db().query('SELECT day, time_slot, student_id FROM schedule_slots ORDER BY day, time_slot')).rows,
        before,
        'not one slot moved'
    );
    assert.ok(
        result.report.problems.some((p) => p.includes('written cell by cell')),
        'and the caller is told which rows it may not replace, and where to change them'
    );
});

test('but a document still owns a schedule it wrote itself', async () => {
    // The guard must not lock out the path it is not aimed at. A year whose
    // slots came from a document may still be rewritten by one -- otherwise the
    // recovery page and the first sync of a fresh machine both stop working.
    await db().query("UPDATE schedule_slots SET source = 'document'");

    const payload = fullPayload();
    payload.schedule = [{
        day: 'среда', time: '10:00-10:20',
        assignments: { 'Терапевт А': 'I-а - Ученик 3' }   // a week the database has never seen
    }];
    const result = await project(payload);

    assert.ok(
        !result.report.problems.some((p) => p.includes('written cell by cell')),
        'nothing is refused'
    );
    const rows = (await db().query("SELECT source FROM schedule_slots")).rows;
    assert.ok(rows.length > 0, 'the document wrote its week');
    assert.ok(rows.every((r) => r.source === 'document'), 'and every row says who wrote it');
});

test('a drastically smaller roster skips projection entirely', async () => {
    const before = await counts();
    const result = await project(fullPayload(2));   // 2 students vs 12 stored

    assert.equal(result.kind, 'rasporedi (skipped)');
    assert.deepEqual(await counts(), before, 'nothing is touched');
    assert.ok(result.report.problems.some((p) => p.includes('safeguard')));
});

test('a genuinely grown roster is accepted', async () => {
    const result = await project(fullPayload(14));
    assert.equal(result.kind, 'rasporedi');
    assert.equal((await counts()).students, 14);
});

test('an unrecognized payload is refused rather than half-applied', async () => {
    const before = await counts();
    const result = await project({ something: 'else' });
    assert.equal(result.kind, 'unknown');
    assert.deepEqual(await counts(), before);
});

test('diary data attaches to students already on the roster', async () => {
    // Link one student to a diary id first.
    const payload: any = fullPayload(14);
    payload.sdnevnik = {
        students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', rasporediStudentId: 'RS-test-1' }]
    };
    await project(payload);

    const diary = {
        students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', planId: 7 }],
        plans: [{ id: 7, name: 'Тест план', activities: ['Прва', 'Втора', 'Трета'] }],
        studentProgress: { '5001': { '7': [{ index: 0, date: '2026-03-02', time: '08:00' }] } },
        attendance: { '2026-03-02': { '5001': { 'monday-0': 'present', 'monday-1': '' } } },
        audiograms: []
    };
    const result = await project(diary);
    assert.equal(result.kind, 'sdnevnik');

    const rows = (await db().query(
        `SELECT (SELECT count(*)::int FROM plans) AS plans,
                (SELECT count(*)::int FROM plan_activities) AS activities,
                (SELECT count(*)::int FROM student_plan_progress) AS progress,
                (SELECT count(*)::int FROM attendance) AS attendance`
    )).rows[0];
    assert.equal(rows.plans, 1);
    assert.equal(rows.activities, 3);
    assert.equal(rows.progress, 1);
    assert.equal(rows.attendance, 1, 'the blank mark is skipped, the real one is kept');

    // The date must survive unchanged — an earlier bug shifted every date by a day.
    const when = await db().query('SELECT date FROM attendance LIMIT 1');
    assert.equal(String(when.rows[0].date), '2026-03-02');
});

/**
 * Seen in the cloud on 5 Oct 2026: paging forward with an empty plan had left an
 * empty copy of every week up to 2028, and the past one covered eight
 * attendance marks. An empty copy says nothing; it is neither stored nor kept.
 */
test('an empty week copy is neither stored nor kept', async () => {
    const payload: any = fullPayload(14);
    payload.sdnevnik = { students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', rasporediStudentId: 'RS-test-1' }] };
    await project(payload);
    const yid = (await db().query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    await db().query(
        `INSERT INTO diary_schedule_history (school_year_id, week_of, payload) VALUES ($1, '2026-02-16', $2)`,
        [yid, JSON.stringify({ monday: [[], [], [], [], []] })]);

    const week = (first: number[] = []) => ({ monday: [first, [], [], [], []], tuesday: [[], [], [], [], []] });
    const result = await project({
        students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', planId: null }],
        plans: [], attendance: {}, studentProgress: {}, audiograms: [],
        schedule: week([5001]),
        scheduleHistory: { '2026-02-23': week([5001]), '2026-03-02': week() }
    });
    assert.equal(result.kind, 'sdnevnik');
    const weeks = (await db().query('SELECT week_of::text AS w FROM diary_schedule_history ORDER BY 1')).rows.map((r) => r.w);
    assert.deepEqual(weeks, ['2026-02-23'], 'the full week is stored; the empty one and the one left earlier are not');
});

/**
 * Regression, seen in the cloud on 2 Oct 2026: a pupil the diary admitted from
 * the annual list carries the roster row's public_id and a fresh diary id, and
 * nothing gave the row that id. The blob saved, the therapist saw the term and
 * the mark, and neither ever reached the tables.
 */
test('a diary save links a pupil to the roster by the bridge it carries', async () => {
    await project(fullPayload(14));
    const before = (await db().query(
        `SELECT sdnevnik_id FROM students WHERE public_id IN ('RS-test-2', 'RS-test-3', 'RS-test-4') ORDER BY public_id`
    )).rows;
    assert.deepEqual(before.map((r) => r.sdnevnik_id), [null, null, null], 'the control: nothing is linked yet');

    // RS-test-4 already belongs to another diary number; 5102 is then claimed twice.
    await db().query(`UPDATE students SET sdnevnik_id = 5999 WHERE public_id = 'RS-test-4'`);
    const marksBefore = (await db().query('SELECT count(*)::int AS n FROM attendance')).rows[0].n;

    const diary = {
        students: [
            { id: 5102, name: 'Ученик 2', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-2' },
            { id: 0, name: 'Ученик 3', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-3' },
            { id: 5104, name: 'Ученик 4', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-4' },
            { id: 5102, name: 'Ученик 5', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-5' }
        ],
        plans: [],
        attendance: { '2026-03-03': { '5102': { 'tuesday-2': { status: 'present', time: '09:40-10:20' } } } }
    };
    const result = await project(diary);

    const after = (await db().query(
        `SELECT public_id, sdnevnik_id::text AS sdn FROM students
          WHERE public_id IN ('RS-test-2', 'RS-test-3', 'RS-test-4', 'RS-test-5') ORDER BY public_id`
    )).rows;
    assert.deepEqual(after, [
        { public_id: 'RS-test-2', sdn: '5102' },
        { public_id: 'RS-test-3', sdn: null },      // 0 is not a diary id
        { public_id: 'RS-test-4', sdn: '5999' },    // a link that exists is never moved
        { public_id: 'RS-test-5', sdn: null }       // a number already on another row is not shared
    ]);
    assert.equal(result.report.problems.filter((p) => /a human has to say which is which/.test(p)).length, 2);

    const marks = await db().query(
        `SELECT s.public_id FROM attendance a JOIN students s ON s.id = a.student_id WHERE a.date = '2026-03-03'`
    );
    assert.deepEqual(marks.rows, [{ public_id: 'RS-test-2' }], 'and the mark reaches the table in the same save');
    assert.equal((await db().query('SELECT count(*)::int AS n FROM attendance')).rows[0].n, marksBefore + 1);
});

/**
 * Regression: the SAME child arriving under a DIFFERENT public_id.
 *
 * `students` has two unique keys — public_id and sdnevnik_id — and the
 * projection only ever told PostgreSQL how to resolve a clash on the first.
 * A clash on the second raised `students_sdnevnik_id_key` and rolled back the
 * ENTIRE projection, so the blob saved while every table stayed at yesterday.
 * Seen on a real machine before it was seen here.
 */
test('a student whose public id changed does not abort the projection', async () => {
    await reset();

    await project({
        students: ['Стар Ученик'],
        therapists: ['Терапевт'],
        studentMeta: { 'Стар Ученик': { studentId: 'RS-stored-1', grade: 'II-а' } },
        schedule: [],
        sdnevnik: { students: [{ id: 6001, name: 'Стар Ученик', grade: 'II-а', rasporediStudentId: 'RS-stored-1' }] }
    });
    const before = (await db().query('SELECT id, public_id FROM students WHERE sdnevnik_id = 6001')).rows[0];
    assert.ok(before, 'the student is there to begin with');

    // Same child, same diary id, but the app now carries a different stored id.
    const result = await project({
        students: ['Нов Ученик'],
        therapists: ['Терапевт'],
        studentMeta: { 'Нов Ученик': { studentId: 'RS-stored-2', grade: 'II-а' } },
        schedule: [],
        sdnevnik: { students: [{ id: 6001, name: 'Нов Ученик', grade: 'II-а', rasporediStudentId: 'RS-stored-2' }] }
    });

    assert.equal(result.kind, 'rasporedi', 'the projection ran instead of throwing');
    const after = (await db().query('SELECT id, public_id, name FROM students WHERE sdnevnik_id = 6001')).rows;
    assert.equal(after.length, 1, 'still one row, not two');
    assert.equal(after[0].id, before.id, 'the SAME row — so terms, marks and dossier follow it');
    assert.equal(after[0].public_id, 'RS-stored-2', 'a stored id is authoritative, so the row moves to it');
});

/**
 * Regression: a GENERATED id must not overrule a stored one.
 *
 * The counterpart of the test above. When the app had no stored id it computes
 * one from the name, and a computed id is a guess — it may not overwrite what
 * the database already has.
 */
test('an id computed from the name does not overwrite a stored one', async () => {
    await reset();

    await project({
        students: ['Ученик Еден'],
        therapists: ['Терапевт'],
        studentMeta: { 'Ученик Еден': { studentId: 'RS-stored-9', grade: 'III-а' } },
        schedule: [],
        sdnevnik: { students: [{ id: 6002, name: 'Ученик Еден', grade: 'III-а', rasporediStudentId: 'RS-stored-9' }] }
    });

    // No studentMeta at all: reconcile generates the public id from the name.
    await project({
        students: ['Ученик Еден'],
        therapists: ['Терапевт'],
        schedule: [],
        sdnevnik: { students: [{ id: 6002, name: 'Ученик Еден', grade: 'III-а', rasporediStudentId: '' }] }
    });

    const rows = (await db().query('SELECT public_id FROM students WHERE sdnevnik_id = 6002')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public_id, 'RS-stored-9', 'the stored id stood its ground');
});

/**
 * Regression: two students share a name and only one of them left.
 *
 * `alsoArchived` used to be "matched by id OR by name". Archiving one „Јана
 * Пробева" therefore flagged the OTHER one — a different child, still
 * enrolled — as archived-but-still-listed, and kept her out of the list that
 * restores active students.
 */
test('archiving one namesake leaves the other alone', async () => {
    await reset();

    const payload: any = {
        students: ['Јана Пробева', 'Јана Пробева '],   // same name, two people
        therapists: ['Терапевт'],
        studentMeta: {
            'Јана Пробева': { studentId: 'RS-jana-3', grade: 'III-а' },
            'Јана Пробева ': { studentId: 'RS-jana-5', grade: 'V-а' }
        },
        schedule: [],
        sdnevnik: {
            students: [
                { id: 7101, name: 'Јана Пробева', grade: 'III-а', rasporediStudentId: 'RS-jana-3' },
                { id: 7102, name: 'Јана Пробева', grade: 'V-а', rasporediStudentId: 'RS-jana-5' }
            ]
        }
    };
    await project(payload);

    // The one in V-а is inactive in the database for the moment — she was
    // archived earlier and the diary has since brought her back. Restoring her
    // is exactly what `active` is for, and it is the observable consequence of
    // the bug: matched by her namesake's name, she never reaches that list.
    await db().query('UPDATE students SET active = false WHERE sdnevnik_id = 7102');

    // The diary archives ONLY the one in III-а.
    payload.archivedStudents = [{
        id: 7101, name: 'Јана Пробева', grade: 'III-а',
        _archived: { year: '2025/2026', at: '2026-06-01T00:00:00.000Z', reason: 'finished' }
    }];
    const result = await project(payload);

    const rows = (await db().query(
        'SELECT sdnevnik_id, active FROM students WHERE sdnevnik_id IN (7101, 7102) ORDER BY sdnevnik_id'
    )).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].active, false, 'the one who left is archived');
    assert.equal(rows[1].active, true, 'and the one who stayed is restored, not held down by a shared name');

    const stillListed = result.report.problems.filter((p) => /still on the Rasporedi list/.test(p));
    assert.ok(
        stillListed.every((p) => !/2 archived/.test(p)),
        'and only ONE of them is reported as archived-but-listed, not both'
    );
});

/**
 * A projection with the ownership the API applies, rather than a file
 * import's. `routes/state.ts` passes this on every save from an app.
 */
async function projectAsApi(payload: any) {
    const client = await db().connect();
    try {
        await client.query('BEGIN');
        const result = await projectPayload(client, payload, { rosterOwned: true });
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

test('API document save preserves an existing external enrolment without a class', async () => {
    await reset();
    const name = 'Измислен Екстерен Ученик';
    const payload = { students: [name], therapists: [], schedule: [],
        studentMeta: { [name]: { studentId: 'external-no-class-test', grade: 'III' } } };
    await project(payload);
    await db().query("UPDATE student_enrollments SET kind = 'external', grade = NULL");
    await db().query('UPDATE students SET grade = NULL');
    payload.studentMeta[name].grade = '';
    const result = await projectAsApi(payload);
    assert.equal(result.kind, 'rasporedi', 'the save must actually project, not skip');
    const rows = (await db().query('SELECT kind, grade FROM student_enrollments')).rows;
    assert.deepEqual(rows, [{ kind: 'external', grade: null }]);
});

test('a save from an app may add a person, and may not restate one', async () => {
    await reset();
    const A = 'Прва Измислена';
    const B = 'Втор Измислен';
    const C = 'Трета Измислена';
    const CABINET = 'Измислен Кабинет';

    const doc = (names: string[], caseload: string[]) => ({
        students: ['Избери Ученик', ...names],
        therapists: [CABINET],
        therapistStudents: { [CABINET]: caseload },
        studentMeta: Object.fromEntries(names.map((n) => [n, { grade: 'IV-а' }])),
        schedule: []
    });

    // The document creates them, exactly as it always has.
    await project(doc([A, B], [A]));
    const nameOf = async (like: string) =>
        (await pool!.query(`SELECT name FROM students WHERE name LIKE $1`, [like])).rows[0]?.name ?? null;
    const gradeIn = async (name: string) => (await pool!.query(
        `SELECT e.grade FROM student_enrollments e JOIN students s ON s.id = e.student_id WHERE s.name = $1`,
        [name])).rows[0]?.grade ?? null;
    const caseloadSize = async () =>
        (await pool!.query('SELECT count(*)::int AS n FROM therapist_students')).rows[0].n as number;

    assert.equal(await gradeIn(A), 'IV-а');
    assert.equal(await caseloadSize(), 1);

    // What somebody does in Podatoci: correct the name, the class, and who
    // this cabinet actually works with.
    await pool!.query(`UPDATE students SET name = 'Поправено Име' WHERE name = $1`, [A]);
    await pool!.query(`UPDATE student_enrollments SET grade = 'V-б', kind = 'boarding'
                        WHERE student_id = (SELECT id FROM students WHERE name = 'Поправено Име')`);
    await pool!.query('DELETE FROM therapist_students');

    // Then somebody presses „Зачувај на сервер" in a tab opened this morning.
    // Its document still holds the old name, the old class and the old ticks —
    // and one more student, added since.
    await projectAsApi(doc([A, B, C], [A, B]));

    assert.equal(await nameOf('Поправено%'), 'Поправено Име', 'the correction was overwritten by a stale document');
    assert.equal(await gradeIn('Поправено Име'), 'V-б', 'the class was overwritten by a stale document');
    assert.equal(
        (await pool!.query(`SELECT kind FROM student_enrollments e JOIN students s ON s.id = e.student_id
                             WHERE s.name = 'Поправено Име'`)).rows[0].kind,
        'boarding'
    );
    assert.equal(await caseloadSize(), 0, 'the caseload was rebuilt from a stale document');

    // Adding is still allowed: that is how a name typed in Rasporedi reaches
    // the database at all, and it can never destroy anything.
    assert.equal(await nameOf(C), C, 'a new student in the document was not created');

    // And a FILE import restores everything, which is rule 4's escape hatch:
    // open the old app with yesterday's export and keep working.
    await project(doc([A, B, C], [A, B]));
    assert.equal(await nameOf('Поправено%'), null);
    assert.equal(await nameOf(A), A);
    assert.equal(await gradeIn(A), 'IV-а');
    assert.equal(await caseloadSize(), 2);
});

/**
 * One child, two roster rows (the cloud, 2 Oct 2026): the old row holds the
 * diary number and the diary's history, the new one is on this year's list.
 * The pairs are named by row id -- that they are one child is the owner's word.
 */
test('merging a pupil the roster holds twice leaves the diary and the tables agreeing', async () => {
    await reset();
    await project(fullPayload(14));
    const idOf = async (publicId: string) =>
        (await db().query('SELECT id FROM students WHERE public_id = $1', [publicId])).rows[0].id as number;
    const [n1, n2] = [await idOf('RS-test-1'), await idOf('RS-test-2')];
    const old = async (publicId: string, sdn: number) => (await db().query(
        `INSERT INTO students (public_id, sdnevnik_id, name, grade, active) VALUES ($1, $2, 'Стар Запис', 'I', false) RETURNING id`,
        [publicId, sdn])).rows[0].id as number;
    const [o1, o2] = [await old('RS-old-1', 8001), await old('RS-old-2', 8002)];
    await db().query(
        `INSERT INTO attendance (student_id, date, slot_key, status) VALUES ($1, '2026-03-02', 'monday-0', 'present'),
                                                                           ($1, '2026-03-03', 'tuesday-4', 'absent')`, [o1]);

    const week = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []] as any[]]));
    const doc: any = {
        students: [
            { id: 8500, name: 'Ученик 1', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-1' },   // has an earlier self
            { id: 0, name: 'Ученик 2', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-2' },      // the Number(null) pupil
            { id: 8600, name: 'Ученик 3', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-3' }    // never linked, no old row
        ],
        formerCaseloadStudents: [{ id: 8001, name: 'Ученик 1', grade: 'I', planId: 7, rasporediStudentId: 'RS-old-1', _formerCaseload: true }],
        archivedStudents: [],
        plans: [{ id: 7, name: 'Тест план', activities: ['Прва'] }],
        schedule: week(), scheduleHistory: { '2026-02-23': week() },
        attendance: {
            '2026-03-02': { '8001': { 'monday-0': { status: 'present', time: '08:00-08:40' } } },
            '2026-03-04': { '8500': { 'wednesday-1': { status: 'present', time: '08:45-09:25' } } }
        },
        studentProgress: { '8001': { '7': [{ index: 0, date: '2026-03-02', time: '08:00-08:40' }] }, '8500': {} },
        assessments: [], trijazenTestovi: [], student_records: [], audiograms: [], scaleTemplates: [], links: []
    };
    doc.schedule.monday[0] = [8500];
    doc.schedule.tuesday[2] = [0];
    doc.schedule.friday[1] = [8600, 8500];
    doc.scheduleHistory['2026-02-23'].monday[0] = [8001];
    await db().query(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
    await db().query(`INSERT INTO app_state (app, version, payload) VALUES ('sdnevnik', 4, $1)`, [JSON.stringify(doc)]);

    const { mergeDiaryPupils, isRefusal } = await import('../src/lib/merge-diary-pupils.js');
    const run = async (plan: any) => {
        const client = await db().connect();
        try {
            await client.query('BEGIN');
            const result = await mergeDiaryPupils(client, { updatedBy: 'test', marks: [], ...plan });
            await client.query('COMMIT');
            return result;
        } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    };

    // An old row that is on this year's list too is a second pupil, not a leftover.
    await db().query('UPDATE student_enrollments SET student_id = $1 WHERE student_id = $2', [o2, n2]);
    await assert.rejects(run({ pairs: [{ oldRow: o2, newRow: n2 }] }), (e) => isRefusal(e) && /second pupil/.test((e as Error).message));
    await db().query('UPDATE student_enrollments SET student_id = $2 WHERE student_id = $1', [o2, n2]);
    // But the global flag alone does not make it one: the diary's saves keep it on.
    await db().query('UPDATE students SET active = true WHERE id = $1', [o2]);

    const result = await run({
        pairs: [{ oldRow: o1, newRow: n1 }, { oldRow: o2, newRow: n2 }],
        marks: [{ date: '2026-03-03', sdnevnikId: '8001', slotKey: 'tuesday-4' }]
    });
    assert.equal(result.before.linked, 0, 'the control: nothing in the diary was linked');
    assert.equal(result.after.linked, 3);
    assert.deepEqual(result.after.termsDifferent, []);
    assert.deepEqual([result.after.marksOnlyInDocument, result.after.marksDifferent, result.after.marksOnlyInTable], [[], [], []]);
    assert.equal(result.after.marksAgree, 3);

    const rows = (await db().query(
        'SELECT id, sdnevnik_id::text AS sdn, active FROM students WHERE id = ANY($1) ORDER BY id', [[n1, n2, o1, o2]])).rows;
    const sdn = Object.fromEntries(rows.map((r) => [r.id, r.sdn]));
    assert.deepEqual([sdn[n1], sdn[n2], sdn[o1], sdn[o2]], ['8001', '8002', null, null]);
    assert.deepEqual([rows.find((r) => r.id === o1).active, rows.find((r) => r.id === o2).active], [false, false],
        'the old rows are no longer pupils of today');
    assert.equal((await db().query('SELECT count(*)::int AS n FROM attendance WHERE student_id = $1', [o1])).rows[0].n, 0);

    const saved = (await db().query(`SELECT version, payload, updated_by FROM app_state WHERE app = 'sdnevnik'`)).rows[0];
    assert.equal(saved.version, 5);
    assert.deepEqual(saved.payload.students.map((s: any) => [s.id, s.planId]), [[8001, 7], [8002, null], [8600, null]]);
    assert.deepEqual(saved.payload.formerCaseloadStudents, []);
    assert.deepEqual([saved.payload.schedule.monday[0], saved.payload.schedule.tuesday[2], saved.payload.schedule.friday[1]],
        [[8001], [8002], [8600, 8001]]);
    assert.deepEqual(Object.keys(saved.payload.attendance['2026-03-04']), ['8001']);
    assert.equal(saved.payload.attendance['2026-03-03']['8001']['tuesday-4'].status, 'absent', 'the mark the diary lost is back');
    assert.equal('8500' in saved.payload.studentProgress, false);

    // Running it again has nothing to hand over, and says so instead of guessing.
    await assert.rejects(run({ pairs: [{ oldRow: o1, newRow: n1 }] }), (e) => isRefusal(e));
});

/**
 * The pair nobody listed (the cloud, 2 Oct 2026): the diary's number already
 * sits on the OLD row, so the pupil looks linked, while its bridge names the
 * row that is on this year's list. `bridged` finds such pairs from the diary's
 * own two links -- and marks under a number no row carries are not a disagreement.
 */
test('a pupil whose number is on the old row and whose bridge is on the new one is merged without being listed', async () => {
    await reset();
    await project(fullPayload(14));
    const n = (await db().query(`SELECT id FROM students WHERE public_id = 'RS-test-4'`)).rows[0].id as number;
    const o = (await db().query(
        `INSERT INTO students (public_id, sdnevnik_id, name, grade, active) VALUES ('RS-old-4', 8700, 'Стар Запис', 'I', false) RETURNING id`)).rows[0].id as number;
    await db().query(`INSERT INTO attendance (student_id, date, slot_key, status) VALUES ($1, '2026-03-02', 'monday-0', 'present')`, [o]);

    const week = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []] as any[]]));
    const doc: any = {
        students: [{ id: 8700, name: 'Ученик 4', grade: 'I-а', planId: null, rasporediStudentId: 'RS-test-4' }],
        formerCaseloadStudents: [], archivedStudents: [], plans: [], schedule: week(), scheduleHistory: {},
        attendance: {
            '2026-03-02': { '8700': { 'monday-0': 'present' } },
            '2025-10-06': { '7777': { 'monday-0': 'present' } }       // a pupil no roster row carries
        },
        studentProgress: {}, assessments: [], trijazenTestovi: [], student_records: [], audiograms: [], scaleTemplates: [], links: []
    };
    doc.schedule.monday[0] = [8700];
    await db().query(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
    await db().query(`INSERT INTO app_state (app, version, payload) VALUES ('sdnevnik', 1, $1)`, [JSON.stringify(doc)]);

    const { mergeDiaryPupils } = await import('../src/lib/merge-diary-pupils.js');
    const run = async (bridged: boolean) => {
        const client = await db().connect();
        try {
            await client.query('BEGIN');
            const result = await mergeDiaryPupils(client, { pairs: [], marks: [], bridged, updatedBy: 'test' });
            await client.query(bridged ? 'COMMIT' : 'ROLLBACK');
            return result;
        } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    };

    // The control: without `bridged` the pupil stays on two rows, and the projection says so.
    const control = await run(false);
    assert.equal(control.lines.length, 0);
    assert.equal(control.projection.problems.filter((p) => /a human has to say which is which/.test(p)).length, 1);

    const result = await run(true);
    assert.equal(result.lines.length, 1);
    assert.equal(result.projection.problems.filter((p) => /a human has to say which is which/.test(p)).length, 0);
    assert.deepEqual([result.after.linked, result.after.marksAgree, result.after.marksOnlyInDocument, result.after.marksOfUnknownPupils],
        [1, 1, [], 1]);
    const rows = (await db().query('SELECT id, sdnevnik_id::text AS sdn FROM students WHERE id = ANY($1) ORDER BY id', [[n, o]])).rows;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.sdn])), { [n]: '8700', [o]: null });
    assert.equal((await db().query('SELECT count(*)::int AS c FROM attendance WHERE student_id = $1', [n])).rows[0].c, 1);
    assert.equal((await db().query(`SELECT payload FROM app_state WHERE app = 'sdnevnik'`)).rows[0].payload.students[0].id, 8700);
});
