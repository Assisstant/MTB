/**
 * „📅 Залепи во избрани недели" (S-Dnevnik.html, `openWeekPastePicker`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call answers 404, so nothing real can be read or written. The
 * people are invented; the clock is fixed on Wednesday 7 October 2026.
 *
 * What it holds the calendar to:
 *   - it is offered as soon as a week is copied, on the copied week too;
 *   - it lists the weeks of the school year by month, and marks the copied
 *     week, this week, a break, and a week that already holds its own plan;
 *   - the copied week and locked past weeks cannot be chosen; unlocking is
 *     one button away;
 *   - looking and choosing writes nothing; „Откажи" leaves everything as it was;
 *   - every chosen week takes the copy for itself only, by the same rule as
 *     „📥 Залепи": the weeks between and after keep the plan they had, a past
 *     week keeps its attendance marks and the week before it is not changed;
 *   - one backup is made first, and a week that is already the same is
 *     counted, not rewritten;
 *   - „и сите наредни" sends the last chosen week down the confirmed onward
 *     path, which refuses an unconnected diary — the weeks chosen before it
 *     are still pasted, and the message says which part did not happen.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://localhost:4614';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const NOW = new Date('2026-10-07T10:00:00');     // this week is 05.10
const THIS = '2026-10-05';
const LAST = '2026-09-28';
const OLDER = '2026-09-21';
const SEP14 = '2026-09-14';
const SEP07 = '2026-09-07';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const mark = (date, status, time) => ({ status, date, time });
const build = () => {
    const payload = {
        students: [1001, 1002, 1003].map((id, i) => ({ id, name: `Пробен ${['Алфа', 'Бета', 'Гама'][i]}`, grade: 'V', kind: 'internal', disabilityType: '', planId: null })),
        archivedStudents: [], formerCaseloadStudents: [],
        schoolCalendar: { label: '2026/2027', yearStart: '2026-09-01', firstHalfEnd: '2027-01-31', yearEnd: '2027-06-10',
            holidays: [{ name: 'Есенски распуст', kind: 'raspust', start: '2026-11-02', end: '2026-11-06' }] },
        schedule: emptyWeek(),
        scheduleHistory: { [OLDER]: emptyWeek() },
        // Kept by the day's date: a Monday mark sits under the week's own key.
        attendance: { [LAST]: { 1002: { 'monday-4': mark(LAST, 'present', '11:10-11:50') } } },
        plans: [], links: [], studentProgress: {},
        trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
    };
    payload.schedule.monday[0] = [1001];             // today's plan
    payload.schedule.tuesday[1] = [1002];
    payload.scheduleHistory[OLDER].wednesday[2] = [1003];   // 21.09 has its own record: the week that gets copied
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
const writes = [];
await context.addInitScript(() => { localStorage.setItem('sdn_local_server_autosync_v1', '0'); });
await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== SERVED) return route.abort();
    if (url.pathname.startsWith('/api/')) {
        if (route.request().method() !== 'GET') writes.push(`${route.request().method()} ${url.pathname}`);
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

const goTo = (offset) => page.evaluate((o) => {
    while (currentWeek < o) changeWeek(1);
    while (currentWeek > o) changeWeek(-1);
}, offset);
const weekAt = (offset) => page.evaluate((o) => {
    while (currentWeek < o) changeWeek(1);
    while (currentWeek > o) changeWeek(-1);
    return JSON.parse(JSON.stringify(getScheduleForWeek(getWeekKey())));
}, offset);
const state = () => page.evaluate(() => JSON.parse(JSON.stringify({ schedule: window.schedule, planFrom: window.planFrom, history: window.scheduleHistory })));
const shownBtn = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id);
const tile = (k) => `#weekPickModal [data-week="${k}"]`;
const tileInfo = (k) => page.$eval(tile(k), (b) => ({ text: b.textContent, cls: b.className, off: b.disabled }));
const pickerOpen = () => page.$('#weekPickModal').then(Boolean);
// Leaving a past week locks the past again, as the diary always has: unlock from the calendar.
const unlock = async () => { if (await page.$('#weekPickUnlock')) await page.click('#weekPickUnlock'); };
const backups = () => page.evaluate(() => window.SdnV3.getBackups().then((b) => b.filter((x) => x.reason === 'before_week_paste').length));

try {
    console.log('\nЗалепи во избрани недели');
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SDiary && window.SdnLocalSrv);
    await page.evaluate((p) => { window.SdnV3.applyPayload(p); window.renderAll(); switchTab('schedule'); }, build());

    console.log('\nthe button');
    check('the calendar is not offered before anything is copied', !(await shownBtn('weekPasteManyBtn')));
    await goTo(-2);                                   // 21.09, the week with its own record
    await page.click('#weekCopyBtn');
    check('it is offered as soon as a week is copied — on the copied week itself', await shownBtn('weekPasteManyBtn'));
    check('where the one-week „📥 Залепи“ is not', !(await shownBtn('weekPasteBtn')));

    console.log('\nthe calendar');
    const before = await state();
    await page.click('#weekPasteManyBtn');
    await page.waitForSelector('#weekPickModal');
    checkEq('the weeks of the school year, from the Monday that holds its first day',
        await page.$$eval('#weekPickModal [data-week]', (b) => [b.length, b[0].dataset.week, b[b.length - 1].dataset.week]), [41, '2026-08-31', '2027-06-07']);
    checkEq('grouped by month', await page.$$eval('#weekPickModal .wk-month', (h) => h.slice(0, 3).map((x) => x.textContent)), ['Август 2026', 'Септември 2026', 'Октомври 2026']);
    let t = await tileInfo(OLDER);
    check('the copied week is marked and cannot be chosen', t.off && /копирана/.test(t.text) && /source/.test(t.cls), JSON.stringify(t));
    t = await tileInfo(LAST);
    check('a past week is locked until the past is unlocked', t.off && /🔒/.test(t.text) && /locked/.test(t.cls), JSON.stringify(t));
    t = await tileInfo(THIS);
    check('this week is named', !t.off && /оваа недела/.test(t.text) && /now/.test(t.cls), JSON.stringify(t));
    t = await tileInfo('2026-11-02');
    check('a break is named, a school week carries its number',
        /распуст/.test(t.text) && /седмица 7/.test((await tileInfo('2026-10-12')).text), JSON.stringify(t));
    check('nothing is chosen for the person when the shown week cannot be', (await page.$$('#weekPickModal .wk.on')).length === 0
        && await page.$eval('#weekPickApply', (b) => b.disabled) && await page.$eval('#weekPickOnward', (b) => b.disabled));
    if (process.env.SHOT) await page.screenshot({ path: path.join(process.env.SHOT, 'week-picker-locked.png') });

    console.log('\nunlocking, choosing, cancelling');
    dialogs.length = 0;
    await page.click('#weekPickUnlock');
    check('one button unlocks the past, with the diary\'s own warning', dialogs.some((d) => /отклучена/.test(d)) && !(await tileInfo(LAST)).off);
    check('the copied week stays out of reach', (await tileInfo(OLDER)).off);
    for (const k of [SEP14, LAST, THIS, '2026-10-19', '2026-10-26']) await page.click(tile(k));
    await page.click(tile('2026-10-26'));             // and off again
    checkEq('a click chooses, a second click lets go', await page.$$eval('#weekPickModal .wk.on', (b) => b.map((x) => x.dataset.week)), [SEP14, LAST, THIS, '2026-10-19']);
    check('the summary counts and names them', /Избрани: 4 недели — 14\.09–18\.09, 28\.09–02\.10, 05\.10–09\.10, 19\.10–23\.10/.test(await page.textContent('#weekPickSummary')));
    check('the button says how many', /Залепи во 4 недели/.test(await page.textContent('#weekPickApply')));
    check('„и сите наредни“ names the last chosen week', /од 19\.10–23\.10 натаму/.test(await page.textContent('.wk-onward')));
    if (process.env.SHOT) {
        await page.screenshot({ path: path.join(process.env.SHOT, 'week-picker-light.png') });
        await page.evaluate(() => document.body.classList.add('dark-mode'));
        await page.screenshot({ path: path.join(process.env.SHOT, 'week-picker-dark.png') });
        await page.evaluate(() => document.body.classList.remove('dark-mode'));
    }
    await page.click('#weekPickClose');
    check('„Откажи“ closes it', !(await pickerOpen()));
    checkEq('and looking, choosing and cancelling changed nothing', await state(), before);
    checkEq('nor wrote anything', [writes, await backups()], [[], 0]);

    console.log('\ninto chosen weeks: a past one, this one, a coming one');
    await page.click('#weekPasteManyBtn');
    await page.waitForSelector('#weekPickModal');
    for (const k of [LAST, THIS, '2026-10-19']) await page.click(tile(k));
    await page.click('#weekPickApply');
    await page.waitForFunction(() => window.planFrom && window.planFrom['2026-10-19']);
    let s = await state();
    checkEq('the past week has the copy as its own record', [s.history[LAST].wednesday[2], s.history[LAST].monday[0]], [[1003], []]);
    checkEq('this week takes the copy now', [s.schedule.wednesday[2], s.schedule.monday[0]], [[1003], []]);
    checkEq('the week between the chosen ones goes back to the plan it had', [s.planFrom['2026-10-12'].monday[0], s.planFrom['2026-10-12'].wednesday[2]], [[1001], []]);
    checkEq('the chosen coming week has the copy', s.planFrom['2026-10-19'].wednesday[2], [1003]);
    checkEq('and the week after it the plan again', [s.planFrom['2026-10-26'].monday[0], s.planFrom['2026-10-26'].wednesday[2]], [[1001], []]);
    check('a past week that was not chosen is given no record', !(SEP14 in s.history) && !(SEP07 in s.history), Object.keys(s.history).join());
    checkEq('one backup was made first', await backups(), 1);
    checkEq('each week holds its own copy: an edit of one is not an edit of another',
        await page.evaluate(([last]) => { window.planFrom['2026-10-19'].friday[0] = [1001]; const other = [window.schedule.friday[0].length, window.scheduleHistory[last].friday[0].length]; window.planFrom['2026-10-19'].friday[0] = []; return other; }, [LAST]), [0, 0]);
    await goTo(-1);
    const drawn = await page.evaluate(() => [...document.querySelectorAll('#scheduleGrid .attendance-indicator')].map((n) => `${n.dataset.day}-${n.dataset.time}:${n.dataset.sid}`));
    check('the past week still draws its attendance mark, beside the pasted term', drawn.includes('monday-4:1002') && drawn.includes('wednesday-2:1003'), drawn.join(' '));
    checkEq('what each week shows now', [(await weekAt(0)).wednesday[2], (await weekAt(1)).wednesday[2], (await weekAt(2)).wednesday[2], (await weekAt(3)).wednesday[2]], [[1003], [], [1003], []]);

    console.log('\nweeks that are already the same');
    dialogs.length = 0;
    await goTo(0);
    await page.click('#weekPasteManyBtn');
    await page.waitForSelector('#weekPickModal');
    check('the shown week is chosen to begin with, when it can be', await page.$$eval('#weekPickModal .wk.on', (b) => b.map((x) => x.dataset.week).join()) === THIS);
    check('a week that holds its own plan is marked', /●/.test((await tileInfo('2026-10-19')).text) && /●/.test((await tileInfo(LAST)).text) && !/●/.test((await tileInfo('2026-11-09')).text));
    // 14.09 has no record of its own: it shows the next record after it, which is the copied week.
    await unlock();
    for (const k of ['2026-10-19', SEP14]) await page.click(tile(k));
    await page.click('#weekPickApply');
    await page.waitForFunction(() => !document.getElementById('weekPickModal'));
    await page.waitForTimeout(200);
    check('are said to be the same — a past week that already shows the copy among them', dialogs.some((d) => /веќе исти како копираната/.test(d)), JSON.stringify(dialogs));
    checkEq('and no second backup is made for nothing', await backups(), 1);

    console.log('\n„и сите наредни“');
    dialogs.length = 0;
    await page.click('#weekPasteManyBtn');
    await page.waitForSelector('#weekPickModal');
    await page.click(tile(THIS));                     // let go of the preselected week
    for (const k of ['2026-11-09', '2026-11-16']) await page.click(tile(k));
    await page.check('#weekPickOnward');
    await page.click('#weekPickApply');
    await page.waitForFunction(() => window.planFrom && window.planFrom['2026-11-09']);
    await page.waitForTimeout(300);
    s = await state();
    checkEq('the weeks before the last chosen one are pasted for themselves', s.planFrom['2026-11-09'].wednesday[2], [1003]);
    check('the last chosen week goes down the confirmed onward path, which refuses an unconnected diary', dialogs.some((d) => /Прво поврзете/.test(d)), JSON.stringify(dialogs));
    checkEq('so from that week on the plan is what it was', [s.planFrom['2026-11-16'].monday[0], s.planFrom['2026-11-16'].wednesday[2]], [[1001], []]);
    checkEq('nothing was sent anywhere', writes, []);

    console.log('\na past week whose earlier week borrows its plan');
    await goTo(1);                                    // 12.10: the plan from before the paste
    await page.click('#weekCopyBtn');
    await page.click('#weekPasteManyBtn');
    await page.waitForSelector('#weekPickModal');
    check('nothing is chosen to begin with on the copied week', (await page.$$('#weekPickModal .wk.on')).length === 0);
    await unlock();
    await page.click(tile(SEP14));
    await page.click('#weekPickApply');
    await page.waitForFunction((k) => window.scheduleHistory && window.scheduleHistory[k], SEP14);
    s = await state();
    checkEq('the chosen past week has the copy', [s.history[SEP14].monday[0], s.history[SEP14].wednesday[2]], [[1001], []]);
    checkEq('and the week before it keeps what it showed, as its own record', [s.history[SEP07].monday[0], s.history[SEP07].wednesday[2]], [[], [1003]]);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
