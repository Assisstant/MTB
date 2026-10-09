/**
 * Past weeks in S-Dnevnik (`getScheduleForWeek`, `recordPlanChange`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing real can be read or written. The people are invented.
 *
 * Seen in the cloud on 5 Oct 2026: last week (28.09) drew empty, although it
 * had eight attendance marks. Paging forward with „Следна →“ had saved a copy
 * of every week it left, with the plan as it was at that moment -- empty --
 * up to 2028, and a saved copy wins over the marks. The owner: „распоредот
 * треба да постои и да биде ист … и да се чува отсутен присутен“.
 *
 * What it holds the diary to:
 *   - an empty copy is dropped on load, and does not count as a change when
 *     the diary compares itself with the server (no „ЗАСТАНА“ from it);
 *   - a past week with no copy shows the next copy after it, or today's plan,
 *     inside this school year; before it, the marks alone, as before;
 *   - every attendance mark is drawn, even where the copy has someone else;
 *   - paging writes nothing; a save with no plan change writes nothing;
 *   - a plan change gives last week the plan from BEFORE the change, and this
 *     week the plan after it; a copy of a week still to come is dropped.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// localhost, so the diary treats the page as served by its own server.
const SERVED = 'http://localhost:4612';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
// A Wednesday: this week is 05.10, last week 28.09.
const NOW = new Date('2026-10-07T10:00:00');
const THIS = '2026-10-05';
const LAST = '2026-09-28';
const OLDER = '2026-09-21';
const SUMMER = '2026-08-24';        // before the school year opens on 01.09
const LATER = '2026-10-19';         // a copy of a week that has not happened yet

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const mark = (date, status, time) => ({ status, date, time });
const build = () => {
    const payload = {
        students: [1001, 1002, 1003].map((id, i) => ({ id, name: `Пробен ${['Алфа', 'Бета', 'Гама'][i]}`, grade: 'V', kind: 'internal', disabilityType: '', planId: null })),
        archivedStudents: [], formerCaseloadStudents: [],
        schoolCalendar: { label: '2026/2027', yearStart: '2026-09-01', firstHalfEnd: '2027-01-31', yearEnd: '2027-06-10', holidays: [] },
        schedule: emptyWeek(),
        scheduleHistory: { [OLDER]: emptyWeek(), [LAST]: emptyWeek(), '2026-10-12': emptyWeek(), [LATER]: emptyWeek() },
        attendance: {
            [LAST]: { 1001: { 'monday-0': mark(LAST, 'absent', '08:00-08:40') }, 1003: { 'monday-4': mark(LAST, 'absent', '11:10-11:50') } },
            [SUMMER]: { 1002: { 'monday-2': mark(SUMMER, 'present', '09:40-10:20') } }
        },
        plans: [], links: [], studentProgress: {},
        trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
    };
    payload.schedule.monday[0] = [1001];
    payload.schedule.tuesday[1] = [1002];
    payload.scheduleHistory[OLDER].monday[0] = [1003];
    payload.scheduleHistory[LATER].monday[0] = [1003];
    return payload;
};

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const errors = [];
let serverState = null;              // what GET /api/state/sdnevnik answers

await context.addInitScript(() => {
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
});
await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== SERVED) return route.abort();
    if (url.pathname === '/api/state/sdnevnik' && route.request().method() === 'GET' && serverState) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serverState) });
    }
    if (url.pathname.startsWith('/api/')) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
    if (name === 'mtb-runtime.js') return route.fulfill({ status: 200, contentType: TYPES['.js'], body: 'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;' });
    try {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body: await readFile(path.join(ROOT, name)) });
    } catch { return route.fulfill({ status: 404, body: '' }); }
});

const page = await context.newPage();
await page.clock.setFixedTime(NOW);
page.on('pageerror', (e) => errors.push(String(e)));
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

const open = async () => {
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SDiary && window.SdnLocalSrv);
};
const weeks = () => page.evaluate(() => Object.keys(window.scheduleHistory).sort());
const history = () => page.evaluate(() => JSON.parse(JSON.stringify(window.scheduleHistory)));
// Go to a week by its offset from this one, the way the buttons do.
const goTo = (offset) => page.evaluate((o) => {
    while (currentWeek < o) changeWeek(1);
    while (currentWeek > o) changeWeek(-1);
}, offset);
const shown = () => page.evaluate(() => ({
    week: getWeekKey(),
    plan: JSON.parse(JSON.stringify(getScheduleForWeek(getWeekKey()))),
    notice: (document.getElementById('pastWeekNotice') || {}).textContent || '',
    cells: [...document.querySelectorAll('#scheduleGrid .attendance-indicator')].map((n) => `${n.dataset.day}-${n.dataset.time}:${n.dataset.sid}`).sort()
}));

try {
    console.log('\nМинатите недели');
    await open();
    await page.evaluate((p) => { window.SdnV3.applyPayload(p); window.renderAll(); }, build());

    // ── empty copies are dropped on load ──────────────────────────────────────
    checkEq('the empty copies are gone, the full ones stay', await weeks(), [OLDER, LATER]);

    // ── last week: no copy, so today's plan, and every mark ───────────────────
    await goTo(-1);
    let view = await shown();
    checkEq('we are on last week', view.week, LAST);
    checkEq('it has today\'s plan', [view.plan.monday[0], view.plan.tuesday[1]], [[1001], [1002]]);
    checkEq('and the pupil marked in a term the plan does not have', view.plan.monday[4], [1003]);
    check('every one of them is drawn', ['monday-0:1001', 'monday-4:1003', 'tuesday-1:1002'].every((c) => view.cells.includes(c)), view.cells.join(' '));
    check('the note says the plan was carried, not rebuilt', /важеше истиот/.test(view.notice), view.notice);

    // ── a week with its own copy shows that copy ──────────────────────────────
    await goTo(-2);
    view = await shown();
    checkEq('the week before has its own copy', view.plan.monday[0], [1003]);
    check('and today\'s plan is not mixed into it', !view.cells.includes('tuesday-1:1002'), view.cells.join(' '));
    check('the note says it is the saved one', /зачуваниот/.test(view.notice), view.notice);

    // ── before the school year: the marks alone, as before ────────────────────
    await goTo(-6);
    view = await shown();
    checkEq('a summer week', view.week, SUMMER);
    checkEq('shows only the marked term', view.cells, ['monday-2:1002']);
    check('and says it is rebuilt from the marks', /реконструиран/.test(view.notice), view.notice);

    // ── paging writes nothing ─────────────────────────────────────────────────
    await goTo(3);
    await goTo(0);
    checkEq('paging back and forth saves no copy', await weeks(), [OLDER, LATER]);
    await page.evaluate(() => window.saveData());
    checkEq('nor does a save with no change to the plan', await weeks(), [OLDER, LATER]);

    // ── a plan change: last week keeps the plan from before it ────────────────
    await page.evaluate(() => { window.schedule.wednesday[2] = [1003]; return window.saveData(); });
    let h = await history();
    checkEq('the copies after the change', Object.keys(h).sort(), [OLDER, LAST, THIS]);
    checkEq('last week has the plan from before the change', [h[LAST].monday[0], h[LAST].tuesday[1], h[LAST].wednesday[2]], [[1001], [1002], []]);
    checkEq('this week has the plan after it', h[THIS].wednesday[2], [1003]);

    await page.evaluate(() => { window.schedule.thursday[3] = [1001]; return window.saveData(); });
    h = await history();
    checkEq('a second change this week leaves last week alone', h[LAST].wednesday[2], []);
    checkEq('and this week follows it', [h[THIS].wednesday[2], h[THIS].thursday[3]], [[1003], [1001]]);

    // ── it is kept ────────────────────────────────────────────────────────────
    await open();
    await page.waitForFunction(() => Array.isArray(window.students) && window.students.length === 3, null, { timeout: 10000 }).catch(() => {});
    checkEq('a reload brings the same copies', await weeks(), [OLDER, LAST, THIS]);

    // ── „📋 Копирај ја неделата“ / „📥 Залепи“ ─────────────────────────────────
    // The owner: copy every treatment of a week, paste it onto another; into a
    // past week as its record, into this or a coming week with the question
    // „само оваа недела, или и сите наредни?“.
    const shownBtn = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id);
    const planFrom = () => page.evaluate(() => JSON.parse(JSON.stringify(window.planFrom)));
    const live = () => page.evaluate(() => JSON.parse(JSON.stringify(window.schedule)));
    const weekAt = (offset) => page.evaluate((o) => {
        while (currentWeek < o) changeWeek(1);
        while (currentWeek > o) changeWeek(-1);
        return JSON.parse(JSON.stringify(getScheduleForWeek(getWeekKey())));
    }, offset);
    const backupMade = (reason) => page.evaluate((r) => new Promise((resolve) => {
        const req = indexedDB.open('SDnevnik_LocalDatabase');
        req.onsuccess = () => {
            try {
                const db = req.result;
                const names = [...db.objectStoreNames];
                const tx = db.transaction(names, 'readonly');
                const all = names.map((n) => new Promise((done) => { const g = tx.objectStore(n).getAll(); g.onsuccess = () => done(JSON.stringify(g.result)); g.onerror = () => done(''); }));
                Promise.all(all).then((texts) => resolve(texts.join('').includes(r)));
            } catch { resolve(false); }
        };
        req.onerror = () => resolve(false);
    }), reason);
    // Click „📥 Залепи“ and answer the question (or cancel it).
    const paste = async (choice) => {
        dialogs.length = 0;
        await page.click('#weekPasteBtn');
        const asked = await page.waitForSelector('#weekChoiceModal', { timeout: 2000 }).then(() => true, () => false);
        if (!asked) return { asked, alert: dialogs[0] || '' };
        const text = await page.textContent('#weekChoiceModal');
        if (process.env.SHOT && !choice) await page.screenshot({ path: path.join(process.env.SHOT, 'sdnevnik-week-paste.png') });
        await page.click(`#weekChoiceModal button[data-choice="${choice || ''}"]`);
        await page.waitForSelector('#weekChoiceModal', { state: 'detached' });
        await page.waitForTimeout(150);               // the backup is written first
        return { asked, text, alert: dialogs[0] || '' };
    };
    const theOldPlan = await live();                  // monday-0 1001, tuesday-1 1002, wednesday-2 1003, thursday-3 1001

    check('„📋 Копирај“ is offered on every week', await shownBtn('weekCopyBtn'));
    check('„📥 Залепи“ is not, before anything was copied', !(await shownBtn('weekPasteBtn')));

    await goTo(-2);
    // A pupil who is no longer on the therapist's list must not come back as a term.
    await page.evaluate((w) => { window.scheduleHistory[w].friday[4] = [9999]; renderSchedule(); }, OLDER);
    if (process.env.SHOT) await page.screenshot({ path: path.join(process.env.SHOT, 'sdnevnik-week-copy.png') });
    await page.click('#weekCopyBtn');
    check('after copying, „📥 Залепи“ is not offered on the week itself', !(await shownBtn('weekPasteBtn')));

    // ── into a coming week, only that week ────────────────────────────────────
    await goTo(2);                                    // 19.10
    check('it is offered on another week', await shownBtn('weekPasteBtn'));
    let r = await paste(null);
    check('it asks first', r.asked && /само за оваа недела, или и за сите наредни/.test(r.text || ''), r.text || r.alert);
    checkEq('„Откажи“ changes nothing', await planFrom(), {});
    r = await paste('only');
    check('and says who was left out', /не се во „Мои ученици“/.test(r.text || ''), r.text);
    let pf = await planFrom();
    checkEq('only that week: 19.10 gets the copy, 26.10 goes back to the plan', Object.keys(pf).sort(), ['2026-10-19', '2026-10-26']);
    checkEq('the copy, without the pupil who left', [pf['2026-10-19'].monday[0], pf['2026-10-19'].friday[4]], [[1003], []]);
    checkEq('this week\'s plan is not touched', await live(), theOldPlan);
    checkEq('the week before still has the plan', (await weekAt(1)).wednesday[2], [1003]);
    checkEq('19.10 shows the copy', (await weekAt(2)).monday[0], [1003]);
    check('and says it was prepared ahead', /залепениот распоред/.test(await page.textContent('#planFromNotice').catch(() => '')));
    checkEq('the week after it has the plan again', (await weekAt(3)).wednesday[2], [1003]);
    check('a backup was made first', await backupMade('before_week_paste'));

    // ── into a coming week, and every one after it ────────────────────────────
    await goTo(4);                                    // 02.11
    r = await paste('onward');
    check('sharing onward refuses an unconnected diary instead of changing only one screen', /Прво поврзете/.test(r.alert));
    checkEq('the refusal leaves future plans unchanged', Object.keys(await planFrom()).sort(), ['2026-10-19', '2026-10-26']);
    // Server-confirmed onward is covered with real PostgreSQL in diary-ongoing.
    // Seed that accepted future plan here to retain the rendering/promotion checks.
    await page.evaluate(() => { planFrom['2026-11-02']=copyWeek(planFrom['2026-10-19']); saveData(); });
    pf = await planFrom();
    checkEq('every week from 02.11 on takes the copy', Object.keys(pf).sort(), ['2026-10-19', '2026-10-26', '2026-11-02']);
    checkEq('so does a week far ahead', (await weekAt(9)).monday[0], [1003]);
    checkEq('and the weeks before 02.11 are as they were', (await weekAt(3)).wednesday[2], [1003]);

    // An edit of a prepared week changes that week's plan, not today's.
    await goTo(2);
    await page.evaluate(() => { currentSlot = { day: 'tuesday', timeIdx: 0 }; checkOrder = [1002]; assignStudents(); });
    checkEq('editing 19.10 edits the plan prepared for it', (await planFrom())['2026-10-19'].tuesday[0], [1002]);
    checkEq('not this week\'s', (await live()).tuesday[0], []);

    // ── into this week, only this week ────────────────────────────────────────
    await goTo(0);
    r = await paste('only');
    checkEq('this week takes the copy now', (await live()).monday[0], [1003]);
    pf = await planFrom();
    checkEq('next week goes back to the plan it had', pf['2026-10-12'], theOldPlan);
    h = await history();
    checkEq('this week\'s record follows', h[THIS].monday[0], [1003]);

    // ── the prepared week arrives ─────────────────────────────────────────────
    await page.clock.setFixedTime(new Date('2026-10-14T10:00:00'));
    await open();
    await page.waitForFunction(() => Array.isArray(window.students) && window.students.length === 3, null, { timeout: 10000 }).catch(() => {});
    checkEq('the new week shows the plan prepared for it, before anything is saved', (await weekAt(0)).wednesday[2], [1003]);
    checkEq('opening the diary changed nothing', Object.keys(await planFrom()).sort(), ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
    await page.evaluate(() => window.saveData());
    checkEq('the first save makes it the plan', await live(), theOldPlan);
    checkEq('and it is no longer waiting', Object.keys(await planFrom()).sort(), ['2026-10-19', '2026-10-26', '2026-11-02']);
    h = await history();
    checkEq('the week that passed keeps what it had', h[THIS].monday[0], [1003]);

    // ── into a past week ──────────────────────────────────────────────────────
    await goTo(0);
    await page.click('#weekCopyBtn');                 // 12.10: the old plan
    await goTo(-2);                                   // 28.09
    r = await paste('past');
    check('a locked past week is refused, and says how to unlock', !r.asked && /заклучена/.test(r.alert), r.alert);
    await page.evaluate(() => { pastWeeksUnlocked = true; updateWeekDisplay(); });
    r = await paste('past');
    check('unlocked, it asks', r.asked && /Ознаките за присуство остануваат/.test(r.text || ''), r.text);
    h = await history();
    checkEq('28.09 is now the copy', [h[LAST].wednesday[2], h[LAST].thursday[3]], [[1003], [1001]]);
    view = await shown();
    check('and its attendance mark is still drawn', view.cells.includes('monday-4:1003'), view.cells.join(' '));
    checkEq('the week before it is left as it was', h[OLDER].monday[0], [1003]);
    r = await paste('past');
    check('pasting the same record again changes nothing; onward is still offered', r.asked && /веќе иста/.test(r.alert), r.alert);
    await page.evaluate(() => { pastWeeksUnlocked = false; updateWeekDisplay(); });

    // ── an empty copy on the server is not a difference ───────────────────────
    const local = await page.evaluate(() => JSON.parse(JSON.stringify(window.SdnV3.currentPayload('test'))));
    serverState = {
        version: 7, updated_at: NOW.toISOString(), updated_by: 'test',
        payload: { ...local, scheduleHistory: { ...local.scheduleHistory, '2026-09-14': emptyWeek(), '2026-11-02': emptyWeek() } }
    };
    checkEq('the server holding empty copies the diary dropped is still in step',
        await page.evaluate(() => window.SdnLocalSrv.sync({ auto: true })), 'insync');
    const full = emptyWeek();
    full.friday[0] = [1002];
    serverState = { ...serverState, payload: { ...serverState.payload, scheduleHistory: { ...serverState.payload.scheduleHistory, '2026-09-14': full } } };
    check('the control: a FULL copy only the server has is a difference',
        (await page.evaluate(() => window.SdnLocalSrv.sync({ auto: true }))) !== 'insync');

    // Explicitly clearing the final term must never borrow today's pupil.
    serverState = null;
    await page.clock.setFixedTime(NOW);
    const clearing = build();
    clearing.attendance = {};
    clearing.schedule = emptyWeek(); clearing.schedule.monday[0] = [1002];
    clearing.scheduleHistory = { [LAST]: emptyWeek() };
    clearing.scheduleHistory[LAST].monday[0] = [1001];
    clearing.planFrom = {};
    await page.evaluate(p => {
        SdnV3.applyPayload(p); currentWeek = -1; pastWeeksUnlocked = true;
        switchTab('schedule'); renderSchedule(); openSchedulePicker('monday', 0);
    }, clearing);
    await page.locator('.schedule-pickers select').first().selectOption('');
    await page.click('.schedule-pickers [data-save-slot]');
    checkEq('the cleared past term stays empty immediately', (await shown()).plan.monday[0], []);
    check('the empty week carries an explicit saved marker', (await history())[LAST]._saved === true);
    await page.evaluate(() => undoLastChange());
    checkEq('undo restores the past pupil', (await shown()).plan.monday[0], [1001]);
    await page.evaluate(() => redoLastChange());
    checkEq('redo clears without borrowing the live plan', (await shown()).plan.monday[0], []);
    await page.evaluate(() => SdnV3.saveFullPayload(SdnV3.currentPayload('explicit_empty_test'), 'explicit_empty_test'));
    await open();
    await page.waitForFunction(() => window.scheduleHistory['2026-09-28']?._saved === true);
    await goTo(-1);
    checkEq('reload preserves the intentionally empty week', (await shown()).plan.monday[0], []);
    const clearedPayload = await page.evaluate(() => SdnV3.currentPayload('empty_sync'));
    serverState = { version: 20, updated_at: NOW.toISOString(), payload: clearedPayload };
    checkEq('explicit empty week agrees across sync', await page.evaluate(() => SdnLocalSrv.sync({ auto: true })), 'insync');
    serverState.payload = JSON.parse(JSON.stringify(clearedPayload));
    delete serverState.payload.scheduleHistory[LAST];
    check('unlike legacy noise, deleting the explicit empty week is a real difference',
        await page.evaluate(() => SdnLocalSrv.sync({ auto: true })) !== 'insync');

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
