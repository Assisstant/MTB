/**
 * The preferred order of a year's four lists, against a real database.
 *
 *     npm run start          # in one terminal
 *     npm run test:order
 *
 * Every assertion reads the order back through `/api/roster`, which is what
 * the screens actually draw — never the table this endpoint wrote, because a
 * stored position nobody reads is the failure this file exists to catch.
 *
 * Its people are invented and prefixed and it works in a school year of its
 * own, so it can share a database with a real school (rule 1).
 */
import pg from 'pg';
import 'dotenv/config';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const TAG = 'roster-order-test';
const YEAR = '1911/1912-order';
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
const roster = async () => (await api('GET', `/api/roster?year=${encodeURIComponent(YEAR)}`)).body;
const names = (rows: any[]) => rows.map((r) => r.name ?? r.label);
const putOrder = (list: string, order: Array<string | number>, year = YEAR) =>
    api('PUT', '/api/roster/order', { year, list, order: order.map(String) });

// Invented, and deliberately neither alphabetical nor the order they are
// created in: the point of the whole feature is a list the reader's own
// ordering cannot produce. Real names live in the local database only (rule 1).
const PEOPLE = ['Гама', 'Бета', 'Делта'].map((first) => `${TAG} ${first}`);

async function cleanup() {
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM teachers WHERE name LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
    // Migration 035 gives every new teacher and therapist a staff identity and
    // keeps it when the profile goes, on purpose. The fixture's must go too, or
    // `check:names` learns these invented names from the database and refuses
    // to commit the very file that holds them. Only rows nothing points at.
    await q(`DELETE FROM employees e WHERE e.name ILIKE ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_roles x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_year_details x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_identity_links x WHERE x.source_id = e.id OR x.target_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.superseded_by = e.id)`, [[`${TAG}%`]]);
    await q('DELETE FROM school_classes WHERE label LIKE $1', [`${TAG}%`]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1911-09-01', '1912-08-31', false) RETURNING id`, [YEAR]);
    const teachers: number[] = [];
    const therapists: number[] = [];
    const classes: number[] = [];
    const students: string[] = [];
    for (const [index, name] of PEOPLE.entries()) {
        const [teacher] = await q(
            `INSERT INTO teachers (name, kind) VALUES ($1, 'pred') RETURNING id`, [`${name} наставник`]);
        const [therapist] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${name} терапевт`]);
        const label = `${TAG}-${index}`;
        const [cls] = await q(
            `INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id`, [label, label]);
        const publicId = `${TAG}-${index}`;
        const [student] = await q(
            `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
            [publicId, `${name} ученик`, label]);
        await q('INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)', [year.id, teacher.id]);
        await q('INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)', [year.id, therapist.id]);
        await q('INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)', [year.id, cls.id]);
        await q(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, $3, 'internal', true)`, [student.id, year.id, label]);
        teachers.push(teacher.id); therapists.push(therapist.id); classes.push(cls.id); students.push(publicId);
    }
    return { year, teachers, therapists, classes, students };
}

async function run() {
    const fixture = await seed();
    console.log(`preferred list order — ${YEAR}\n`);

    console.log("without an arrangement the reader's own order is unchanged");
    let lists = await roster();
    same('therapists come back by name', names(lists.therapists),
        [`${TAG} Бета терапевт`, `${TAG} Гама терапевт`, `${TAG} Делта терапевт`]);
    same('classes come back by sort key', names(lists.classes),
        [`${TAG}-0`, `${TAG}-1`, `${TAG}-2`]);

    console.log('\nan arrangement is what the screens then read');
    // The shape the owner asked for: one person directly under another, which
    // neither the alphabet nor the order they were entered in produces.
    const wanted = [fixture.therapists[1], fixture.therapists[2], fixture.therapists[0]];
    same('the arrangement answers 200', (await putOrder('therapists', wanted)).status, 200);
    lists = await roster();
    same('the therapists are read in the arranged order', names(lists.therapists),
        [`${TAG} Бета терапевт`, `${TAG} Делта терапевт`, `${TAG} Гама терапевт`]);
    same('arranging one list leaves the others alone', names(lists.classes),
        [`${TAG}-0`, `${TAG}-1`, `${TAG}-2`]);

    console.log('\nsomebody added afterwards is placed LAST, never first');
    const [late] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} Алфа терапевт`]);
    await q('INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)',
        [fixture.year.id, late.id]);
    same('the unplaced newcomer sorts after the arranged rows', names((await roster()).therapists),
        [`${TAG} Бета терапевт`, `${TAG} Делта терапевт`, `${TAG} Гама терапевт`, `${TAG} Алфа терапевт`]);

    console.log('\nthe other three lists are arranged the same way');
    same('teachers answer 200', (await putOrder('teachers', [...fixture.teachers].reverse())).status, 200);
    same('students answer 200', (await putOrder('students', [...fixture.students].reverse())).status, 200);
    same('classes answer 200', (await putOrder('classes', [...fixture.classes].reverse())).status, 200);
    lists = await roster();
    same('teachers follow the arrangement', names(lists.teachers),
        [`${TAG} Делта наставник`, `${TAG} Бета наставник`, `${TAG} Гама наставник`]);
    same('pupils follow the arrangement, ahead of their class label',
        lists.students.map((s: any) => s.public_id), [...fixture.students].reverse());
    same('classes follow the arrangement', names(lists.classes), [`${TAG}-2`, `${TAG}-1`, `${TAG}-0`]);

    console.log('\nthe arrangement is a position and nothing else');
    same('the year still holds every therapist', (await roster()).therapists.length, 4);
    same('no membership was touched',
        (await q('SELECT count(*)::int AS n FROM therapist_years WHERE school_year_id = $1 AND active',
            [fixture.year.id]))[0].n, 4);

    console.log('\nwhat it refuses, and what it deliberately does not');
    same('a repeated member is refused',
        (await putOrder('therapists', [fixture.therapists[0], fixture.therapists[0]])).status, 400);
    same('an unknown list is refused', (await api('PUT', '/api/roster/order',
        { year: YEAR, list: 'kabineti', order: [] })).status, 400);
    same('an unknown year is refused',
        (await putOrder('therapists', [fixture.therapists[0]], '1800/1801-order')).status, 404);
    // A key naming nobody costs one unused row and is gone at the next move;
    // checking it here would be a second copy of the membership filters.
    same('a key naming nobody is accepted and changes no list',
        (await putOrder('teachers', [...fixture.teachers, 'RS-nobody'])).status, 200);
    same('the teachers still read as arranged', names((await roster()).teachers),
        [`${TAG} Гама наставник`, `${TAG} Бета наставник`, `${TAG} Делта наставник`]);

    console.log('\nan empty arrangement gives the list back to the reader');
    same('the empty arrangement answers 200', (await putOrder('therapists', [])).status, 200);
    same('the therapists are read by name again', names((await roster()).therapists),
        [`${TAG} Алфа терапевт`, `${TAG} Бета терапевт`, `${TAG} Гама терапевт`, `${TAG} Делта терапевт`]);
    same('the rows for that list are gone rather than left behind',
        (await q('SELECT count(*)::int AS n FROM roster_order WHERE school_year_id = $1 AND list = $2',
            [fixture.year.id, 'therapists']))[0].n, 0);

    console.log("\na therapist's own list (migration 039): one order, read by every screen");
    const own = fixture.therapists[0];
    const ownName = `${TAG} Гама терапевт`;
    for (const publicId of fixture.students) {
        await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
                 SELECT $1, $2, id FROM students WHERE public_id = $3`, [fixture.year.id, own, publicId]);
    }
    const caseload = async () => (await roster()).therapists.find((t: any) => t.id === own).students;
    const putCaseload = (order: string[], name = ownName) =>
        api('PUT', `/api/therapists/${encodeURIComponent(name)}/students-order?year=${encodeURIComponent(YEAR)}`, { order });
    lists = await roster();
    same('the roster says its therapist lists are in reading order', lists.caseloadOrder, true);
    same('unarranged, a therapist\'s list follows the year\'s pupil list', await caseload(),
        lists.students.map((s: any) => s.public_id));
    const wantedOwn = [fixture.students[1], fixture.students[2], fixture.students[0]];
    same('arranging it answers 200', (await putCaseload(wantedOwn)).status, 200);
    same('the list is then read in that order', await caseload(), wantedOwn);
    same('the year\'s pupil list is not arranged with it',
        (await roster()).students.map((s: any) => s.public_id), [...fixture.students].reverse());
    same('it is stored as the therapist\'s own list, and nothing else',
        (await q(`SELECT member_key FROM roster_order WHERE school_year_id = $1 AND list = $2 ORDER BY position`,
            [fixture.year.id, `caseload:${own}`])).map((r: any) => r.member_key), wantedOwn);
    same('nobody was added to or removed from the list',
        (await q('SELECT count(*)::int AS n FROM therapist_students WHERE school_year_id = $1 AND therapist_id = $2',
            [fixture.year.id, own]))[0].n, 3);
    same('a repeated pupil is refused', (await putCaseload([wantedOwn[0], wantedOwn[0]])).status, 400);
    same('an unknown therapist is refused', (await putCaseload(wantedOwn, `${TAG} Никој`)).status, 404);
    await q(`DELETE FROM therapist_students WHERE school_year_id = $1 AND therapist_id = $2
               AND student_id = (SELECT id FROM students WHERE public_id = $3)`, [fixture.year.id, own, wantedOwn[0]]);
    same('a pupil taken off the list is not brought back by the stored order', await caseload(),
        [wantedOwn[1], wantedOwn[2]]);

    console.log('\nthe arrangement belongs to the year and dies with it');
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    same('nothing is left pointing at a year that no longer exists',
        (await q('SELECT count(*)::int AS n FROM roster_order WHERE school_year_id = $1', [fixture.year.id]))[0].n, 0);
}

try {
    await run();
} finally {
    await cleanup();
    await pool.end();
}
console.log(fails ? `\n${fails} failing assertion(s)` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
