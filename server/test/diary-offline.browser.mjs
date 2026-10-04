/**
 * S-Дневник without its server, and back (4 Oct 2026, the reviewer's „diary
 * reliability" check): an edit made offline is kept, SAID to be waiting, kept
 * through a reopen, sent once the server answers, and then the server's
 * document, its tables and a second device all hold the same thing.
 *
 * Self-contained, so it cannot reach real data by construction: it makes its
 * own schema in the configured database, applies every migration there,
 * starts its OWN server on a spare port whose every connection is pinned to
 * that schema (`search_path`), drives the real app against it with the
 * anonymized sample diary (rule 1), then stops the server and drops the
 * schema. Nothing outside the schema is written; no app_state of the real
 * diary is read or touched.
 *
 *     npm run test:diary-offline
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const PORT = Number(process.env.DIARY_OFFLINE_PORT || 3091);
const BASE = `http://127.0.0.1:${PORT}`;
const SCHEMA = `diary_offline_test_${process.pid}`;
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, '../../sample-data/anonymized/diary-sample.json'), 'utf8'));
const TARGET = '2026-05-18';            // a Monday the sample diary has nothing for
const PUPIL = 9001, SLOT = 'monday-0';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

// DATE as the plain string the app writes, as src/db.ts does (CLAUDE.md, „Dates"):
// without it every mark compares as a local-midnight Date and nothing agrees.
pg.types.setTypeParser(1082, (value) => value);
const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!base) throw new Error('Configure a database connection (DATABASE_URL).');
const scoped = new URL(base);
scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
const admin = new pg.Client({ connectionString: base });
let db, serverProcess, browser;

async function setUp() {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    db = new pg.Pool({ connectionString: scoped.href });
    const where = (await db.query('SELECT current_schema() AS s')).rows[0].s;
    if (where !== SCHEMA) throw new Error(`refusing: connections resolve to ${where}, not ${SCHEMA}`);
    const dir = resolve(SERVER_DIR, '../database/migrations');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
    // The roster rows the sample diary's pupils link to, as diary-write.browser.mjs seeds them.
    const year = (await db.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const s of FIXTURE.students) {
        const id = (await db.query(
            'INSERT INTO students (public_id, sdnevnik_id, name, grade) VALUES ($1,$2,$3,$4) RETURNING id',
            [s.rasporediStudentId, s.id, s.name, s.grade])).rows[0].id;
        await db.query('INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)', [id, year, s.grade]);
    }
    // Its own server, every connection pinned to the schema. Output is not
    // kept: the request log would only bury the checks.
    serverProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, DATABASE_URL: scoped.href, PORT: String(PORT), HOST: '127.0.0.1', MTB_CLOUD_AUTH: 'off', MTB_REQUIRE_SIGNIN: '' },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let said = '';
    serverProcess.stderr.on('data', (d) => { said += d; });
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* not up yet */ }
        if (serverProcess.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('the test server did not start:\n' + said.slice(-2000));
}

async function tearDown() {
    if (browser) await browser.close().catch(() => {});
    if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
    if (db) await db.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => console.error('could not drop', SCHEMA, e.message));
    await admin.end().catch(() => {});
}

const stored = async () => (await db.query(`SELECT version, payload FROM app_state WHERE app = 'sdnevnik'`)).rows[0] || null;
const markInTable = async () => (await db.query(
    `SELECT a.status, a.time_slot FROM attendance a JOIN students s ON s.id = a.student_id
      WHERE s.sdnevnik_id = $1 AND a.date = $2 AND a.slot_key = $3`, [PUPIL, TARGET, SLOT])).rows;
const markInPage = (page) => page.evaluate(([d, p, k]) => {
    const m = window.attendance && window.attendance[d] && window.attendance[d][String(p)];
    return m && m[k] ? (typeof m[k] === 'string' ? m[k] : m[k].status) : null;
}, [TARGET, PUPIL, SLOT]);
const said = (page) => page.evaluate(() => {
    const pill = document.querySelector('.mtb-app-nav__status--data');
    return {
        pending: localStorage.getItem('sdn_local_server_pending_v1') === '1',
        state: (window.__MTB_DATA_STATE__ || {}).state || '',
        text: (window.__MTB_DATA_STATE__ || {}).text || '',
        pill: pill ? pill.dataset.state : '',
        retry: Boolean(document.querySelector('.mtb-app-nav__retry'))
    };
});
const ready = (page) => page.waitForFunction(() => window.SdnLocalSrv && window.SdnV3 && typeof window.toggleAttendance === 'function', null, { timeout: 15000 });

async function run() {
    await setUp();
    browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const errors = [];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));

    console.log('\nthe diary, saved and synced once');
    await page.goto(`${BASE}/S-Dnevnik.html`);
    await ready(page);
    await page.waitForTimeout(1500);
    await page.evaluate(async (fixture) => {
        window.SdnV3.applyPayload(fixture);
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('test_seed'), 'test_seed');
    }, FIXTURE);
    const first = await page.evaluate(() => window.SdnLocalSrv.sync({ auto: false }));
    check('the first sync puts it on the server', first === 'pushed', `${first}: ${(await said(page)).text}`);
    const before = await stored();
    check('the server holds it, and has nothing for the day yet', before && !(await markInTable()).length);

    console.log('\nthe server stops answering');
    await ctx.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.evaluate(([target, pupil]) => {
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(target + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(pupil, 'monday', 0);          // what the cell's click calls
    }, [TARGET, PUPIL]);
    check('a mark made now is kept here', (await markInPage(page)) === 'present');
    check('and is at once said to be waiting', (await said(page)).pending);
    // The automatic push comes 5 s after an edit; it fails, and must say so.
    await page.waitForFunction(() => /не е достапен/.test((window.__MTB_DATA_STATE__ || {}).text || ''), null, { timeout: 15000 }).catch(() => {});
    let now = await said(page);
    check('the failed push is visible: the server is not there and the change waits',
        now.pending && now.state === 'pending' && /не е достапен/.test(now.text), JSON.stringify(now));
    check('in the shared bar too, with ↻ to try again', now.pill === 'pending' && now.retry, JSON.stringify(now));
    check('nothing reached the server', (await stored()).version === before.version && !(await markInTable()).length);

    console.log('\nreopened while the server is still away');
    await page.reload();
    await ready(page);
    await page.waitForFunction(() => /не е достапен/.test((window.__MTB_DATA_STATE__ || {}).text || ''), null, { timeout: 15000 }).catch(() => {});
    check('the mark survived the reopen', (await markInPage(page)) === 'present');
    now = await said(page);
    check('and it still says it is waiting', now.pending && now.state === 'pending', JSON.stringify(now));

    console.log('\nthe server answers again');
    await ctx.unroute('**/api/**');
    await page.click('.mtb-app-nav__retry');
    await page.waitForFunction(() => localStorage.getItem('sdn_local_server_pending_v1') !== '1', null, { timeout: 15000 }).catch(() => {});
    now = await said(page);
    check('↻ sends it, and the waiting is over', !now.pending && now.state === 'synced', JSON.stringify(now));
    const after = await stored();
    const docMark = after.payload.attendance?.[TARGET]?.[String(PUPIL)]?.[SLOT];
    check('the server\'s document has the mark, in one new version',
        after.version === before.version + 1 && (docMark?.status || docMark) === 'present', `v${before.version} → v${after.version}, ${JSON.stringify(docMark)}`);
    const rows = await markInTable();
    check('and so does its table, with the time', rows.length === 1 && rows[0].status === 'present' && Boolean(rows[0].time_slot), JSON.stringify(rows));
    const { diaryAgreement } = await import('../src/lib/merge-diary-pupils.ts');
    const agree = await diaryAgreement(db, after.payload);
    check('the document and the tables agree, mark for mark and term for term (diary:check)',
        agree.linked === agree.pupils && !agree.marksOnlyInDocument.length && !agree.marksOnlyInTable.length
        && !agree.marksDifferent.length && !agree.termsDifferent.length,
        JSON.stringify(agree));

    console.log('\nreopened, here and on another device');
    await page.reload();
    await ready(page);
    await page.waitForFunction(() => /синхронизирано|вчитано/.test((window.__MTB_DATA_STATE__ || {}).text || ''), null, { timeout: 15000 }).catch(() => {});
    now = await said(page);
    check('here: the mark, nothing waiting, in step with the server', (await markInPage(page)) === 'present' && !now.pending && now.state === 'synced', JSON.stringify(now));
    check('and opening did not save again', (await stored()).version === after.version);
    const other = await (await browser.newContext()).newPage();
    other.on('pageerror', (e) => errors.push(String(e)));
    await other.goto(`${BASE}/S-Dnevnik.html`);
    await ready(other);
    await other.waitForFunction(() => /вчитано|синхронизирано/.test((window.__MTB_DATA_STATE__ || {}).text || ''), null, { timeout: 15000 }).catch(() => {});
    check('a new device pulls the diary with the mark', (await markInPage(other)) === 'present', JSON.stringify(await said(other)));
    check('without writing anything back', (await stored()).version === after.version);

    check('no page errors', errors.length === 0, errors.join('\n       '));
}

try { await run(); }
catch (err) { fails++; console.error(err); }
finally { await tearDown(); }
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
