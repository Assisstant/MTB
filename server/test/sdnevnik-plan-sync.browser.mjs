/**
 * Дневник ↔ Кабинети (S-Dnevnik.html, `SdnPlanSync`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing real can be read or written. The people are invented.
 *
 * What it holds the feature to:
 *   - nothing is written anywhere until „Примени", and „Остави" writes nothing;
 *   - Кабинети is written ONLY through PUT /api/schedule/block, with the
 *     diary's list and `expected` = what Кабинети held when the popup was drawn;
 *   - a refusal from that writer (the pupil is with another therapist then) is
 *     shown in words and leaves the popup open;
 *   - a pupil is recognised by the bridge or by the diary number the database
 *     keeps, never by name: an unlinked pupil cannot be sent, and a pupil the
 *     diary does not have cannot be taken;
 *   - an edit of an unlocked past week stays a record unless „Постојано" is
 *     chosen, and only then reaches the live plan and Кабинети.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// localhost, so the diary treats the page as served by its own server.
const SERVED = 'http://localhost:4610';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const ME = 'Измислен Терапевт Планов';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const payload = {
    students: [
        { id: 1001, name: 'Пробен Алфа', grade: 'V', kind: 'internal', rasporediStudentId: 'p-a', disabilityType: '', planId: 9001 },
        // No bridge in the diary: the database knows the diary's number.
        { id: 1002, name: 'Пробен Бета', grade: 'V', kind: 'internal', disabilityType: '', planId: 9001 },
        // Linked nowhere.
        { id: 1003, name: 'Пробен Гама', grade: 'VI', kind: 'internal', disabilityType: '', planId: 9001 },
        { id: 1004, name: 'Пробен Делта', grade: 'VI', kind: 'internal', rasporediStudentId: 'p-d', disabilityType: '', planId: 9001 }
    ],
    formerCaseloadStudents: [], schedule: emptyWeek(), scheduleHistory: {}, attendance: {},
    plans: [{ id: 9001, name: 'Пробна програма', activities: ['Активност'] }],
    links: [], studentProgress: {}, trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
};
payload.schedule.monday[0] = [1001];
payload.schedule.tuesday[1] = [1002, 1004];
payload.schedule.wednesday[2] = [1003];

const session = (day, time, pid, name) => ({ day, time, therapist_id: 7, therapist_name: ME, student_public_id: pid, student_name: name });
let sessions = [
    session('понеделник', '08:00-08:40', 'p-a', 'Пробен Алфа'),                 // the same
    session('вторник', '08:45-09:05', 'p-b', 'Пробен Бета'),                    // the same, as two halves
    session('вторник', '09:05-09:25', 'p-d', 'Пробен Делта'),
    session('четврток', '09:40-10:20', 'p-d', 'Пробен Делта'),                  // only in Кабинети
    session('петок', '08:00-08:40', 'p-x', 'Пробен Непознат'),                  // a pupil the diary does not have
    session('петок', '11:55-12:35', 'p-a', 'Пробен Алфа'),                      // a bell the diary does not have
    { day: 'понеделник', time: '08:00-08:40', therapist_id: 8, therapist_name: 'Друг Терапевт', student_public_id: 'p-z', student_name: 'Туѓ Ученик' }
];
const roster = {
    year: '1901/1902-plan',
    therapists: [{ id: 7, name: ME }, { id: 8, name: 'Друг Терапевт' }],
    students: [
        { public_id: 'p-a', sdnevnik_id: '1001', name: 'Пробен Алфа' },
        { public_id: 'p-b', sdnevnik_id: '1002', name: 'Пробен Бета' },
        { public_id: 'p-d', sdnevnik_id: null, name: 'Пробен Делта' },
        { public_id: 'p-x', sdnevnik_id: null, name: 'Пробен Непознат' }
    ]
};

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const writes = [];            // every non-GET the page sends
const blocks = [];            // the bodies sent to the block writer
let refuseNext = null;        // what the block writer answers next, when not 200
let health = null;            // what /api/health answers; null = the server is down
const dialogs = [];
const errors = [];

await context.addInitScript((me) => {
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
    localStorage.setItem('my_therapist_v1', me);
}, ME);
await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== SERVED) return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
        if (url.pathname === '/api/schedule/sessions') return json({ year: roster.year, sessions });
        if (url.pathname === '/api/roster') return json(roster);
        if (url.pathname === '/api/health') return health ? json(health) : json({ error: 'down' }, 503);
        if (url.pathname === '/api/schedule/block' && req.method() === 'PUT') {
            const body = req.postDataJSON();
            blocks.push(body);
            if (refuseNext) { const answer = refuseNext; refuseNext = null; return json(answer, 409); }
            // What the real writer does to the rows: one pupil owns the bell, two split it.
            const [h, m] = body.time.split('-')[0].split(':').map(Number);
            const at = (minutes) => `${String(Math.floor((h * 60 + m + minutes) / 60)).padStart(2, '0')}:${String((h * 60 + m + minutes) % 60).padStart(2, '0')}`;
            const times = [body.time, `${at(0)}-${at(20)}`, `${at(20)}-${at(40)}`];
            sessions = sessions.filter((s) => !(s.therapist_id === 7 && s.day === body.day && times.includes(s.time)));
            const nameOf = (pid) => roster.students.find((s) => s.public_id === pid).name;
            if (body.studentPublicIds.length === 1) sessions.push(session(body.day, times[0], body.studentPublicIds[0], nameOf(body.studentPublicIds[0])));
            else body.studentPublicIds.forEach((pid, i) => sessions.push(session(body.day, times[i + 1], pid, nameOf(pid))));
            return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
    if (name === 'mtb-runtime.js') return route.fulfill({ status: 200, contentType: TYPES['.js'], body: 'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;' });
    try {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body: await readFile(path.join(ROOT, name)) });
    } catch { return route.fulfill({ status: 404, body: '' }); }
});

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

const modalOpen = () => page.$eval('#planSyncModal', (m) => m.classList.contains('active'));
const rowsShown = () => page.$$eval('[data-plan-row]', (rows) => rows.map((r) => r.getAttribute('data-plan-row')));
const live = (day, slot) => page.evaluate(([d, s]) => window.schedule[d][s].slice(), [day, slot]);
const choose = (key, value) => page.selectOption(`[data-plan-choice="${key}"]`, value);
const apply = () => page.click('#planSyncApply');
const waitClosed = () => page.waitForFunction(() => !document.getElementById('planSyncModal').classList.contains('active'));
const waitOpen = () => page.waitForFunction(() => document.getElementById('planSyncModal').classList.contains('active'));
/** The diary's own edit path: the assign popup, a tick, „Зачувај". */
const edit = async (day, slot, toggleIds) => {
    await page.evaluate(([d, s]) => window.openAssignModal(d, s), [day, slot]);
    await page.waitForTimeout(50);       // the popup attaches its listeners on the next tick
    for (const id of toggleIds) await page.click(`#cb-${id}`);
    await page.evaluate(() => window.assignStudents());
};

try {
    console.log('\nДневник ↔ Кабинети');
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SdnPlanSync && window.SDiary);
    await page.evaluate((p) => {
        localStorage.removeItem('sdnevnik_row_writes_v1');
        window.SdnV3.applyPayload(p);
        if (typeof window.renderAll === 'function') window.renderAll();
    }, payload);
    writes.length = 0;

    // ── on opening, a difference nobody has seen yet is shown ─────────────────
    console.log('\nopening the diary');
    await waitOpen();
    checkEq('the popup lists exactly the terms that differ', await rowsShown(), ['2|2', '3|2', '4|0']);
    check('the same pupil as two halves, or known only by the diary number, is not a difference',
        !(await rowsShown()).includes('0|0') && !(await rowsShown()).includes('1|1'));
    check('a bell the diary does not have is counted, not compared',
        /уште 1 термин/.test(await page.textContent('#planSyncNote')));
    check('an unlinked pupil cannot be sent to Кабинети, and the popup says why',
        await page.$eval('[data-plan-choice="2|2"] option[value="push"]', (o) => o.disabled)
        && /не е поврзан со базата/.test(await page.textContent('[data-plan-row="2|2"]')));
    check('a pupil the diary does not have cannot be taken, and the popup says why',
        await page.$eval('[data-plan-choice="4|0"] option[value="take"]', (o) => o.disabled)
        && /го нема во „Мои ученици“/.test(await page.textContent('[data-plan-row="4|0"]')));
    // PLAN_SHOTS=<folder> keeps a picture of the popup in both themes (invented people only).
    if (process.env.PLAN_SHOTS) {
        await page.screenshot({ path: path.join(process.env.PLAN_SHOTS, 'plan-sync-light.png') });
        await page.evaluate(() => document.body.classList.add('dark-mode'));
        await page.screenshot({ path: path.join(process.env.PLAN_SHOTS, 'plan-sync-dark.png') });
        await page.evaluate(() => document.body.classList.remove('dark-mode'));
    }
    checkEq('every decision starts at „Остави"', await page.$$eval('[data-plan-choice]', (s) => s.map((x) => x.value)), ['leave', 'leave', 'leave']);
    await apply();
    await waitClosed();
    checkEq('„Остави" writes nothing', writes, []);
    check('the button keeps saying how many differ', /3 разлики/.test(await page.textContent('#planSyncBtn')));

    // ── the same difference is not pushed at the person twice ─────────────────
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
    check('a difference already seen does not reopen the popup by itself', !(await modalOpen()));

    // ── taking one term from Кабинети ─────────────────────────────────────────
    console.log('\ntaking a term from Кабинети');
    await page.click('#planSyncBtn');
    await waitOpen();
    await choose('3|2', 'take');
    await apply();
    await page.waitForFunction(() => !document.querySelector('[data-plan-row="3|2"]'));
    checkEq('the diary now holds that pupil in that term', await live('thursday', 2), [1004]);
    checkEq('and Кабинети was not written', blocks.length, 0);
    check('the popup stays for what is still different', await modalOpen() && (await rowsShown()).length === 2);
    await page.click('#planSyncClose');

    // ── an edit of the current week asks, and goes through the one writer ────
    console.log('\nan edit in the current week');
    await edit('monday', 0, [1004]);
    await waitOpen();
    checkEq('the edited term is offered as permanent', await page.$eval('[data-plan-choice="0|0"]', (s) => s.value), 'push');
    checkEq('the other differences stay at „Остави"', await page.$eval('[data-plan-choice="2|2"]', (s) => s.value), 'leave');
    refuseNext = { error: 'that student already has an overlapping session', doubleBooked: true,
        therapistId: 8, therapistName: 'Друг Терапевт', time: '08:00-08:20', studentPublicId: 'p-d', studentName: 'Пробен Делта' };
    await apply();
    await page.waitForSelector('[data-plan-row="0|0"] .plan-sync-result.bad');
    check('a clash is told in words: who has the pupil, and when',
        /Пробен Делта веќе е кај Друг Терапевт во 08:00-08:20/.test(await page.textContent('[data-plan-row="0|0"] .plan-sync-result')));
    check('and the popup stays open', await modalOpen());
    checkEq('the diary keeps the edit either way', await live('monday', 0), [1001, 1004]);

    await choose('0|0', 'push');
    await apply();
    await page.waitForFunction(() => !document.querySelector('[data-plan-row="0|0"]'));
    checkEq('Кабинети is written through the block writer, with what it held before', blocks[blocks.length - 1],
        { day: 'понеделник', time: '08:00-08:40', therapistId: 7, studentPublicIds: ['p-a', 'p-d'], expectedStudentPublicIds: ['p-a'] });
    checkEq('and through nothing else', [...new Set(writes.filter((w) => !/^PUT \/api\/(state|diary)\//.test(w)))], ['PUT /api/schedule/block']);
    await page.click('#planSyncClose');

    // ── an unlocked past week ────────────────────────────────────────────────
    console.log('\nan edit in an unlocked past week');
    const before = blocks.length;
    await page.evaluate(() => { window.changeWeek(-1); window.togglePastWeekLock(); });
    await edit('tuesday', 1, [1004]);
    await waitOpen();
    check('the popup says it is a past week', /мината недела/.test(await page.textContent('#planSyncTitle')));
    checkEq('and starts at „Само таа недела"', await page.$eval('#planSyncPast', (s) => s.value), 'only');
    await apply();
    await waitClosed();
    checkEq('the record alone changed: the live plan is as it was', await live('tuesday', 1), [1002, 1004]);
    checkEq('and Кабинети was not written', blocks.length, before);

    await edit('tuesday', 1, [1004]);       // put back
    await edit('tuesday', 1, [1004]);       // and out again: the popup returns
    await waitOpen();
    await page.selectOption('#planSyncPast', 'permanent');
    await apply();
    await waitClosed();
    checkEq('„Постојано" moves it into the live plan', await live('tuesday', 1), [1002]);
    checkEq('and into Кабинети, with what Кабинети held', blocks[blocks.length - 1],
        { day: 'вторник', time: '08:45-09:25', therapistId: 7, studentPublicIds: ['p-b'], expectedStudentPublicIds: ['p-b', 'p-d'] });

    // ── the tab „Податоци": the procedure on top, the files at the bottom ─────
    console.log('\nthe data tab and „Усогласи сè"');
    await page.evaluate(() => { window.changeWeek(1); window.switchTab('data'); });
    await page.waitForSelector('#sdnLocalSrvPanel'); await page.waitForSelector('#sdnYearPanel'); await page.waitForSelector('#sdnStorageV3Panel');
    const tops = await page.evaluate(() => ['sdnRunPanel', 'sdnLocalSrvPanel', 'sdnYearPanel', 'sdnStorageV3Panel', 'sdnFilesPanel']
        .map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)));
    check('the panels are in the order the work needs, whatever order the scripts added them in',
        tops.every((top, i) => i === 0 || top > tops[i - 1]), JSON.stringify(tops));
    check('the procedure is visible without scrolling', tops[0] < 900 && tops[1] < 900, JSON.stringify(tops));
    check('the file buttons are ordinary buttons, not full-width bars', await page.$$eval('#sdnFilesPanel button',
        (buttons) => buttons.length === 3 && buttons.every((b) => b.getBoundingClientRect().height < 46 && b.getBoundingClientRect().width < 420)));

    const report = () => page.$$eval('#sdnRunReport .line', (lines) => lines.map((l) => [l.dataset.runStep, l.dataset.runStatus]));
    const runAll = async () => { await page.click('#sdnRunBtn'); await page.waitForFunction(() => !document.getElementById('sdnRunBtn').disabled); };
    await runAll();
    checkEq('with no server it stops at the first step and runs nothing after it', await report(), [['server', 'fail']]);

    health = { ok: true, database: 'therapy_probe', server: { label: 'ПРОБНА' } };
    await runAll();
    const second = await report();
    check('with a server, the diary is synchronised next; a failure there stops the procedure too',
        second[0][1] === 'ok' && second[1][0] === 'document' && (second[1][1] !== 'fail' || second.length === 2), JSON.stringify(second));

    // The diary's own sync is tested elsewhere; here it answers „исто" so the rest of the order is seen.
    await page.evaluate(() => { window.SdnLocalSrv.sync = () => Promise.resolve('insync'); });
    await runAll();
    const third = await report();
    checkEq('all four steps run in order', third.map((r) => r[0]), ['server', 'document', 'rows', 'plan']);
    checkEq('a difference with Кабинети is a thing to look at, never changed by the procedure', third[3][1], 'warn');
    // flush() and hydrate() answer false without throwing; that must never read as „во ред".
    const rowsStep = async (flush, hydrate) => {
        await page.evaluate(([f, h]) => {
            window.SDiary.enabled = () => true;
            window.SDiary.flush = () => Promise.resolve(f);
            window.SDiary.hydrate = () => Promise.resolve(h);
        }, [flush, hydrate]);
        await runAll();
        return (await report()).find((r) => r[0] === 'rows')[1];
    };
    checkEq('rows sent and read: in order', await rowsStep(true, true), 'ok');
    checkEq('a send that was not confirmed is not reported as done', await rowsStep(false, true), 'warn');
    checkEq('nor a read that was not confirmed', await rowsStep(true, false), 'warn');
    checkEq('nor both', await rowsStep(false, false), 'warn');
    check('and the sentence says the edits stay here', /остануваат тука/.test(await page.textContent('[data-run-step="rows"]')));

    await rowsStep(true, true);      // back to a clean run: only the plan is left to look at
    const sent = blocks.length;
    await page.click('[data-run-action="plan"]');
    await waitOpen();
    check('and its button opens the list', (await rowsShown()).length > 0);
    checkEq('the procedure itself wrote nothing to Кабинети', blocks.length, sent);
    // Resolve everything in the popup: the report behind it must not keep saying it differs.
    await page.evaluate(() => { window.schedule.wednesday[2] = []; window.schedule.friday[0] = []; });
    sessions = sessions.filter((s) => !(s.therapist_id === 7 && s.day === 'петок' && s.time === '08:00-08:40'));
    await page.click('#planSyncClose');
    await page.waitForFunction(() => document.querySelector('[data-run-step="plan"]').dataset.runStatus === 'ok');
    check('closing the popup re-reads the plan line of the report', /сè е усогласено/.test(await page.textContent('#sdnRunWhen')));
    if (process.env.PLAN_SHOTS) await page.screenshot({ path: path.join(process.env.PLAN_SHOTS, 'data-tab.png') });

    // ── a backup in the browser is a state, not an event ─────────────────────
    console.log('\nbackups in the browser');
    const backupCount = async () => (await page.evaluate(() => window.SdnV3.getBackups())).length;
    const backup = async (reason) => { await page.evaluate((r) => window.SdnV3.createBackup(r), reason); await page.waitForTimeout(400); };
    await backup('first');
    const held = await backupCount();
    await backup('again');
    await backup('and again');
    checkEq('the same state backed up three times is one backup', await backupCount(), held);
    check('and it says when it was last confirmed', Boolean((await page.evaluate(() => window.SdnV3.getBackups()))[0].confirmedAt));
    // What a pull from the server does: jsonb returns the same content with its keys in another order.
    await page.evaluate(() => {
        const reversed = (o) => Object.fromEntries(Object.entries(o).reverse());
        window.students = window.students.map(reversed);
        window.plans = window.plans.map(reversed);
    });
    await backup('same content, keys in another order');
    checkEq('the same content with its keys reordered is still one backup', await backupCount(), held);
    await page.evaluate(() => { window.schedule.friday[4] = [1001]; });
    await backup('after a change');
    checkEq('a changed state is a new backup', await backupCount(), held + 1);

    check('the past week was unlocked through the diary\'s own warning', dialogs.some((d) => /отклучена/.test(d)));
    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
