import pg from 'pg';
import 'dotenv/config';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const TAG = 'fusion-session-test';
const YEAR = '1911/1912-fusion';
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

async function cleanup() {
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1911-09-01', '1912-08-31', false) RETURNING id`, [YEAR]);
    const [firstTherapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} therapist A`]);
    const [secondTherapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} therapist B`]);
    const students = [];
    for (const suffix of ['a', 'b', 'outside']) {
        const [student] = await q(
            `INSERT INTO students (public_id, name, grade)
             VALUES ($1, $2, 'IV-а') RETURNING id, public_id`,
            [`${TAG}-${suffix}`, `${TAG} Same Name`]
        );
        students.push(student);
        await q(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, active)
             VALUES ($1, $2, 'IV-а', true)`,
            [student.id, year.id]
        );
    }
    for (const therapist of [firstTherapist, secondTherapist]) {
        await q(
            `INSERT INTO therapist_years (school_year_id, therapist_id, active)
             VALUES ($1, $2, true)`,
            [year.id, therapist.id]
        );
    }
    for (const therapist of [firstTherapist, secondTherapist]) {
        for (const student of students.slice(0, 2)) {
            await q(
                `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
                 VALUES ($1, $2, $3)`,
                [year.id, therapist.id, student.id]
            );
        }
    }
    return { firstTherapist, secondTherapist, students };
}

async function run() {
    const fixture = await seed();
    console.log('RasporediFusion sessions — stable ids and two 20-minute halves\n');

    let result = await api('GET', `/api/schedule/sessions?year=${encodeURIComponent(YEAR)}`);
    check('the empty year can be read', result.status === 200, JSON.stringify(result.body));
    same('it starts with no sessions', result.body.sessions, []);

    const cell = {
        year: YEAR,
        day: 'понеделник',
        time: '08:00-08:40',
        therapistId: fixture.firstTherapist.id,
        studentPublicId: fixture.students[0].public_id,
        expectedStudentPublicId: null
    };
    result = await api('PUT', '/api/schedule/session', cell);
    check('one 40-minute session lands', result.status === 200, JSON.stringify(result.body));

    result = await api('GET', `/api/schedule/sessions?year=${encodeURIComponent(YEAR)}`);
    same('the read returns stable ids even though the students share a name',
        result.body.sessions.map((s: any) => [s.therapist_id, s.student_public_id, s.time]),
        [[fixture.firstTherapist.id, fixture.students[0].public_id, '08:00-08:40']]);

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        studentPublicId: fixture.students[1].public_id,
        expectedStudentPublicId: null
    });
    check('a stale cell edit is refused', result.status === 409, JSON.stringify(result.body));
    same('the refusal names the stored stable id', result.body.actualStudentPublicId, fixture.students[0].public_id);

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        therapistId: fixture.secondTherapist.id,
        expectedStudentPublicId: null
    });
    check('the same student cannot be double-booked with another therapist',
        result.status === 409 && result.body.doubleBooked === true, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        time: '08:00-08:20',
        studentPublicId: fixture.students[1].public_id,
        expectedStudentPublicId: null
    });
    check('a half cannot overlap an existing full session for the same therapist',
        result.status === 409 && result.body.therapistOccupied === true, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        studentPublicId: null,
        expectedStudentPublicId: fixture.students[0].public_id
    });
    check('the compatibility 40-minute row can be cleared', result.status === 200, JSON.stringify(result.body));

    const firstHalf = { ...cell, time: '08:00-08:20', expectedStudentPublicId: null };
    result = await api('PUT', '/api/schedule/session', firstHalf);
    check('the first 20-minute half lands', result.status === 200, JSON.stringify(result.body));

    const secondHalf = {
        ...cell,
        time: '08:20-08:40',
        studentPublicId: fixture.students[1].public_id,
        expectedStudentPublicId: null
    };
    result = await api('PUT', '/api/schedule/session', secondHalf);
    check('the adjacent second half can hold another student', result.status === 200, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...secondHalf,
        therapistId: fixture.secondTherapist.id
    });
    check('the same student cannot be double-booked in one half',
        result.status === 409 && result.body.doubleBooked === true, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        time: '08:00-08:10',
        expectedStudentPublicId: null
    });
    check('a range other than 20 or 40 minutes is refused', result.status === 400, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...cell,
        time: '08:45-09:25',
        studentPublicId: fixture.students[2].public_id,
        expectedStudentPublicId: null
    });
    check('a student outside the therapist caseload is refused',
        result.status === 409 && result.body.notInCaseload === true, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/session', {
        ...firstHalf,
        studentPublicId: null,
        expectedStudentPublicId: fixture.students[0].public_id
    });
    check('clearing the first half with the correct expected id succeeds', result.status === 200, JSON.stringify(result.body));
    result = await api('PUT', '/api/schedule/session', {
        ...secondHalf,
        studentPublicId: null,
        expectedStudentPublicId: fixture.students[1].public_id
    });
    check('clearing the second half succeeds', result.status === 200, JSON.stringify(result.body));
    same('the database row is gone',
        (await q('SELECT count(*)::int AS n FROM schedule_slots WHERE school_year_id = (SELECT id FROM school_years WHERE label = $1)', [YEAR]))[0].n,
        0);

    const block = {
        year: YEAR,
        day: 'понеделник',
        time: '08:00-08:40',
        therapistId: fixture.firstTherapist.id,
        studentPublicIds: [fixture.students[0].public_id],
        expectedStudentPublicIds: []
    };
    result = await api('PUT', '/api/schedule/block', block);
    check('one pupil occupies the complete 40-minute block', result.status === 200, JSON.stringify(result.body));
    same('one pupil is represented by one 40-minute database row',
        (await q(
            `SELECT s.public_id, sl.time_slot
             FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
             WHERE sl.school_year_id = (SELECT id FROM school_years WHERE label = $1)
             ORDER BY sl.time_slot`, [YEAR]
        )).map((row) => [row.public_id, row.time_slot]),
        [[fixture.students[0].public_id, '08:00-08:40']]);

    result = await api('PUT', '/api/schedule/block', {
        ...block,
        studentPublicIds: [fixture.students[0].public_id, fixture.students[1].public_id],
        expectedStudentPublicIds: [fixture.students[0].public_id]
    });
    check('adding a second pupil atomically splits the block', result.status === 200, JSON.stringify(result.body));
    same('two pupils are represented by ordered 20-minute rows',
        (await q(
            `SELECT s.public_id, sl.time_slot
             FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
             WHERE sl.school_year_id = (SELECT id FROM school_years WHERE label = $1)
             ORDER BY sl.time_slot`, [YEAR]
        )).map((row) => [row.public_id, row.time_slot]),
        [
            [fixture.students[0].public_id, '08:00-08:20'],
            [fixture.students[1].public_id, '08:20-08:40']
        ]);

    result = await api('PUT', '/api/schedule/block', {
        ...block,
        studentPublicIds: [fixture.students[0].public_id],
        expectedStudentPublicIds: [fixture.students[0].public_id, fixture.students[1].public_id]
    });
    check('removing the second pupil atomically restores one 40-minute row', result.status === 200, JSON.stringify(result.body));
    same('the first pupil again owns all 40 minutes',
        (await q(
            `SELECT s.public_id, sl.time_slot
             FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
             WHERE sl.school_year_id = (SELECT id FROM school_years WHERE label = $1)`, [YEAR]
        )).map((row) => [row.public_id, row.time_slot]),
        [[fixture.students[0].public_id, '08:00-08:40']]);

    await q('UPDATE students SET active = false WHERE id = $1', [fixture.students[0].id]);
    result = await api('GET', `/api/schedule/sessions?year=${encodeURIComponent(YEAR)}`);
    same('archiving a pupil later does not hide their historical session',
        result.body.sessions.map((session: any) => [session.student_public_id, session.time]),
        [[fixture.students[0].public_id, '08:00-08:40']]);
    const historicalRoster = await api('GET', `/api/roster?year=${encodeURIComponent(YEAR)}`);
    check('the historical roster still contains that pupil',
        historicalRoster.body.students.some((student: any) => student.public_id === fixture.students[0].public_id),
        JSON.stringify(historicalRoster.body.students));
    check('the historical therapist caseload still contains that pupil',
        historicalRoster.body.therapists.some((therapist: any) =>
            therapist.id === fixture.firstTherapist.id && therapist.students.includes(fixture.students[0].public_id)),
        JSON.stringify(historicalRoster.body.therapists));
    same('the historical caseload contains each dropdown pupil exactly once',
        historicalRoster.body.therapists.find((therapist: any) =>
            therapist.id === fixture.firstTherapist.id)?.students,
        fixture.students.slice(0, 2).map((student: any) => student.public_id).sort());
    result = await api('PUT', '/api/schedule/block', {
        ...block,
        studentPublicIds: [fixture.students[0].public_id],
        expectedStudentPublicIds: [fixture.students[0].public_id]
    });
    check('a historical block remains editable after the pupil later leaves',
        result.status === 200, JSON.stringify(result.body));
    await q('UPDATE students SET active = true WHERE id = $1', [fixture.students[0].id]);

    result = await api('PUT', '/api/schedule/block', {
        ...block,
        studentPublicIds: [fixture.students[1].public_id],
        expectedStudentPublicIds: []
    });
    check('a stale whole-block edit is refused',
        result.status === 409, JSON.stringify(result.body));
    same('the whole-block refusal reports the current semantic pupil list',
        result.body.actualStudentPublicIds, [fixture.students[0].public_id]);

    result = await api('PUT', '/api/schedule/block', {
        ...block,
        therapistId: fixture.secondTherapist.id,
        expectedStudentPublicIds: []
    });
    check('one 40-minute pupil cannot overlap another cabinet',
        result.status === 409 && result.body.doubleBooked === true, JSON.stringify(result.body));

    result = await api('PUT', '/api/schedule/block', {
        ...block,
        studentPublicIds: [],
        expectedStudentPublicIds: [fixture.students[0].public_id]
    });
    check('the complete block can be cleared atomically', result.status === 200, JSON.stringify(result.body));
    same('clearing the block removes its full and half representations',
        (await q('SELECT count(*)::int AS n FROM schedule_slots WHERE school_year_id = (SELECT id FROM school_years WHERE label = $1)', [YEAR]))[0].n,
        0);

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
