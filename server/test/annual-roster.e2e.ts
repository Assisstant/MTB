import pg from 'pg';
import 'dotenv/config';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const TAG = 'annual-roster-test';
const OLD = '1909/1910-annual';
const NEW = '1910/1911-annual';
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
    await q('DELETE FROM school_years WHERE label IN ($1, $2)', [OLD, NEW]);
    await q('DELETE FROM students WHERE public_id = $1', [TAG]);
    await q('DELETE FROM teachers WHERE name = $1', [`${TAG} teacher`]);
    await q('DELETE FROM therapists WHERE name = $1', [`${TAG} therapist`]);
    await q('DELETE FROM school_classes WHERE label = $1', ['VIII-annual']);
}

async function seed() {
    await cleanup();
    const [oldYear] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1909-09-01', '1910-08-31', false) RETURNING id`, [OLD]);
    const [newYear] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1910-09-01', '1911-08-31', false) RETURNING id`, [NEW]);
    const [student] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
        [TAG, `${TAG} student`, 'VIII-annual']);
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind, subject) VALUES ($1, 'pred', 'TEST') RETURNING id`,
        [`${TAG} teacher`]);
    const [therapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} therapist`]);
    const [cls] = await q(
        `INSERT INTO school_classes (label, sort_key) VALUES ('VIII-annual', '08-annual') RETURNING id`);

    await q(
        `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
         VALUES ($1, $2, 'VIII-annual', 'internal', true)`, [student.id, oldYear.id]);
    await q('INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)', [oldYear.id, teacher.id]);
    await q('INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)', [oldYear.id, therapist.id]);
    await q('INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)', [oldYear.id, cls.id]);
    await q(
        `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
         VALUES ($1, $2, $3)`,
        [oldYear.id, therapist.id, student.id]
    );
    return { oldYear, newYear, student, teacher, therapist, cls };
}

async function run() {
    const fixture = await seed();
    console.log(`annual working lists — ${OLD} and ${NEW}\n`);

    console.log('a new year starts as a selection, not a copy of the directory');
    let roster = (await api('GET', `/api/roster?year=${encodeURIComponent(NEW)}`)).body;
    same('the student working list is blank', roster.students, []);
    same('the teacher working list is blank', roster.teachers, []);
    same('the therapist working list is blank', roster.therapists, []);
    same('the class working list is blank', roster.classes, []);
    same('the previous student is offered with a promoted suggestion',
        roster.candidates.students.map((s: any) => [s.public_id, s.last_grade, s.suggested_grade]),
        [[TAG, 'VIII-annual', 'IX-annual']]);
    same('the previous teacher is offered', roster.candidates.teachers.map((x: any) => x.id), [fixture.teacher.id]);
    same('the previous therapist is offered', roster.candidates.therapists.map((x: any) => x.id), [fixture.therapist.id]);
    same('the previous class is offered', roster.candidates.classes.map((x: any) => x.id), [fixture.cls.id]);

    console.log('\nselecting entries changes only the chosen year');
    for (const [entity, members] of [
        ['student', [{ id: TAG, grade: 'IX-annual', kind: 'internal' }]],
        ['teacher', [{ id: fixture.teacher.id }]],
        ['therapist', [{ id: fixture.therapist.id }]],
        ['class', [{ id: fixture.cls.id }]]
    ] as const) {
        const result = await api('PUT', '/api/roster/memberships', { year: NEW, entity, active: true, members });
        check(`${entity} selection answers 200`, result.status === 200, JSON.stringify(result.body));
    }
    roster = (await api('GET', `/api/roster?year=${encodeURIComponent(NEW)}`)).body;
    same('all four selected lists now contain one entry',
        [roster.students.length, roster.teachers.length, roster.therapists.length, roster.classes.length],
        [1, 1, 1, 1]);
    const oldRoster = (await api('GET', `/api/roster?year=${encodeURIComponent(OLD)}`)).body;
    same('the old year is untouched',
        [oldRoster.students.length, oldRoster.teachers.length, oldRoster.therapists.length, oldRoster.classes.length],
        [1, 1, 1, 1]);

    console.log('\ncaseload links belong to the selected year');
    let result = await api(
        'PUT',
        `/api/therapists/${encodeURIComponent(`${TAG} therapist`)}/students/${TAG}?year=${encodeURIComponent(NEW)}`
    );
    check('linking in the new year answers 200', result.status === 200, JSON.stringify(result.body));
    same('the same pair now has one independent row in each year',
        (await q(
            `SELECT school_year_id FROM therapist_students
             WHERE therapist_id = $1 AND student_id = $2 ORDER BY school_year_id`,
            [fixture.therapist.id, fixture.student.id]
        )).map((row) => row.school_year_id),
        [fixture.oldYear.id, fixture.newYear.id].sort((a, b) => a - b));
    result = await api(
        'DELETE',
        `/api/therapists/${encodeURIComponent(`${TAG} therapist`)}/students/${TAG}?year=${encodeURIComponent(NEW)}`
    );
    check('unlinking in the new year answers 200', result.status === 200, JSON.stringify(result.body));
    same('the archived year link remains',
        (await q(
            `SELECT school_year_id FROM therapist_students
             WHERE therapist_id = $1 AND student_id = $2`,
            [fixture.therapist.id, fixture.student.id]
        )).map((row) => row.school_year_id),
        [fixture.oldYear.id]);

    console.log('\nremoving from a year is explicit and reversible');
    result = await api('PUT', '/api/roster/memberships', {
        year: NEW, entity: 'student', active: false, members: [{ id: TAG }]
    });
    check('removing the student answers 200', result.status === 200, JSON.stringify(result.body));
    const operational = (await api('GET', `/api/students?year=${encodeURIComponent(NEW)}`)).body;
    same('the operational student API no longer offers them', operational, []);
    const staleAdd = await api('POST', '/api/students', {
        publicId: TAG, name: `${TAG} student`, grade: 'IX-annual', year: NEW
    });
    check('a stale roster write cannot silently put them back', staleAdd.status === 409, JSON.stringify(staleAdd.body));
    same('the refused stale write left the yearly decision false',
        (await q(`SELECT e.active FROM student_enrollments e JOIN students s ON s.id = e.student_id
                  WHERE e.school_year_id = $1 AND s.public_id = $2`, [fixture.newYear.id, TAG]))[0]?.active,
        false);
    const directory = (await api('GET', `/api/students?year=${encodeURIComponent(NEW)}&includeInactive=1`)).body;
    check('the permanent directory still holds them with an explicit yearly false',
        directory.some((s: any) => s.public_id === TAG && s.active_this_year === false), JSON.stringify(directory));
    result = await api('PUT', '/api/roster/memberships', {
        year: NEW, entity: 'student', active: true,
        members: [{ id: TAG, grade: 'IX-annual', kind: 'internal' }]
    });
    check('putting them back answers 200', result.status === 200, JSON.stringify(result.body));

    console.log('\none bad checkbox refuses the entire batch');
    result = await api('PUT', '/api/roster/memberships', {
        year: NEW, entity: 'teacher', active: false,
        members: [{ id: fixture.teacher.id }, { id: 2_000_000_000 }]
    });
    check('the batch is refused', result.status === 409, JSON.stringify(result.body));
    same('the valid teacher was not half-removed',
        (await q('SELECT active FROM teacher_years WHERE school_year_id = $1 AND teacher_id = $2',
            [fixture.newYear.id, fixture.teacher.id]))[0]?.active, true);

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
