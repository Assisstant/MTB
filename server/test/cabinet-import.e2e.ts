/**
 * The cabinet workbook against a real database and a running server.
 *
 *   npm run dev          (or start), then
 *   npm run test:cabinets
 *
 * Everything here is invented (rule 1) and lives in a school year of its own,
 * created at the start and dropped at the end — `teaching.e2e.ts` learnt that
 * the hard way, by writing its fixture into the year a real school was in.
 *
 * The grid is written out by hand rather than read from a workbook: `xlsx` is
 * a CDN tarball that cannot be installed in every environment this runs in,
 * and the sheet→grid step is four lines shared with `import-teaching.ts`. What
 * is worth testing is everything after the grid.
 */

import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { planCabinetImport, applyCabinetPlan, linkCaseload } from '../src/lib/cabinet-import.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const YEAR = '2099/2100';
let passed = 0;
const ok = (what: string, cond: boolean, detail = '') => {
    if (!cond) throw new Error(`FAIL: ${what}${detail ? ' — ' + detail : ''}`);
    passed++;
};

const GRID: string[][] = [
    ['', 'Час', 'КАБИНЕТ', '', '', ''],
    ['', '', 'Логопед', 'Сензорна', 'Незнаен', 'Монтесори'],
    ['Понеделник', 'I.',  'Прва Пробна', 'Втор Пробен', 'Трета Пробна', ''],
    ['',           'II.', 'Трета Пробна/Втор Пробен', '', '', 'Прва Пробна'],
    ['',           'III.','Никаква Личност', '', '', ''],
    ['Вторник',    'I.',  'Ист Именик', 'Прва Пробна', '', '']
];

async function seed() {
    await cleanup();
    await pool.query(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '2099-09-01', '2100-06-10', false)`, [YEAR]);
    const year = (await pool.query('SELECT id FROM school_years WHERE label = $1', [YEAR])).rows[0].id;

    for (const [name, category] of [['Кабинетска Прва', 'Логопед'], ['Кабинетска Втора', 'Сензорна интеграција']]) {
        await pool.query(`INSERT INTO therapists (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
        await pool.query(
            `INSERT INTO therapist_years (school_year_id, therapist_id, active, note, category_id)
             SELECT $1, t.id, true, '', c.id FROM therapists t
             LEFT JOIN specialist_categories c ON c.name = $3
             WHERE t.name = $2`, [year, name, category]);
    }
    const pupils: [string, string][] = [
        ['KAB-1', 'Прва Пробна'], ['KAB-2', 'Втор Пробен'], ['KAB-3', 'Трета Пробна'],
        ['KAB-4', 'Ист Именик'], ['KAB-5', 'Ист Именик']
    ];
    for (const [pid, name] of pupils) {
        await pool.query(
            `INSERT INTO students (public_id, name, grade, active) VALUES ($1, $2, 'I-а', true)
             ON CONFLICT (public_id) DO UPDATE SET name = EXCLUDED.name, active = true`, [pid, name]);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, active, kind)
             SELECT s.id, $2, 'I-а', true, 'internal' FROM students s WHERE s.public_id = $1
             ON CONFLICT (student_id, school_year_id) DO UPDATE SET active = true`, [pid, year]);
    }
    return year;
}

async function cleanup() {
    await pool.query(`DELETE FROM students WHERE public_id LIKE 'KAB-%'`);
    await pool.query(`DELETE FROM therapists WHERE name LIKE 'Кабинетска %'`);
    await pool.query(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
}

try {
    const yearId = await seed();
    const plan = await planCabinetImport(pool, GRID, { year: YEAR });

    ok('the year is the one asked for, not the current one', plan.year.label === YEAR, plan.year.label);
    ok('four cabinet columns are read', plan.cabinets === 4, String(plan.cabinets));

    ok('a category named exactly resolves its column',
        plan.blocks.some((b) => b.cabinet === 'Логопед' && b.therapist === 'Кабинетска Прва'));
    ok('an abbreviated heading resolves and SAYS it inferred',
        plan.blocks.some((b) => b.cabinet === 'Сензорна' && b.therapist === 'Кабинетска Втора')
        && plan.byPrefix.some((p) => p.includes('Сензорна')));
    ok('a column nobody holds is refused, not guessed at',
        plan.unresolvedCabinets.some((u) => u.includes('Незнаен'))
        && !plan.blocks.some((b) => b.cabinet === 'Незнаен'));
    ok('a column with no therapist takes no term with it',
        !plan.blocks.some((b) => b.cabinet === 'Монтесори'));

    ok('a name the year does not hold is reported and its cell left out',
        plan.unknownPupils.includes('Никаква Личност')
        && !plan.blocks.some((b) => b.pupilNames.includes('Никаква Личност')));
    ok('a name two children share is refused (rule 2)',
        plan.ambiguousPupils.includes('Ист Именик')
        && !plan.blocks.some((b) => b.pupilNames.includes('Ист Именик')));

    const first = plan.blocks.find((b) => b.cabinet === 'Логопед' && b.day === 'понеделник' && b.pupilNames.length === 1);
    ok('the block label comes from the year\'s own bells', !!first && /^\d\d:\d\d-\d\d:\d\d$/.test(first!.time), first?.time);
    const split = plan.blocks.find((b) => b.pupilNames.length === 2);
    ok('a split cell stays two pupils in cell order',
        !!split && split!.pupilNames[0] === 'Трета Пробна' && split!.pupilIds.length === 2);

    const before = Number((await pool.query(
        'SELECT count(*) AS n FROM schedule_slots WHERE school_year_id = $1', [yearId])).rows[0].n);
    ok('nothing is written by planning alone', before === 0, String(before));

    let health: Response;
    try { health = await fetch(`${BASE}/api/health`); }
    catch { throw new Error(`Серверот не одговара на ${BASE}. Пушти „npm run dev" па повтори.`); }
    ok('the server answers', health.ok);

    // The endpoint refuses a pupil who is not on that therapist's caseload,
    // and it is right to: a timetable cell is not authority over who a
    // therapist works with. The importer has to SAY so before the write.
    ok('a pupil off the caseload is named in the plan',
        plan.missingCaseload.length === plan.blocks.reduce((n, b) => n + b.pupilIds.length, 0),
        String(plan.missingCaseload.length));
    const refusedFirst = await applyCabinetPlan(plan, BASE);
    ok('and without the caseload the server refuses every one of them',
        refusedFirst.written === 0 && refusedFirst.refused.length === plan.blocks.length,
        `${refusedFirst.written} запишани`);

    const link = await linkCaseload(plan, BASE);
    ok('the caseload links are written through the endpoint that owns them',
        link.linked === plan.missingCaseload.length, link.refused.join(' | '));

    const out = await applyCabinetPlan(plan, BASE);
    ok('every planned block was accepted', out.written === plan.blocks.length,
        `${out.written}/${plan.blocks.length} ${out.refused.join(' | ')}`);

    const rows = (await pool.query(
        `SELECT sl.day, sl.day_order, sl.time_slot, t.name AS therapist, s.public_id
           FROM schedule_slots sl
           JOIN therapists t ON t.id = sl.therapist_id
           LEFT JOIN students s ON s.id = sl.student_id
          WHERE sl.school_year_id = $1 ORDER BY sl.day_order, sl.time_slot`, [yearId])).rows;

    // A full block is one row; a split block is two half rows. Read back from
    // the DATABASE, never from what the plan believed it sent.
    const fullBlocks = plan.blocks.filter((b) => b.pupilIds.length === 1).length;
    const splitBlocks = plan.blocks.filter((b) => b.pupilIds.length === 2).length;
    ok('the rows in the database match the blocks sent',
        rows.length === fullBlocks + splitBlocks * 2, `${rows.length} редови`);
    ok('day_order is the 1–5 the crossing sorts by',
        rows.every((r: any) => r.day_order >= 1 && r.day_order <= 5));
    ok('every row carries a pupil', rows.every((r: any) => r.public_id));
    ok('the two halves of a split block are two different times',
        new Set(rows.filter((r: any) => r.therapist === 'Кабинетска Прва').map((r: any) => r.time_slot)).size >= 2);

    // Running it twice must not double the week: the endpoint owns the block
    // and replaces its contents, which is what makes a re-import safe.
    const again = await applyCabinetPlan(plan, BASE);
    const after = Number((await pool.query(
        'SELECT count(*) AS n FROM schedule_slots WHERE school_year_id = $1', [yearId])).rows[0].n);
    ok('a second run replaces rather than duplicates',
        again.written === plan.blocks.length && after === rows.length, `${after} наспроти ${rows.length}`);

    console.log(`\n  ${passed} тврдења, сите поминаа.\n`);
} catch (err) {
    console.error('\n' + (err instanceof Error ? err.message : String(err)) + '\n');
    process.exitCode = 1;
} finally {
    await cleanup();
    await pool.end();
}
