/**
 * Stage E in a real browser, against the real server and database.
 *
 * The server test proved the endpoints. This proves the thing that actually
 * breaks: whether the APP notices a slot change and sends it. Every assertion
 * about a write reads the DATABASE, never the app's own opinion.
 *
 *     npm run start                          # in one terminal
 *     node test/diary-schedule.browser.mjs
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
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
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
    await pool.query(`DELETE FROM diary_schedule WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_plan_progress WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query('DELETE FROM students WHERE sdnevnik_id = ANY($1::bigint[])', [SDN_IDS]);
    await pool.query(`DELETE FROM plan_activities WHERE plan_id IN (SELECT id FROM plans WHERE sdnevnik_id = $1)`, [PLAN_SDN_ID]);
    await pool.query('DELETE FROM plans WHERE sdnevnik_id = $1', [PLAN_SDN_ID]);
    await pool.query(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
    await pool.query(`DELETE FROM diary_schedule_history WHERE school_year_id IN (SELECT id FROM school_years WHERE is_current)`);
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

const slotOf = async (day, position) => (await pool.query(
    `SELECT s.sdnevnik_id::text AS id FROM diary_schedule d
       JOIN students s ON s.id = d.student_id
       JOIN school_years y ON y.id = d.school_year_id AND y.is_current
      WHERE d.day = $1 AND d.position = $2 ORDER BY d.ordinal`, [day, position])).rows.map((r) => r.id);

const run = async () => {
    await refuseUnlessScratch();
    await clean();
    await seedRoster();

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());          // the app confirms and alerts

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForTimeout(2500);

    console.log('\nseeding the diary and saving once, flag off');
    await page.evaluate(async (fixture) => {
        window.SdnV3.applyPayload(fixture);
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('test_seed'), 'test_seed');
    }, FIXTURE);
    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(2500);
    checkEq('the ordinary save laid the week down', await slotOf('monday', 0), ['9001']);

    console.log('\nStage E on');
    await page.evaluate(() => {
        window.SDiary.enable();
        localStorage.removeItem('sdnevnik_attendance_seen_v1');
        localStorage.removeItem('sdnevnik_schedule_seen_v1');
        localStorage.removeItem('sdnevnik_schedule_history_sent_v1');
    });
    await page.reload();
    await page.waitForTimeout(3500);

    // ── An edit through the app's own path ──────────────────────────────────
    //
    // assignStudents() is what the assign modal's confirm button calls. It
    // reads `currentSlot` and `checkOrder`, which the modal fills in — so
    // setting those and calling it is the same code path a click takes, not a
    // fabricated one.
    console.log('\ntwo students put in one term, in the app');
    await page.evaluate(() => {
        window.currentWeek = 0;
        window.currentSlot = { day: 'wednesday', timeIdx: 3 };
        window.checkOrder = [9002, 9001];
        assignStudents();
    });
    await page.waitForTimeout(2500);
    checkEq('the pairing reached the DATABASE, in order', await slotOf('wednesday', 3), ['9002', '9001']);

    console.log('\nand the order is the therapist\'s, not the query\'s');
    await page.evaluate(() => {
        window.currentSlot = { day: 'wednesday', timeIdx: 3 };
        window.checkOrder = [9001, 9002];
        assignStudents();
    });
    await page.waitForTimeout(2500);
    checkEq('reversing them reverses the stored order', await slotOf('wednesday', 3), ['9001', '9002']);

    console.log('\nand emptying a term empties it');
    await page.evaluate(() => {
        window.currentSlot = { day: 'wednesday', timeIdx: 3 };
        window.checkOrder = [];
        assignStudents();
    });
    await page.waitForTimeout(2500);
    checkEq('the slot is empty in the database', await slotOf('wednesday', 3), []);

    // ── A whole-document save must not put the old week back ────────────────
    console.log('\nthe whole-document save no longer decides the week');
    await page.evaluate(() => {
        window.currentSlot = { day: 'friday', timeIdx: 0 };
        window.checkOrder = [9003];
        assignStudents();
    });
    await page.waitForTimeout(2500);
    checkEq('the new Friday term reached the database', await slotOf('friday', 0), ['9003']);

    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(3000);
    checkEq('and it SURVIVED a whole-document save', await slotOf('friday', 0), ['9003']);
    checkEq('while the fixture\'s Monday term is still there too', await slotOf('monday', 0), ['9001']);

    // Contains, not equals: the marker is a LIST that grows as collections
    // move, so pinning it to an exact set fails the day the next stage lands,
    // for no reason connected to the week. (Written as an equality first, and
    // it duly broke one stage later.)
    const marker = await pool.query(`SELECT payload -> '_meta' -> 'rowWrites' AS m FROM app_state WHERE app = 'sdnevnik'`);
    check('the document announced it no longer decides the week',
        Array.isArray(marker.rows[0]?.m) && marker.rows[0].m.includes('schedule'),
        JSON.stringify(marker.rows[0]?.m));

    // ── The other machine ───────────────────────────────────────────────────
    console.log('\na term added on the other machine arrives on opening');
    const res = await fetch(`${BASE}/api/diary/schedule/slot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: 'thursday', position: 4, students: [9002] })
    });
    check('the other machine\'s write is accepted', res.ok, String(res.status));

    await page.reload();
    await page.waitForTimeout(4500);
    const arrived = await page.evaluate(() => window.schedule?.thursday?.[4] ?? null);
    checkEq('the diary shows it after opening', arrived, [9002]);
    check('and as numbers, the way the app holds ids',
        Array.isArray(arrived) && typeof arrived[0] === 'number', JSON.stringify(arrived));

    // ── September, in the app ───────────────────────────────────────────────
    //
    // The year-end empties the week in place. With per-slot writes that is
    // twenty-five deletions, so the app must ask first — and be told no while
    // the database is still in the year being closed.
    console.log('\nSeptember: closing the year before rolling the database over');
    const weekBefore = (await pool.query(
        `SELECT count(*)::int AS n FROM diary_schedule d
           JOIN school_years y ON y.id = d.school_year_id AND y.is_current`)).rows[0].n;
    check('there is a week to lose', weekBefore > 0, `${weekBefore} rows`);

    const label = (await pool.query('SELECT label FROM school_years WHERE is_current')).rows[0].label;
    const refused = await page.evaluate((l) => window.SDiary.clearWeek(l), label);
    checkEq('the app is told no', refused, false);
    checkEq('and the week is untouched', (await pool.query(
        `SELECT count(*)::int AS n FROM diary_schedule d
           JOIN school_years y ON y.id = d.school_year_id AND y.is_current`)).rows[0].n, weekBefore);

    check('no page errors along the way', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
