/**
 * Stage C — the app reads the database when it opens.
 *
 * This is the most dangerous change in the project: it makes the server decide
 * what the therapist sees. If it is wrong she opens Rasporedi on Monday and her
 * week looks empty. So most of what is asserted here is what hydrate REFUSES to
 * do, not what it does.
 *
 *   API=http://127.0.0.1:3000 DATABASE_URL=… node test/hydrate.browser.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@localhost:5432/therapy_dev' });

const A = 'Хидрат Единечен';        // renamed on the server only
const B = 'Хидрат Двоен';           // renamed on BOTH sides — a real conflict
const C = 'Хидрат Само-Локален';    // exists only in the browser
const D = 'Хидрат Само-Серверски';  // exists only in the database
const THER = 'Хидрат Терапевт';

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };

// The app's own id formula, mirrored — the same one the server uses.
function stableStudentIdForName(name) {
    const text = String(name || '').normalize('NFKC').toLocaleLowerCase('mk-MK').trim();
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a ^= c; a = Math.imul(a, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ c) >>> 0;
    }
    return `RS-${a.toString(36)}-${b.toString(36)}`;
}

const NAMES = [A, B, C, D, A + ' (сервер)', B + ' (сервер)', B + ' (тука)'];

async function clean() {
    await pool.query(`DELETE FROM schedule_slots WHERE therapist_id IN (SELECT id FROM therapists WHERE name = $1)`, [THER]);
    await pool.query(`DELETE FROM therapist_students WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [NAMES]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE name = ANY($1::text[]))`, [NAMES]);
    await pool.query('DELETE FROM students WHERE name = ANY($1::text[])', [NAMES]);
    await pool.query('DELETE FROM therapists WHERE name = $1', [THER]);
}

async function seedServer() {
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const [name, id] of [[A, stableStudentIdForName(A)], [B, stableStudentIdForName(B)], [D, stableStudentIdForName(D)]]) {
        const r = await pool.query(
            `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, 'II-а')
             ON CONFLICT (public_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [id, name]);
        await pool.query(`INSERT INTO student_enrollments (student_id, school_year_id, grade)
                          VALUES ($1, $2, 'II-а') ON CONFLICT DO NOTHING`, [r.rows[0].id, yid]);
    }
    const therapist = await pool.query(
        'INSERT INTO therapists (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
        [THER]
    );
    await pool.query(
        `INSERT INTO therapist_years (school_year_id, therapist_id, active)
         VALUES ($1, $2, true)
         ON CONFLICT (school_year_id, therapist_id) DO UPDATE SET active = true`,
        [yid, therapist.rows[0].id]
    );
}

const openApp = async (page, { flag = true } = {}) => {
    await page.goto(BASE + '/Rasporedi.html');
    await page.waitForTimeout(1200);
    await page.evaluate(({ srv, flag }) => {
        if (flag) localStorage.setItem('rasporedi_slot_writes_v1', 'on');
        else localStorage.removeItem('rasporedi_slot_writes_v1');
        localStorage.setItem('local_server_url_v1', srv);
    }, { srv: BASE, flag });
};

const run = async () => {
    await clean();
    await seedServer();
    const directoryStudents = await (await fetch(BASE + '/api/students?includeInactive=1')).json();
    const directoryTherapists = await (await fetch(BASE + '/api/therapists?includeInactive=1')).json();
    check('the API marks the server-only student active in this year',
        directoryStudents.some((s) => s.name === D && s.active_this_year === true), JSON.stringify(directoryStudents));
    check('the API marks the fixture therapist active in this year',
        directoryTherapists.some((t) => t.name === THER && t.active_this_year === true), JSON.stringify(directoryTherapists));
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await openApp(page);

    // Give the browser the same three students, so `seen` records that the two
    // sides agreed — that record is what makes the rules below decidable.
    console.log('\nfirst open — the two sides agree');
    await page.reload();
    await page.waitForTimeout(1000);
    await page.evaluate(({ a, b, c, t }) => {
        [a, b, c].forEach((n) => {
            if (!students.includes(n)) students.push(n);
            studentMeta[n] = { grade: 'II-а', category: '', school: '' };
        });
        if (!therapists.includes(t)) therapists.push(t);
        ensureStudentMeta();
        saveScheduleToLocal();
    }, { a: A, b: B, c: C, t: THER });
    await page.waitForTimeout(3000);
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(3000);

    const seenAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('rasporedi_roster_seen_v1') || '{}'));
    check('the browser recorded what it agreed with the server',
        Object.keys(seenAfter.students || {}).length >= 3, JSON.stringify(Object.keys(seenAfter.students || {}).length));

    const localHasD = await page.evaluate((d) => students.includes(d), D);
    check('a student only the database had is brought in', localHasD === true,
        await page.evaluate(() => JSON.stringify(students)));

    const dbHasC = await pool.query('SELECT 1 FROM students WHERE name = $1', [C]);
    check('a student only the browser had is pushed up', dbHasC.rowCount === 1);

    // ── explicit yearly membership ───────────────────────────────────────
    console.log('\nan explicit yearly removal');
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    await pool.query(
        `UPDATE student_enrollments SET active = false
         WHERE school_year_id = $1 AND student_id = (SELECT id FROM students WHERE public_id = $2)`,
        [yid, stableStudentIdForName(D)]
    );
    await pool.query(
        `UPDATE therapist_years SET active = false
         WHERE school_year_id = $1 AND therapist_id = (SELECT id FROM therapists WHERE name = $2)`,
        [yid, THER]
    );
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(2500);
    check('a student explicitly inactive this year is removed from the local working list',
        await page.evaluate((name) => !students.includes(name), D));
    check('an explicitly inactive therapist is removed too',
        await page.evaluate((name) => !therapists.includes(name), THER),
        await page.evaluate(() => JSON.stringify(therapists)));

    // ── one side changed ──────────────────────────────────────────────────
    console.log('\none side changed');
    await pool.query('UPDATE students SET name = $2 WHERE public_id = $1', [stableStudentIdForName(A), A + ' (сервер)']);
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(2500);

    const tookIt = await page.evaluate((n) => students.includes(n), A + ' (сервер)');
    check('a rename made only on the server is taken', tookIt === true,
        await page.evaluate((a) => JSON.stringify(students.filter(s => s.startsWith(a.split(' ')[0]))), A));

    // ── both sides changed ────────────────────────────────────────────────
    console.log('\nboth sides changed — the case that must never be guessed');
    await pool.query('UPDATE students SET name = $2 WHERE public_id = $1', [stableStudentIdForName(B), B + ' (сервер)']);
    await page.evaluate((b) => {
        students = students.map(s => s === b ? b + ' (тука)' : s);
        studentMeta[b + ' (тука)'] = studentMeta[b] || {};
        delete studentMeta[b];
        scheduleData.students = students;
        saveScheduleToLocal();
    }, B);
    await page.waitForTimeout(1500);
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(2500);

    const keptMine = await page.evaluate((b) => students.includes(b + ' (тука)'), B);
    check('the local name is kept, not silently replaced', keptMine === true);
    const complained = await page.evaluate(() =>
        [...document.querySelectorAll('body *')].some(e => /сменето и на двете страни/.test(e.textContent || '')));
    check('and the person is told there is a divergence', complained === true,
        'the conflict was resolved silently — the one thing the project forbids');

    // ── the guards ────────────────────────────────────────────────────────
    console.log('\nwhat hydrate refuses');

    const before = await page.evaluate(() => students.length);
    await page.evaluate(() => {
        // Pretend the server answers with nothing at all.
        window.fetch = ((real) => (u, o) =>
            /\/api\/(students|therapists)/.test(String(u)) && (!o || !o.method || o.method === 'GET')
                ? Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
                : real(u, o))(window.fetch);
    });
    await page.evaluate(() => RSlots.hydrate());
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => students.length);
    check('an empty database does NOT empty the app', after === before,
        `${before} students before, ${after} after`);

    await page.reload();          // drop the stubbed fetch
    await page.waitForTimeout(2500);

    // ── flag off ──────────────────────────────────────────────────────────
    console.log('\nflag off');
    // A FRESH context: same-origin storage is shared, so reusing the first one
    // would carry the flag into the first page load and the requests it made
    // there would be counted against a run that is meant to make none.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    const calls = [];
    page2.on('request', (r) => { if (/\/api\/(students|therapists|schedule)/.test(r.url())) calls.push(r.method() + ' ' + r.url()); });
    await openApp(page2, { flag: false });
    await page2.reload();
    await page2.waitForTimeout(3000);
    check('the roster is never read from the database', calls.length === 0, calls.slice(0, 4).join('\n       '));

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} FAILED\n` : '\nall assertions held\n');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
