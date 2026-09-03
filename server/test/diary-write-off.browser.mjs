/**
 * The promise Stage D has to keep on Monday: with the flag off, NOTHING it
 * added exists. Every attendance mark stays local, exactly as before, and the
 * diary is free to be saved as a whole document as it always was.
 *
 * Its counterpart lives in diary-write.browser.mjs. Neither is worth much
 * alone: the "on" test proves the new path works, this one proves the old path
 * is untouched, and only together do they say the flag means anything.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@localhost:5432/therapy_dev'
});

const FIXTURE = JSON.parse(
    readFileSync(new URL('../../sample-data/anonymized/diary-sample.json', import.meta.url), 'utf8')
);
const SDN_IDS = [9001, 9002, 9003];
const PLAN_SDN_ID = 7001;
const TARGET = '2026-05-18';

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };

/**
 * The browser drives the REAL app, so this test writes to the real blob key
 * and clears it afterwards. Pointed at the working database that would delete
 * a year of work, so it refuses to start unless the database is a scratch one.
 */
async function refuseUnlessScratch() {
    const { rows } = await pool.query('SELECT current_database() AS db');
    const db = String(rows[0].db);
    if (!/dev|test/i.test(db)) {
        console.error(`\nRefusing to run: "${db}" does not look like a scratch database.\n` +
            'This test clears app_state and student rows. Point DATABASE_URL at therapy_dev.\n');
        await pool.end();
        process.exit(1);
    }
}

async function clean() {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_plan_progress WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query('DELETE FROM students WHERE sdnevnik_id = ANY($1::bigint[])', [SDN_IDS]);
    await pool.query(`DELETE FROM plan_activities WHERE plan_id IN (SELECT id FROM plans WHERE sdnevnik_id = $1)`, [PLAN_SDN_ID]);
    await pool.query('DELETE FROM plans WHERE sdnevnik_id = $1', [PLAN_SDN_ID]);
    await pool.query(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
    await pool.query(`DELETE FROM assessments WHERE sdnevnik_id IN (8001, 8002)`);
    await pool.query(`DELETE FROM triage_tests WHERE sdnevnik_id = 8101`);
    await pool.query(`DELETE FROM scale_templates WHERE sdnevnik_id LIKE 'proba%'`);
    await pool.query('DELETE FROM audiograms');
}

async function seedRoster() {
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const s of FIXTURE.students) {
        const { rows } = await pool.query(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade) VALUES ($1,$2,$3,$4)
             ON CONFLICT (public_id) DO UPDATE SET sdnevnik_id = EXCLUDED.sdnevnik_id RETURNING id`,
            [s.rasporediStudentId, s.id, s.name, s.grade]);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [rows[0].id, yid, s.grade]);
    }
}

const run = async () => {
    await refuseUnlessScratch();
    await clean();
    await seedRoster();

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const page = await (await browser.newContext()).newPage();
    const diaryCalls = [];
    page.on('request', (r) => {
        if (/\/api\/diary\//.test(r.url()) && r.method() !== 'GET') diaryCalls.push(r.method() + ' ' + r.url());
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForTimeout(2500);

    // Deliberately NOT setting the flag. The server address is obvious (the
    // page is served by it), so the only thing between the app and the
    // per-mark endpoint is the flag itself.
    await page.evaluate(async (fixture) => {
        localStorage.removeItem('sdnevnik_row_writes_v1');
        localStorage.removeItem('sdnevnik_attendance_seen_v1');
        window.SdnV3.applyPayload(fixture);
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('test_seed'), 'test_seed');
    }, FIXTURE);
    await page.reload();
    await page.waitForTimeout(3000);

    console.log('\nflag off');
    const off = await page.evaluate(() => window.SDiary.enabled());
    check('the flag really is off', off === false);

    await page.evaluate((target) => {
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(target + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(9001, 'monday', 0);
    }, TARGET);
    await page.waitForTimeout(2500);

    // The week too (Stage E). One flag covers both collections, so the "off"
    // promise has to be checked against both or it only half holds.
    await page.evaluate(() => {
        window.currentWeek = 0;
        window.currentSlot = { day: 'friday', timeIdx: 4 };
        window.checkOrder = [9003];
        assignStudents();
    });
    await page.waitForTimeout(2500);

    // And the clinical records (Stage F). One flag governs all three
    // collections, so the "off" promise has to be checked against all three.
    await page.evaluate(() => {
        const r = (window.studentRecords || []).find((x) => x.id === 9001);
        if (r) r.opinion = 'Не смее да замине.';
        deleteProcenka(8002);
    });
    await page.waitForTimeout(2500);

    check('no per-mark, per-slot or per-record write ever leaves the browser',
        diaryCalls.length === 0, diaryCalls.join('\n       '));
    check('the deleted assessment is still in the database, because nothing was sent',
        (await pool.query('SELECT 1 FROM assessments WHERE sdnevnik_id = 8002')).rowCount === 1);
    const slot = await pool.query(
        `SELECT 1 FROM diary_schedule d JOIN students s ON s.id = d.student_id
           JOIN school_years y ON y.id = d.school_year_id AND y.is_current
          WHERE d.day = 'friday' AND d.position = 4`);
    check('and the term is not in the database either', slot.rowCount === 0);
    const localSlot = await page.evaluate(() => window.schedule?.friday?.[4] ?? null);
    check('but the diary kept the term, as it always did',
        Array.isArray(localSlot) && localSlot.length === 1, JSON.stringify(localSlot));
    const rows = await pool.query(
        `SELECT 1 FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE s.sdnevnik_id = 9001 AND a.date = $1`, [TARGET]);
    check('and the mark is not in the database', rows.rowCount === 0);

    const local = await page.evaluate((d) => {
        const m = window.attendance && window.attendance[d] && window.attendance[d]['9001'];
        return m && m['monday-0'] ? m['monday-0'].status : null;
    }, TARGET);
    check('but the diary kept it, exactly as it always did', local === 'present', String(local));

    // The old path in full: a whole-document save still decides everything.
    console.log('\nand the whole-document save still works as it always did');
    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(3000);

    const projected = await pool.query(
        `SELECT a.status FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE s.sdnevnik_id = 9001 AND a.date = $1`, [TARGET]);
    check('the document carried the mark into the database', projected.rows[0]?.status === 'present',
        JSON.stringify(projected.rows));

    const marker = await pool.query(`SELECT payload -> '_meta' -> 'rowWrites' AS m FROM app_state WHERE app = 'sdnevnik'`);
    check('and it announced no marker, so nothing was skipped',
        marker.rows[0]?.m == null, JSON.stringify(marker.rows[0]?.m));

    const progress = await pool.query(
        `SELECT count(*)::int AS n FROM student_plan_progress spp JOIN students s ON s.id = spp.student_id
          WHERE s.sdnevnik_id = 9001`);
    check('progress came from the document, as before', progress.rows[0].n > 0, JSON.stringify(progress.rows[0]));

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} FAILED\n` : '\nall assertions held\n');
    process.exit(fails ? 1 : 0);
};
run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
