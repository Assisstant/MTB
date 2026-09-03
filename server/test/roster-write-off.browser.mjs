/**
 * The promise Stage B has to keep on Monday: with the flag off, NOTHING it
 * added exists. Every roster edit stays local, exactly as before.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const NAME = 'Исклучено Ученикоски';
const THER = 'Исклучено Терапевт';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@localhost:5432/therapy_dev' });

const SRV = BASE;

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };

const run = async () => {
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const page = await (await browser.newContext()).newPage();
    const calls = [];
    page.on('request', (r) => { if (/\/api\//.test(r.url()) && r.method() !== 'GET') calls.push(r.method() + ' ' + r.url()); });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(BASE + '/Rasporedi.html');
    await page.waitForTimeout(1500);
    // Deliberately NOT setting the flag. The server address is set, so the
    // only thing standing between the app and the database is the flag itself.
    await page.evaluate((srv) => {
        localStorage.removeItem('rasporedi_slot_writes_v1');
        localStorage.setItem('local_server_url_v1', srv);
    }, SRV);
    await page.reload();
    await page.waitForTimeout(2000);

    await page.evaluate(({ s, t }) => {
        document.getElementById('crudNewTherapistName').value = t;
        quickAddTherapistFromCrud();
        document.getElementById('quickStudentName').value = s;
        quickAddStudent();
        applyAssignment('Вторник', '10:00', t, s);
        saveScheduleToLocal();
    }, { s: NAME, t: THER });
    await page.waitForTimeout(2500);

    console.log('\nflag off');
    check('no write ever leaves the browser', calls.length === 0, calls.join('\n       '));
    const st = await pool.query('SELECT 1 FROM students WHERE name = $1', [NAME]);
    const th = await pool.query('SELECT 1 FROM therapists WHERE name = $1', [THER]);
    check('the student is not in the database', st.rowCount === 0);
    check('the therapist is not either', th.rowCount === 0);
    const local = await page.evaluate((s) => (JSON.parse(localStorage.getItem('therapistScheduleData_v2') || '{}').students || []).includes(s), NAME);
    check('but the app kept them locally, as it always did', local === true);
    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} FAILED\n` : '\nall assertions held\n');
    process.exit(fails ? 1 : 0);
};
run().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
