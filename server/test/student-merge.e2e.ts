/**
 * One child, two rows in `students`: found, then merged with everything
 * (lib/student-merge.ts, routes/student-merge.ts).
 *
 *   npm run test:scratch -- test/student-merge.e2e.ts
 *
 * It writes the diary's document, so it runs ONLY against a scratch database
 * (MTB_SCRATCH_DB=1, which test:scratch sets) — never against the school's.
 * The years, the people and the diary numbers are invented.
 *
 * What it holds the merge to:
 *   - the list of tables it moves IS the live schema's (every foreign key to
 *     `students`), and the "same fact" keys ARE its unique constraints;
 *   - every row of the folded pupil ends on the kept one; where both held the
 *     same fact the kept row's stays, and an inactive enrolment gives way to an
 *     active one; the dossier takes what only the other one said;
 *   - two filled евидентни листови for one year refuse, and change nothing;
 *   - the folded row is not deleted: inactive, no diary number, `merged:<kept>`;
 *   - the diary's document becomes one pupil under the kept number, with the
 *     other number's marks and terms, and a new version for the browser to pull;
 *   - look-alike names are listed (one letter apart), different names are not.
 */
import pg from 'pg';
import 'dotenv/config';
import { pupilTables, SAME_FACT, namesLookAlike } from '../src/lib/student-merge.js';

if (process.env.MTB_SCRATCH_DB !== '1') {
    console.error('Refusing: this suite rewrites the diary document. Run it with `npm run test:scratch -- test/student-merge.e2e.ts`.');
    process.exit(2);
}
const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(1082, (v) => v);

const TAG = 'student-merge-test';
const YEAR = '1914/1915-merge';
const PRIOR = '1913/1914-merge';
let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const same = (label: string, got: unknown, want: unknown) =>
    check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
        method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any };
};

async function cleanup() {
    await q(`DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE public_id LIKE $1)`, [`${TAG}%`]);
    await q('DELETE FROM school_years WHERE label IN ($1, $2)', [YEAR, PRIOR]);
    await q(`DELETE FROM student_records WHERE student_id IN (SELECT id FROM students WHERE public_id LIKE $1)`, [`${TAG}%`]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
}

async function run() {
    // ── the lists are the schema ────────────────────────────────────────────
    console.log('the merge moves what the schema says points at a pupil');
    const fks = (await q(
        `SELECT c.conrelid::regclass::text AS t, a.attname AS col
           FROM pg_constraint c JOIN unnest(c.conkey) k(n) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
          WHERE c.contype = 'f' AND c.confrelid = 'students'::regclass`)).map((r) => `${r.t}.${r.col}`).sort();
    same('every foreign key to students is moved', Object.entries(pupilTables()).map(([t, c]) => `${t}.${c}`).sort(), fks);
    const uniques = (await q(
        `SELECT c.conrelid::regclass::text AS t,
                array(SELECT a.attname FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                       WHERE a.attname <> 'student_id' ORDER BY a.attname)::text[] AS cols
           FROM pg_constraint c
          WHERE c.contype IN ('u', 'p') AND c.conrelid::regclass::text = ANY($1)
            AND EXISTS (SELECT 1 FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                         WHERE a.attname = 'student_id')`, [Object.keys(pupilTables())]))
        .map((r) => `${r.t}:${[...r.cols].sort().join(',')}`).sort();
    same('every unique key that holds a pupil is a "same fact" key', Object.entries(SAME_FACT).map(([t, c]) => `${t}:${[...c].sort().join(',')}`).sort(), uniques);

    console.log('\nlook-alike names');
    same('one letter apart, the other order, or the same — yes; different — no', [
        namesLookAlike('Измислен Петкоски', 'Измислен Петковски'),
        namesLookAlike('Петковски Измислен', 'Измислен Петкоски'),
        namesLookAlike('VI-а - Измислен Петкоски', 'Измислен Петкоски (над.)'),
        namesLookAlike('Пробна Ана', 'Пробна Ања'),
        namesLookAlike('Измислен Петкоски', 'Измислена Петковска')
    ], [true, true, true, false, false]);

    // ── a pupil held twice ──────────────────────────────────────────────────
    await cleanup();
    const [prior] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current) VALUES ($1, '1913-09-01', '1914-08-31', false) RETURNING id`, [PRIOR]);
    const [year] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current) VALUES ($1, '1914-09-01', '1915-08-31', false) RETURNING id`, [YEAR]);
    const [th] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} терапевт`]);
    await q('INSERT INTO therapist_years (school_year_id, therapist_id) VALUES ($1, $2)', [year.id, th.id]);
    const pupil = async (suffix: string, name: string, sdn: number | null) => (await q(
        `INSERT INTO students (public_id, name, sdnevnik_id) VALUES ($1, $2, $3) RETURNING id, public_id`, [`${TAG}-${suffix}`, name, sdn]))[0];
    const K = await pupil('k', 'Измислен Петковски', 9100001);
    const G = await pupil('g', 'Измислен Петкоски', 9100002);
    const H = await pupil('h', 'Пробна Друга', null);
    const enrol = (id: number, y: number, grade: string, active: boolean) =>
        q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active) VALUES ($1, $2, $3, 'internal', $4)`, [id, y, grade, active]);
    await enrol(K.id, year.id, 'VI-а', false);        // K's enrolment this year is inactive …
    await enrol(G.id, year.id, 'VI', true);           // … G's is active: G's wins
    await enrol(G.id, prior.id, 'V', true);           // last year only G: moves
    await enrol(H.id, year.id, 'VI-а', true);
    for (const id of [K.id, G.id]) await q('INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)', [year.id, th.id, id]);
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id) VALUES ($1, 'понеделник', 1, '08:00-08:40', $2, $3)`, [year.id, th.id, K.id]);
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id) VALUES ($1, 'вторник', 2, '09:40-10:20', $2, $3)`, [year.id, th.id, G.id]);
    const mark = (id: number, date: string, slot: string, status: string) =>
        q('INSERT INTO attendance (student_id, date, slot_key, status) VALUES ($1, $2, $3, $4)', [id, date, slot, status]);
    await mark(K.id, '1914-10-06', 'tuesday-0', 'present');
    await mark(G.id, '1914-10-06', 'tuesday-0', 'absent');      // the two disagree: K's stays
    await mark(G.id, '1914-10-07', 'wednesday-0', 'present');   // only G: moves
    await q(`INSERT INTO student_records (student_id, first_name, address) VALUES ($1, 'Измислен', NULL)`, [K.id]);
    await q(`INSERT INTO student_records (student_id, first_name, address) VALUES ($1, 'Друго', 'Измислена 1')`, [G.id]);
    const [kSheet] = await q('INSERT INTO evidence_sheets (student_id, school_year_id) VALUES ($1, $2) RETURNING id', [K.id, year.id]);
    const [gSheet] = await q('INSERT INTO evidence_sheets (student_id, school_year_id) VALUES ($1, $2) RETURNING id', [G.id, year.id]);
    await q(`INSERT INTO evidence_contacts (sheet_id, ord, name) VALUES ($1, 1, 'Измислен контакт')`, [gSheet.id]);
    await q(`INSERT INTO evidence_contacts (sheet_id, ord, name) VALUES ($1, 1, 'Друг контакт')`, [kSheet.id]);
    await q(`INSERT INTO roster_order (school_year_id, list, member_key, position) VALUES ($1, 'students', $2, 0), ($1, 'students', $3, 1), ($1, $4, $3, 0)`,
        [year.id, K.public_id, G.public_id, `caseload:${th.id}`]);

    const doc = {
        students: [
            { id: 9100001, name: 'Измислен Петковски', grade: 'VI-а', rasporediStudentId: K.public_id, planId: null },
            { id: 9100002, name: 'Измислен Петкоски', grade: 'VI', rasporediStudentId: G.public_id, planId: 5 }
        ],
        formerCaseloadStudents: [], archivedStudents: [],
        schedule: { monday: [[9100002, 9100001], [], [], [], []], tuesday: [[9100002], [], [], [], []] },
        attendance: {
            '1914-10-06': { 9100001: { 'tuesday-0': { status: 'present' } }, 9100002: { 'tuesday-0': { status: 'absent' } } },
            '1914-10-07': { 9100002: { 'wednesday-0': { status: 'present' } } }
        },
        studentProgress: { 9100002: { 5: [{ index: 0 }] } },
        student_records: [{ id: 9100002, address: 'Измислена 1' }]
    };
    const before = (await q(`SELECT version, payload FROM app_state WHERE app = 'sdnevnik'`))[0];
    await q(`INSERT INTO app_state (app, version, payload) VALUES ('sdnevnik', 7, $1)
             ON CONFLICT (app) DO UPDATE SET version = 7, payload = EXCLUDED.payload`, [JSON.stringify(doc)]);

    try {
        console.log('\nfound, not merged');
        const found = await api('GET', `/api/roster/look-alike?year=${encodeURIComponent(YEAR)}`);
        const ours = (found.body.pairs || []).filter((p: any) => p.a.public_id.startsWith(TAG));
        same('the look-alike pair is listed, the other pupil is not', ours.map((p: any) => [p.a.public_id, p.b.public_id]), [[K.public_id, G.public_id]]);
        check('with what each row holds, for the person to choose', ours[0]?.b.enrolled === true && ours[0]?.b.terms === 1 && ours[0]?.b.marks === 2);

        console.log('\nwhat refuses');
        same('a pupil cannot be merged with itself', (await api('POST', '/api/roster/merge', { keep: K.public_id, fold: K.public_id })).status, 409);
        const refused = await api('POST', '/api/roster/merge', { keep: K.public_id, fold: G.public_id });
        check('two filled евидентни листови for one year refuse, in words', refused.status === 409 && /евидентен лист/.test(refused.body.error), JSON.stringify(refused));
        same('and nothing moved', (await q('SELECT count(*)::int AS n FROM attendance WHERE student_id = $1', [G.id]))[0].n, 2);
        await q('DELETE FROM evidence_contacts WHERE sheet_id = $1', [kSheet.id]);   // a person emptied one

        console.log('\nthe merge');
        const done = await api('POST', '/api/roster/merge', { keep: K.public_id, fold: G.public_id });
        same('it answers 200', done.status, 200);
        same('it says what stayed where both held the same fact', Object.entries(done.body.sameFact || {}).sort(),
            [['attendance', 1], ['student_records', 1], ['therapist_students', 1]]);
        same('and that one mark disagreed (the kept one stayed)', done.body.marksDiffered, 1);

        same('nothing points at the folded row any more',
            (await Promise.all(Object.entries(pupilTables()).map(async ([t, c]) =>
                (await q(`SELECT count(*)::int AS n FROM ${t} WHERE ${c} = $1`, [G.id]))[0].n))).reduce((a, b) => a + b, 0), 0);
        same('this year: the active enrolment, last year: moved',
            await q('SELECT y.label, e.grade, e.active FROM student_enrollments e JOIN school_years y ON y.id = e.school_year_id WHERE e.student_id = $1 ORDER BY y.starts_on', [K.id]),
            [{ label: PRIOR, grade: 'V', active: true }, { label: YEAR, grade: 'VI', active: true }]);
        same('one link to the therapist', (await q('SELECT count(*)::int AS n FROM therapist_students WHERE student_id = $1', [K.id]))[0].n, 1);
        same('both terms are the kept pupil\'s', (await q('SELECT count(*)::int AS n FROM schedule_slots WHERE student_id = $1', [K.id]))[0].n, 2);
        same('marks: the kept one where they clashed, the other one where only it had one',
            await q('SELECT date, slot_key, status FROM attendance WHERE student_id = $1 ORDER BY date', [K.id]),
            [{ date: '1914-10-06', slot_key: 'tuesday-0', status: 'present' }, { date: '1914-10-07', slot_key: 'wednesday-0', status: 'present' }]);
        same('one dossier, with what only the other said', await q('SELECT first_name, address FROM student_records WHERE student_id = $1', [K.id]),
            [{ first_name: 'Измислен', address: 'Измислена 1' }]);
        same('the filled евидентен лист is the kept pupil\'s, the empty one is gone',
            await q('SELECT s.id, (SELECT count(*)::int FROM evidence_contacts c WHERE c.sheet_id = s.id) AS contacts FROM evidence_sheets s WHERE s.student_id = $1', [K.id]),
            [{ id: gSheet.id, contacts: 1 }]);
        same('the arrangement names the kept pupil once in each list',
            await q('SELECT list, member_key, position FROM roster_order WHERE school_year_id = $1 ORDER BY list, position', [year.id]),
            [{ list: `caseload:${th.id}`, member_key: K.public_id, position: 0 }, { list: 'students', member_key: K.public_id, position: 0 }]);
        same('the folded row stays, inactive, with no diary number, saying where it went',
            await q('SELECT active, sdnevnik_id, left_reason FROM students WHERE id = $1', [G.id]),
            [{ active: false, sdnevnik_id: null, left_reason: `merged:${K.public_id}` }]);
        same('the kept row keeps its diary number and is at school', await q('SELECT active, sdnevnik_id::text AS sdn FROM students WHERE id = $1', [K.id]),
            [{ active: true, sdn: '9100001' }]);

        console.log('\nthe diary\'s document');
        const after = (await q(`SELECT version, payload FROM app_state WHERE app = 'sdnevnik'`))[0];
        same('a new version, so the browser pulls it', after.version, 8);
        same('one pupil, under the kept number, carrying the plan only the other had',
            after.payload.students.map((s: any) => [s.id, s.rasporediStudentId, s.planId]), [[9100001, K.public_id, 5]]);
        same('the week names the kept number once', after.payload.schedule.monday[0], [9100001]);
        same('and the other number\'s terms', after.payload.schedule.tuesday[0], [9100001]);
        same('marks: the kept one where they clashed, the other one moved', after.payload.attendance,
            { '1914-10-06': { 9100001: { 'tuesday-0': { status: 'present' } } }, '1914-10-07': { 9100001: { 'wednesday-0': { status: 'present' } } } });
        same('progress and dossier follow', [Object.keys(after.payload.studentProgress), after.payload.student_records.map((r: any) => r.id)], [['9100001'], [9100001]]);
        same('the diary reads the kept number\'s marks from the table',
            Object.keys((await api('GET', '/api/diary/attendance?from=1914-10-01&to=1914-10-31')).body['1914-10-07'] || {}), ['9100001']);

        const again = await api('GET', `/api/roster/look-alike?year=${encodeURIComponent(YEAR)}`);
        same('and the pair is no longer offered', (again.body.pairs || []).filter((p: any) => p.a.public_id.startsWith(TAG)).length, 0);
    } finally {
        if (before) await q(`UPDATE app_state SET version = $1, payload = $2 WHERE app = 'sdnevnik'`, [before.version, JSON.stringify(before.payload)]);
        else await q(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
        await cleanup();
    }
}

run().then(async () => {
    await pool.end();
    console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
    process.exit(fails ? 1 : 0);
}, async (err) => { console.error(err); await pool.end().catch(() => {}); process.exit(1); });
