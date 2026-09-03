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
    pool = new pg.Pool({
        connectionString: TEST_URL,
        options: `-c search_path=${TEST_SCHEMA}`
    });
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
