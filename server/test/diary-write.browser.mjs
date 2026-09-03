/**
 * Stage D in a real browser, against the real server and database.
 *
 * The server test proved the endpoints. This proves the thing that actually
 * breaks: whether the APP notices a mark and sends it. That is the same class
 * of bug as the S-Dnevnik wrapper that never ran — it looked like it worked,
 * because something else happened to sync afterwards. So every assertion about
 * a write reads the DATABASE, never the app's own opinion.
 *
 *     npm run start                       # in one terminal
 *     node test/diary-write.browser.mjs
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

let fails = 0;
const check = (label, cond, detail = '') => {
    if (cond) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

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
}

async function seedRoster() {
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const s of FIXTURE.students) {
        const { rows } = await pool.query(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade) VALUES ($1,$2,$3,$4)
             ON CONFLICT (public_id) DO UPDATE SET sdnevnik_id = EXCLUDED.sdnevnik_id RETURNING id`,
            [s.rasporediStudentId, s.id, s.name, s.grade]
        );
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [rows[0].id, yid, s.grade]
        );
    }
}

const markRows = async (sdnId, date) => (await pool.query(
    `SELECT a.slot_key, a.status, a.time_slot FROM attendance a JOIN students s ON s.id = a.student_id
      WHERE s.sdnevnik_id = $1 AND a.date = $2 ORDER BY a.slot_key`, [sdnId, date])).rows;

const credited = async (sdnId) => (await pool.query(
    `SELECT pa.position FROM student_plan_progress spp
       JOIN plan_activities pa ON pa.id = spp.activity_id
       JOIN students s ON s.id = spp.student_id
      WHERE s.sdnevnik_id = $1 ORDER BY pa.position`, [sdnId])).rows.map((r) => r.position);

const run = async () => {
    await refuseUnlessScratch();
    await clean();
    await seedRoster();

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForTimeout(2500);

    // ── Seed the diary the way a restore would, then save once with the flag
    //    OFF. That is also the real deployment order: the ordinary save is what
    //    puts the plan, its activities and the marks' TIMES into the database.
    console.log('\nseeding the diary and saving once, flag off');
    await page.evaluate(async (fixture) => {
        window.SdnV3.applyPayload(fixture);
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('test_seed'), 'test_seed');
    }, FIXTURE);
    await page.evaluate(() => { localStorage.setItem('sdn_local_server_autosync_v1', '1'); });
    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(2500);

    const acts = await pool.query(
        `SELECT count(*)::int AS n FROM plan_activities pa JOIN plans p ON p.id = pa.plan_id WHERE p.sdnevnik_id = $1`,
        [PLAN_SDN_ID]);
    check('the ordinary save projected the plan and its activities', acts.rows[0].n === 4, `found ${acts.rows[0].n}`);

    const seededMerged = await markRows(9001, '2026-05-12');
    check('and the merged term arrived with its time on both keys',
        seededMerged.length === 2 && seededMerged[0].time_slot && seededMerged[0].time_slot === seededMerged[1].time_slot,
        JSON.stringify(seededMerged));

    // ── Turn Stage D on the way the therapist would, and reload ─────────────
    console.log('\nStage D on');
    await page.evaluate(() => {
        window.SDiary.enable();
        localStorage.removeItem('sdnevnik_attendance_seen_v1');
    });
    await page.reload();
    await page.waitForTimeout(3500);

    const on = await page.evaluate(() => window.SDiary.enabled());
    check('the flag is on after the reload', on === true);

    // ── One click, in the app's own code path ──────────────────────────────
    console.log('\none click on a cell');
    const TARGET = '2026-05-18';           // a Monday, a week the diary has nothing for
    await page.evaluate((target) => {
        // Move to that week using the app's own Monday calculation — never a
        // hand-rolled one (CLAUDE.md: one Monday calculation, mondayOf).
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(target + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(9001, 'monday', 0);          // what the cell's click handler calls
    }, TARGET);
    await page.waitForTimeout(2500);

    let rows = await markRows(9001, TARGET);
    check('the click reached the DATABASE', rows.length === 1 && rows[0].status === 'present',
        JSON.stringify(rows));
    check('carrying the time, which is what makes it a session',
        rows[0]?.time_slot === '08:00-08:40', JSON.stringify(rows));
    check('and progress advanced to a third activity',
        JSON.stringify(await credited(9001)) === '[0,1,2]', JSON.stringify(await credited(9001)));

    // ── The second and third clicks ────────────────────────────────────────
    console.log('\nthe second and third clicks');
    await page.evaluate(() => toggleAttendance(9001, 'monday', 0));
    await page.waitForTimeout(2200);
    rows = await markRows(9001, TARGET);
    check('present → absent reaches the database', rows[0]?.status === 'absent', JSON.stringify(rows));
    check('and an absence is not a session, so the third activity goes back',
        JSON.stringify(await credited(9001)) === '[0,1]', JSON.stringify(await credited(9001)));

    await page.evaluate(() => toggleAttendance(9001, 'monday', 0));
    await page.waitForTimeout(2200);
    rows = await markRows(9001, TARGET);
    check('absent → not addressed removes the row', rows.length === 0, JSON.stringify(rows));

    // ── A whole-document save must not undo it ─────────────────────────────
    //
    // The fixture says Wednesday 13 May is an absence. Correct it with a click,
    // then make the app save the whole document. Before Stage D the document
    // would have put the absence straight back.
    console.log('\nthe whole-document save no longer decides attendance');
    await page.evaluate((target) => {
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(target + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(9001, 'wednesday', 1);      // absent → not addressed
        toggleAttendance(9001, 'wednesday', 1);      // → present
    }, '2026-05-13');
    await page.waitForTimeout(2500);
    let wed = await markRows(9001, '2026-05-13');
    check('the correction reached the database', wed[0]?.status === 'present', JSON.stringify(wed));

    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(3000);
    wed = await markRows(9001, '2026-05-13');
    check('and it SURVIVED a whole-document save', wed[0]?.status === 'present', JSON.stringify(wed));

    const marker = await pool.query(`SELECT payload -> '_meta' -> 'rowWrites' AS m FROM app_state WHERE app = 'sdnevnik'`);
    // Contains, not equals: the marker is a LIST that grows as collections
    // move, so pinning it to exactly one name would fail the day the next
    // stage lands — for no reason connected to attendance.
    check('the document told the server it no longer decides attendance',
        Array.isArray(marker.rows[0]?.m) && marker.rows[0].m.includes('attendance'),
        JSON.stringify(marker.rows[0]?.m));

    // ── The other machine ──────────────────────────────────────────────────
    console.log('\na mark made on the other machine arrives on opening');
    const OTHER = '2026-05-25';
    const res = await fetch(`${BASE}/api/diary/attendance`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdnevnikId: 9001, date: OTHER, slotKey: 'monday-0', status: 'present', time: '08:00-08:40' })
    });
    check('the other machine\'s write is accepted', res.ok, String(res.status));

    await page.reload();
    await page.waitForTimeout(4500);
    // Here the app IS the thing being tested — the question is whether it
    // received the mark, so its own state is the right place to look.
    const arrived = await page.evaluate((d) => {
        const m = window.attendance && window.attendance[d] && window.attendance[d]['9001'];
        return m ? m['monday-0'] : null;
    }, OTHER);
    check('the diary shows it after opening', arrived && arrived.status === 'present', JSON.stringify(arrived));

    const rebuilt = await page.evaluate(() => {
        const p = window.studentProgress && window.studentProgress['9001'] && window.studentProgress['9001']['7001'];
        return Array.isArray(p) ? p.map((e) => e.index) : null;
    });
    check('and the app rebuilt its own progress from it, rather than importing progress',
        JSON.stringify(rebuilt) === '[0,1,2,3]', JSON.stringify(rebuilt));
    check('the app and the server agree on the count',
        JSON.stringify(await credited(9001)) === JSON.stringify(rebuilt),
        `server ${JSON.stringify(await credited(9001))} vs app ${JSON.stringify(rebuilt)}`);

    // ── A mark removed here on purpose must not come back ──────────────────
    console.log('\nwhat was removed here on purpose stays removed');
    await page.evaluate((d) => {
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(d + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(9001, 'monday', 0);   // present → absent
        toggleAttendance(9001, 'monday', 0);   // absent → not addressed
    }, OTHER);
    await page.waitForTimeout(2500);
    check('the removal reached the database', (await markRows(9001, OTHER)).length === 0);

    await page.reload();
    await page.waitForTimeout(4500);
    const back = await page.evaluate((d) => {
        const m = window.attendance && window.attendance[d] && window.attendance[d]['9001'];
        return m ? m['monday-0'] : null;
    }, OTHER);
    check('and opening the app again does not resurrect it', !back, JSON.stringify(back));

    check('no page errors along the way', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
