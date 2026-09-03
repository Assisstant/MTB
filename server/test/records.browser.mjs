/**
 * Stage F in a real browser, against the real server and database.
 *
 *     npm run start                     # in one terminal
 *     node test/records.browser.mjs
 *
 * Every assertion about a write reads the DATABASE, never the app's opinion.
 *
 * A note on how the edits are made. Stage F watches the five arrays and sends
 * what changed; it is deliberately indifferent to WHICH code path changed them,
 * which is the whole reason a diff was chosen over instrumenting call sites —
 * the dossier alone is edited from several screens. So where the app has a
 * single named function for the edit (deleteProcenka) this drives that; where
 * the edit is a form writing into the array, it changes the array and saves,
 * because that is precisely the contract under test.
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

async function refuseUnlessScratch() {
    const { rows } = await pool.query('SELECT current_database() AS db');
    const db = String(rows[0].db);
    if (!/dev|test/i.test(db)) {
        console.error(`\nRefusing to run: "${db}" does not look like a scratch database.\n`);
        await pool.end();
        process.exit(1);
    }
}

async function clean() {
    for (const t of ['assessments', 'triage_tests', 'student_records', 'attendance', 'student_plan_progress', 'diary_schedule', 'student_enrollments']) {
        await pool.query(`DELETE FROM ${t} WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    }
    await pool.query('DELETE FROM audiograms');
    await pool.query(`DELETE FROM scale_templates WHERE sdnevnik_id LIKE 'proba%'`);
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
            [s.rasporediStudentId, s.id, s.name, s.grade]);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [rows[0].id, yid, s.grade]);
    }
}

const scalar = async (sql, params = []) => (await pool.query(sql, params)).rows[0] ?? null;
const num = async (sql, params = []) => Number((await scalar(sql, params))?.n ?? 0);

const run = async () => {
    await refuseUnlessScratch();
    await clean();
    await seedRoster();

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForTimeout(2500);

    console.log('\nseeding the diary and saving once, flag off');
    await page.evaluate(async (fixture) => {
        window.SdnV3.applyPayload(fixture);
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('test_seed'), 'test_seed');
    }, FIXTURE);
    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(2500);
    checkEq('the ordinary save wrote the records', await num('SELECT count(*)::int AS n FROM assessments'), 2);

    console.log('\nStage F on');
    await page.evaluate(() => {
        window.SDiary.enable();
        ['sdnevnik_attendance_seen_v1', 'sdnevnik_schedule_seen_v1',
         'sdnevnik_schedule_history_sent_v1', 'sdnevnik_records_seen_v1'].forEach((k) => localStorage.removeItem(k));
    });
    await page.reload();
    await page.waitForTimeout(3500);

    // ── the dossier ─────────────────────────────────────────────────────────
    console.log('\nediting a dossier in the app');
    await page.evaluate(() => {
        const r = window.studentRecords.find((x) => x.id === 9001);
        r.opinion = 'Сменето мислење.';
        r.contact = '071111111';
        window.saveData();
    });
    await page.waitForTimeout(2500);
    const dossier = await scalar(
        `SELECT r.opinion, r.contact FROM student_records r
           JOIN students s ON s.id = r.student_id WHERE s.sdnevnik_id = 9001`);
    checkEq('the change reached the DATABASE', [dossier?.opinion, dossier?.contact],
        ['Сменето мислење.', '071111111']);

    // ── an assessment the therapist deletes ─────────────────────────────────
    console.log('\ndeleting an assessment through the app\'s own button');
    await page.evaluate(() => deleteProcenka(8002));
    await page.waitForTimeout(2500);
    checkEq('it is gone from the database too', await num('SELECT count(*)::int AS n FROM assessments'), 1);
    checkEq('and the other one is untouched',
        await num('SELECT count(*)::int AS n FROM assessments WHERE sdnevnik_id = 8001'), 1);

    // ── an audiogram added ──────────────────────────────────────────────────
    console.log('\nadding an audiogram');
    await page.evaluate(() => {
        window.audiogramRecords.push({
            subjectName: 'Проба Втора', date: '2026-06-01', recordType: 'history',
            rightAir: { '250': 10, '500': 15 }, rightBone: {}, leftAir: {}, leftBone: {}
        });
        window.saveData();
    });
    await page.waitForTimeout(2500);
    checkEq('three audiograms now', await num('SELECT count(*)::int AS n FROM audiograms'), 3);
    const added = await scalar(`SELECT sdnevnik_id, student_id FROM audiograms WHERE subject_name = 'Проба Втора'`);
    check('the app and the server agreed on its id',
        typeof added?.sdnevnik_id === 'string' && added.sdnevnik_id.startsWith('AG-'), JSON.stringify(added));
    check('and it was linked to the student of that name', added?.student_id != null, JSON.stringify(added));

    // Saving again must not create a second copy — the id is the content, so
    // an unchanged record is the same record.
    await page.evaluate(() => window.saveData());
    await page.waitForTimeout(2000);
    checkEq('saving again does not duplicate it', await num('SELECT count(*)::int AS n FROM audiograms'), 3);

    // ── a whole-document save must not undo any of it ───────────────────────
    console.log('\nthe whole-document save no longer decides the records');
    await page.evaluate(() => window.SdnLocalSrv.push());
    await page.waitForTimeout(3000);
    checkEq('the deleted assessment stays deleted', await num('SELECT count(*)::int AS n FROM assessments'), 1);
    checkEq('the added audiogram stays added', await num('SELECT count(*)::int AS n FROM audiograms'), 3);
    const stillEdited = await scalar(
        `SELECT r.opinion FROM student_records r JOIN students s ON s.id = r.student_id WHERE s.sdnevnik_id = 9001`);
    checkEq('and the edited dossier stays edited', stillEdited?.opinion, 'Сменето мислење.');

    const marker = await pool.query(`SELECT payload -> '_meta' -> 'rowWrites' AS m FROM app_state WHERE app = 'sdnevnik'`);
    checkEq('the document announced all three collections', marker.rows[0]?.m, ['attendance', 'schedule', 'records']);

    // ── the other machine ───────────────────────────────────────────────────
    console.log('\na record made on the other machine arrives on opening');
    const res = await fetch(`${BASE}/api/diary/record/triage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: 8202, sdnevnikId: 9002,
            test: { id: 8202, studentId: 9002, date: '2026-06-02', assessor: 'Друга Машина', assessments: { x: 1 } }
        })
    });
    check('the other machine\'s write is accepted', res.ok, String(res.status));

    await page.reload();
    await page.waitForTimeout(4500);
    const arrived = await page.evaluate(() =>
        (window.trijazenTestovi || []).filter((t) => String(t.id) === '8202').length);
    checkEq('the diary shows it after opening', arrived, 1);
    checkEq('and did not lose the one it already had',
        await page.evaluate(() => (window.trijazenTestovi || []).length), 2);

    check('no page errors along the way', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
