/**
 * S-Дневник without its server, and back (4 Oct 2026, the reviewer's „diary
 * reliability" check): an edit made offline is kept, SAID to be waiting, kept
 * through a reopen, sent automatically once the connection returns, and then the server's
 * document, its tables and an already open second device all hold the same thing.
 * Also exercises in-flight edits, backup races, form deferral, stalled requests
 * and conflicts. No test writes a live diary.
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
    // Recorded as applied, as the installer does, or the server reports them pending and
    // every page opens behind its update notice.
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        await db.query(readFileSync(resolve(dir, f), 'utf8'));
        await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    }
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
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '', output = '', listening = false;
    serverProcess.stderr.on('data', (d) => { said += d; });
    // A healthy port might belong to somebody else's server. Only probe it
    // after OUR child reports that it successfully bound this exact address.
    serverProcess.stdout.on('data', (d) => {
        output += d;
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, end); output = output.slice(end + 1);
            try {
                const log = JSON.parse(line);
                if (log.pid === serverProcess.pid && log.msg === 'Server listening at ' + BASE) listening = true;
            } catch { /* only structured startup messages establish ownership */ }
        }
    });
    for (let i = 0; i < 60; i++) {
        try { if (listening && serverProcess.exitCode === null && (await fetch(BASE + '/api/health')).ok) return; } catch { /* not up yet */ }
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
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => localStorage.getItem('sdn_local_server_pending_v1') !== '1', null, { timeout: 15000 }).catch(() => {});
    now = await said(page);
    check('reconnecting sends it automatically, and the waiting is over', !now.pending && now.state === 'synced', JSON.stringify(now));
    // Continue the other assertions on the old implementation too, so a failure
    // of reconnect does not obscure document/table or duplicate-write checks.
    if (now.pending) await page.click('.mtb-app-nav__retry');
    await page.waitForFunction(() => localStorage.getItem('sdn_local_server_pending_v1') !== '1');
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

    console.log('\nan edit while the previous send is still waiting for its acknowledgement');
    let acknowledge;
    const held = new Promise((resolve) => { acknowledge = resolve; });
    let received;
    const requestSeen = new Promise((resolve) => { received = resolve; });
    await page.route('**/api/state/sdnevnik', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        const response = await route.fetch();
        received();
        await held;
        await route.fulfill({ response });
    });
    await page.evaluate(([d, p, k]) => {
        attendance[d][p][k] = { status: 'absent' };
        saveData();
        window.__sendingDiary = SdnLocalSrv.sync({ auto: true });
    }, [TARGET, PUPIL, SLOT]);
    await requestSeen;
    await page.evaluate(([d, p, k]) => {
        attendance[d][p][k] = { status: 'present' };
        saveData();
    }, [TARGET, PUPIL, SLOT]);
    // Let the five-second save timer fire while sync is busy.
    await page.waitForTimeout(5500);
    acknowledge();
    await page.evaluate(() => window.__sendingDiary);
    check('the acknowledgement of the older edit does not mark the newer edit as saved', (await said(page)).pending);
    await page.unroute('**/api/state/sdnevnik');
    await page.waitForFunction(() => localStorage.getItem('sdn_local_server_pending_v1') !== '1', null, { timeout: 12000 }).catch(() => {});
    check('the edit made during the send is sent automatically too',
        !((await said(page)).pending) && (await markInTable())[0]?.status === 'present');

    console.log('\nan already open second device follows the server without reopening');
    await page.evaluate(([d, p, k]) => {
        attendance[d][p][k] = { status: 'absent' };
        saveData();
    }, [TARGET, PUPIL, SLOT]);
    await page.waitForFunction(() => localStorage.getItem('sdn_local_server_pending_v1') !== '1', null, { timeout: 15000 });
    await other.waitForFunction(([d, p, k]) => attendance[d]?.[p]?.[k]?.status === 'absent', [TARGET, PUPIL, SLOT], { timeout: 40000 }).catch(() => {});
    check('the open second device receives the edit automatically', (await markInPage(other)) === 'absent');

    console.log('\na local edit while a background pull is making its backup');
    await page.evaluate(() => SdnLocalSrv.setAuto(false));
    await other.evaluate(() => SdnLocalSrv.setAuto(false));
    await other.evaluate(async ([d, p, k]) => {
        attendance[d][p][k] = { status: 'present' };
        saveData();
        await SdnLocalSrv.sync();
    }, [TARGET, PUPIL, SLOT]);
    const deferred = await page.evaluate(async () => {
        const modal = document.getElementById('addStudentModal');
        modal.classList.add('active');
        const result = await SdnLocalSrv.sync({ auto: true });
        modal.classList.remove('active');
        return result;
    });
    check('background refresh waits for an open edit form', deferred === 'editing' && (await markInPage(page)) === 'absent');
    await page.evaluate(() => {
        const original = SdnV3.backup;
        SdnV3.backup = async (...args) => {
            await original(...args);
            await new Promise((resolve) => { window.__finishPullBackup = resolve; });
            SdnV3.backup = original;
        };
        window.__pullingDiary = SdnLocalSrv.sync({ auto: true });
    });
    await page.waitForFunction(() => typeof window.__finishPullBackup === 'function');
    await page.evaluate(([d, p, k]) => {
        delete attendance[d][p][k];
        saveData();
        window.__finishPullBackup();
    }, [TARGET, PUPIL, SLOT]);
    await page.evaluate(() => window.__pullingDiary);
    check('a new local edit survives the asynchronous backup and stays pending',
        (await markInPage(page)) === null && (await said(page)).pending);
    const remoteVersion = (await stored()).version;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1000);
    check('automatic sync switched off remains off on reconnect', (await stored()).version === remoteVersion);
    const conflict = await page.evaluate(() => SdnLocalSrv.sync({ auto: true }));
    check('different edits on both devices still stop as a conflict', conflict === 'conflict');
    check('neither side is overwritten by the conflict',
        (await markInPage(page)) === null && (await markInTable())[0]?.status === 'present');

    console.log('\na server which accepts a connection but never answers');
    await page.route('**/api/state/sdnevnik', () => {});
    const timedOut = await page.evaluate(() => SdnLocalSrv.sync({ auto: true }));
    check('a stalled request times out and leaves the local work pending', timedOut === 'offline' && (await said(page)).pending);
    await page.unroute('**/api/state/sdnevnik');
    check('the next attempt is not stuck busy', (await page.evaluate(() => SdnLocalSrv.sync({ auto: true }))) === 'conflict');

    // 7 Oct 2026: the owner marks on the computer and on the phone in one day.
    // Different marks are joined; the same mark with two answers, a change to the
    // rest of the diary on both sides, or no remembered base still stop.
    console.log('\ndifferent marks on two devices are joined');
    const SECOND = 9002;                    // one of four activities credited in the sample
    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const dateOf = (day) => { const d = new Date(TARGET + 'T12:00:00'); d.setDate(d.getDate() + day); return d.toISOString().slice(0, 10); };
    const tap = (p, day) => p.evaluate(([target, pupil, name]) => {
        const here = mondayOf(new Date());
        const there = mondayOf(new Date(target + 'T12:00:00'));
        window.currentWeek = Math.round((there - here) / (7 * 24 * 3600 * 1000));
        toggleAttendance(pupil, name, 1);               // the click: none → present → absent → none
    }, [TARGET, SECOND, DAYS[day]]);
    const seenAt = (p, day) => p.evaluate(([d, pupil, k]) => {
        const m = window.attendance?.[d]?.[String(pupil)]?.[k];
        return m ? (typeof m === 'string' ? m : m.status) : null;
    }, [dateOf(day), SECOND, `${DAYS[day]}-1`]);
    const tableAt = async (day) => (await db.query(
        `SELECT a.status FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE s.sdnevnik_id = $1 AND a.date = $2 AND a.slot_key = $3`, [SECOND, dateOf(day), `${DAYS[day]}-1`])).rows[0]?.status ?? null;
    const credited = (p) => p.evaluate((pupil) => ((window.studentProgress[pupil] || {})[7001] || []).length, SECOND);
    const planName = (p) => p.evaluate(() => window.plans[0].name);
    const rename = (p, name) => p.evaluate((n) => { window.plans[0].name = n; saveData(); }, name);
    const syncNow = (p) => p.evaluate(() => SdnLocalSrv.sync({ auto: true }));

    // Out of the conflict above the way a person leaves it: this device takes the server's.
    await page.evaluate(() => SdnLocalSrv.pull());
    const level = [await syncNow(page), await syncNow(other)];
    check('both devices start from the same diary', level.every((r) => r === 'insync'), level.join(', '));

    // The sixth hour (7 Oct 2026): every document saved before it has five. The diary adds an
    // empty sixth when it loads one; that must not read as a change, here or on the server.
    const five = (await stored()).payload;
    for (const day of Object.keys(five.schedule)) five.schedule[day] = five.schedule[day].slice(0, 5);
    await db.query(`UPDATE app_state SET payload = $1 WHERE app = 'sdnevnik'`, [JSON.stringify(five)]);
    const fiveVersion = (await stored()).version;
    const withFive = await syncNow(page);
    check('a server document with five hours is the same diary as this one with an empty sixth',
        withFive === 'insync' && (await stored()).version === fiveVersion && (await stored()).payload.schedule.monday.length === 5
        && await page.evaluate(() => timeSlots.length === 6 && schedule.monday.length === 6), withFive);
    const start = await credited(page);

    await tap(page, 1);                                  // Tuesday here
    await tap(other, 2);                                 // Wednesday on the other device
    check('the other device sends its mark first', (await syncNow(other)) === 'pushed');
    let joined = await syncNow(page);
    check('this device joins the two instead of stopping', joined === 'pushed', `${joined}: ${(await said(page)).text}`);
    check('it holds both marks', (await seenAt(page, 1)) === 'present' && (await seenAt(page, 2)) === 'present');
    check('and so does the table', (await tableAt(1)) === 'present' && (await tableAt(2)) === 'present');
    check('progress was credited for both sessions, once each', (await credited(page)) === start + 2, `${start} → ${await credited(page)}`);
    check('nothing is left waiting', !(await said(page)).pending);
    check('the other device then only has to pull', (await syncNow(other)) === 'pulled'
        && (await seenAt(other, 1)) === 'present' && (await credited(other)) === start + 2);
    let both = await diaryAgreement(db, (await stored()).payload);
    check('the document and the tables still agree', !both.marksOnlyInDocument.length && !both.marksOnlyInTable.length && !both.marksDifferent.length, JSON.stringify(both));

    console.log('\na mark here, and the rest of the diary changed on the other device');
    await rename(other, 'Проба програма (изменета)');
    await tap(other, 3);                                 // Thursday there
    check('the other device sends both', (await syncNow(other)) === 'pushed');
    await tap(page, 4);                                  // Friday here
    joined = await syncNow(page);
    check('the server\'s diary is taken whole and this device\'s mark is put on top', joined === 'pushed'
        && (await planName(page)) === 'Проба програма (изменета)'
        && (await seenAt(page, 3)) === 'present' && (await seenAt(page, 4)) === 'present', `${joined}: ${(await said(page)).text}`);
    check('the table has both', (await tableAt(3)) === 'present' && (await tableAt(4)) === 'present');
    check('the other device pulls the mark', (await syncNow(other)) === 'pulled' && (await seenAt(other, 4)) === 'present');

    console.log('\nthe rest of the diary changed here, and a mark on the other device');
    await tap(other, 1);                                 // Tuesday: present → absent
    check('the other device sends it', (await syncNow(other)) === 'pushed');
    const beforeUncredit = await credited(page);
    await rename(page, 'Проба програма (втора измена)');
    joined = await syncNow(page);
    check('this diary stays whole and takes the other device\'s mark', joined === 'pushed'
        && (await planName(page)) === 'Проба програма (втора измена)' && (await seenAt(page, 1)) === 'absent', `${joined}: ${(await said(page)).text}`);
    check('the session it no longer counts is taken off the progress', (await credited(page)) === beforeUncredit - 1, `${beforeUncredit} → ${await credited(page)}`);
    check('the other device pulls the renamed plan', (await syncNow(other)) === 'pulled' && (await planName(other)) === 'Проба програма (втора измена)');

    console.log('\nthe same change to the rest of the diary on both devices, and a mark on each');
    await rename(other, 'Проба програма (иста на двата)');
    await tap(other, 1);                                 // Tuesday: absent → none
    check('the other device sends its side', (await syncNow(other)) === 'pushed');
    await rename(page, 'Проба програма (иста на двата)');
    await tap(page, 4);                                  // Friday: present → absent
    joined = await syncNow(page);
    check('there is nothing to choose between, so the marks are joined', joined === 'pushed'
        && (await seenAt(page, 1)) === null && (await seenAt(page, 4)) === 'absent' && (await tableAt(4)) === 'absent', `${joined}: ${(await said(page)).text}`);
    check('the other device pulls it', (await syncNow(other)) === 'pulled' && (await seenAt(other, 4)) === 'absent');

    console.log('\nwhat still stops');
    await page.evaluate(() => localStorage.removeItem('sdn_local_server_agreed_marks_v1'));
    await tap(other, 0);                                 // Monday there
    await syncNow(other);
    await tap(page, 3);                                  // Thursday here: present → absent
    check('a device with no remembered base does not guess', (await syncNow(page)) === 'conflict'
        && (await seenAt(page, 0)) === null && (await tableAt(3)) === 'present');
    await page.evaluate(() => SdnLocalSrv.pull());
    await syncNow(page);

    await tap(other, 2);                                 // Wednesday: present → absent
    await syncNow(other);
    await tap(page, 2); await tap(page, 2);              // the same mark here: present → absent → none
    check('the same mark with two answers stops', (await syncNow(page)) === 'conflict'
        && (await seenAt(page, 2)) === null && (await tableAt(2)) === 'absent');
    await page.evaluate(() => SdnLocalSrv.pull());
    await syncNow(page);

    await rename(other, 'Проба програма (таму)');
    await tap(other, 4);
    await syncNow(other);
    await rename(page, 'Проба програма (тука)');
    await tap(page, 0);
    check('the rest of the diary changed on both sides stops', (await syncNow(page)) === 'conflict'
        && (await planName(page)) === 'Проба програма (тука)' && (await stored()).payload.plans[0].name === 'Проба програма (таму)');

    check('no page errors', errors.length === 0, errors.join('\n       '));
}

try { await run(); }
catch (err) { fails++; console.error(err); }
finally { await tearDown(); }
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
