/**
 * What happens to a cell that does NOT get through, and to a rename that is
 * refused. Three regressions, all found by review before they were found by a
 * therapist:
 *
 *   1. Cells waiting to be sent lived only in memory. The app said "промените
 *      чекаат", a refresh threw the queue away, and hydrate then replaced the
 *      local week with the server's — so an edit made while the server was
 *      down disappeared, having been reported as safe.
 *   2. A 404 or a 500 for a cell was a `continue`, and the cell had already
 *      been taken out of the queue. One edit, gone for good, with a warning
 *      that reads like a warning rather than a loss.
 *   3. `renameLocally` correctly refuses to merge two students, but the caller
 *      ran on regardless: it wrote the OTHER student's `studentMeta.studentId`
 *      and recorded agreement in `seen`. Two people quietly folded into one row.
 *
 *     npm run start                              # in one terminal
 *     node test/rslots-recovery.browser.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@localhost:5432/therapy_dev'
});

const STUDENT = 'Опоравок Ученикоски';
const OTHER = 'Опоравок Другиот';
const THERAPIST = 'Опоравок Терапевт';
const DAY = 'Понеделник';
const TIME = '07:30';

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };

async function refuseUnlessScratch() {
    const { rows } = await pool.query('SELECT current_database() AS db');
    if (!/dev|test/i.test(String(rows[0].db))) {
        console.error(`\nRefusing to run against "${rows[0].db}".\n`);
        await pool.end(); process.exit(1);
    }
}

async function clean() {
    await pool.query(`DELETE FROM schedule_slots WHERE therapist_id IN (SELECT id FROM therapists WHERE name = $1)`, [THERAPIST]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [[STUDENT, OTHER]]);
    await pool.query(`DELETE FROM therapist_students WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [[STUDENT, OTHER]]);
    await pool.query('DELETE FROM students WHERE name = ANY($1::text[])', [[STUDENT, OTHER]]);
    await pool.query('DELETE FROM therapists WHERE name = $1', [THERAPIST]);
}

const slotStudent = async () => (await pool.query(
    `SELECT s.name FROM schedule_slots sl
       JOIN therapists t ON t.id = sl.therapist_id
       LEFT JOIN students s ON s.id = sl.student_id
      WHERE t.name = $1 AND sl.day = $2 AND sl.time_slot = $3`, [THERAPIST, DAY, TIME])).rows[0]?.name ?? null;

const queued = (page) => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('rasporedi_pending_slots_v1') || '[]'); }
    catch (e) { return null; }
});

const run = async () => {
    await refuseUnlessScratch();
    await clean();

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/Rasporedi.html`);
    await page.waitForTimeout(1500);
    await page.evaluate((srv) => {
        localStorage.setItem('rasporedi_slot_writes_v1', 'on');
        localStorage.setItem('local_server_url_v1', srv);
        localStorage.removeItem('rasporedi_roster_seen_v1');
        localStorage.removeItem('rasporedi_pending_slots_v1');
    }, BASE);
    await page.reload();
    await page.waitForTimeout(2500);

    // People first, so a cell naming them is legitimate.
    await page.evaluate(({ s, t }) => {
        document.getElementById('crudNewTherapistName').value = t;
        quickAddTherapistFromCrud();
        document.getElementById('quickStudentName').value = s;
        quickAddStudent();
    }, { s: STUDENT, t: THERAPIST });
    await page.waitForTimeout(2500);
    check('the people reached the database',
        (await pool.query('SELECT 1 FROM students WHERE name = $1', [STUDENT])).rowCount === 1);

    // ── 1. the server is unreachable ────────────────────────────────────────
    console.log('\nan edit made while the server is unreachable');
    await page.route('**/api/schedule/slot', (r) => r.abort());
    await page.evaluate(({ s, t, day, time }) => {
        applyAssignment(day, time, t, s);
        saveScheduleToLocal();
    }, { s: STUDENT, t: THERAPIST, day: DAY, time: TIME });
    await page.waitForTimeout(2000);

    check('it did not reach the database, as expected', (await slotStudent()) === null);
    let q = await queued(page);
    check('and it is written down on disk, not just in memory', Array.isArray(q) && q.length === 1, JSON.stringify(q));

    console.log('\nand it survives a refresh');
    await page.reload();
    await page.waitForTimeout(3000);
    q = await queued(page);
    check('the queue is still there after reopening the app', Array.isArray(q) && q.length === 1, JSON.stringify(q));

    console.log('\nand lands once the server answers again');
    await page.unroute('**/api/schedule/slot');
    await page.evaluate(() => RSlots.flush());
    await page.waitForTimeout(2500);
    check('the cell finally reached the database', (await slotStudent()) === STUDENT, String(await slotStudent()));
    q = await queued(page);
    check('and the queue is empty again', Array.isArray(q) && q.length === 0, JSON.stringify(q));

    // ── 2. the server answers 404 ───────────────────────────────────────────
    console.log('\na cell the server refuses with 404');
    let refusals = 0;
    await page.route('**/api/schedule/slot', (r) => {
        refusals++;
        return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not here yet"}' });
    });
    await page.evaluate(({ s, t, day }) => {
        applyAssignment(day, '07:35', t, s);
        saveScheduleToLocal();
    }, { s: STUDENT, t: THERAPIST, day: DAY });
    await page.waitForTimeout(2500);

    check('the server was asked', refusals > 0, String(refusals));
    q = await queued(page);
    check('the cell is kept, not thrown away', Array.isArray(q) && q.length === 1, JSON.stringify(q));
    check('and it counted the attempt', q?.[0]?.tries === 1, JSON.stringify(q?.[0]));

    await page.unroute('**/api/schedule/slot');
    await page.evaluate(() => RSlots.flush());
    await page.waitForTimeout(2500);
    const second = (await pool.query(
        `SELECT s.name FROM schedule_slots sl JOIN therapists t ON t.id = sl.therapist_id
           LEFT JOIN students s ON s.id = sl.student_id
          WHERE t.name = $1 AND sl.time_slot = '07:35'`, [THERAPIST])).rows[0]?.name ?? null;
    check('and it lands on the retry', second === STUDENT, String(second));

    // ── 3. a rename the app must refuse ─────────────────────────────────────
    //
    // The server says the student is now called what ANOTHER student here is
    // already called. renameLocally refuses to merge them; the question is
    // whether anything else ran anyway.
    console.log('\na rename onto a name this browser already uses');
    await page.evaluate((other) => {
        // A second student, purely local, holding the name the server is about
        // to hand to the first one.
        if (students.indexOf(other) === -1) students.push(other);
        studentMeta[other] = { studentId: 'RS-other-fixed', grade: 'IV-а', category: '', school: '' };
    }, OTHER);

    const publicId = (await pool.query('SELECT public_id FROM students WHERE name = $1', [STUDENT])).rows[0].public_id;
    await fetch(`${BASE}/api/students/${encodeURIComponent(publicId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: OTHER })
    });

    const before = await page.evaluate((o) => JSON.parse(JSON.stringify(studentMeta[o])), OTHER);
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(2500);

    const after = await page.evaluate((o) => JSON.parse(JSON.stringify(studentMeta[o])), OTHER);
    check('the other student\'s id was NOT taken over', after.studentId === before.studentId,
        `was ${before.studentId}, now ${after.studentId}`);
    check('and specifically not the renamed student\'s id', after.studentId !== publicId,
        `studentMeta["${OTHER}"].studentId === ${after.studentId}`);

    const seen = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('rasporedi_roster_seen_v1') || '{}'); } catch (e) { return {}; }
    });
    check('and no agreement was recorded for a rename that did not happen',
        !seen.students || !seen.students[publicId] || seen.students[publicId].name !== OTHER,
        JSON.stringify(seen.students?.[publicId]));

    check('no page errors along the way', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
