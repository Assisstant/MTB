/**
 * „Третмани неделно" in „Мои ученици" (S-Dnevnik.html, `SdnTreatments`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing real can be read or written. The people are invented.
 *
 * What it holds the feature to:
 *   - the row shows how many terms the pupil has, and „−" is off at zero;
 *   - „+" writes nothing: it reads every cabinet and offers only what the
 *     block writer would accept — not the pupil's own term, not a bell in
 *     which the pupil is with another therapist (shown apart, with whose),
 *     not a full bell, not a bell where the diary and Кабинети disagree;
 *   - the order is a free whole bell first, a day without a term first, then
 *     the day on which the pupil has fewer terms elsewhere;
 *   - the choice is written ONLY through PUT /api/schedule/block with
 *     `expected`, Кабинети first, the diary only when Кабинети accepted;
 *   - a second pupil in a bell becomes its second half, and the bell's first
 *     pupil is named;
 *   - a refusal is shown in words, leaves the diary as it was and the popup open;
 *   - „−" asks which term, and takes it from Кабинети and from the diary;
 *   - a pupil the base cannot recognise is refused in words, with no write.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// localhost, so the diary treats the page as served by its own server.
const SERVED = 'http://localhost:4613';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const ME = 'Измислен Терапевт Бројач';
const OTHER = 'Друг Терапевт Бројач';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const payload = {
    students: [
        { id: 2001, name: 'Пробен Алфа', grade: 'V', kind: 'internal', rasporediStudentId: 't-a', disabilityType: '', planId: 9001 },
        { id: 2002, name: 'Пробен Бета', grade: 'V', kind: 'internal', rasporediStudentId: 't-b', disabilityType: '', planId: 9001 },
        // Linked nowhere: the base cannot tell who this is.
        { id: 2003, name: 'Пробен Гама', grade: 'VI', kind: 'internal', disabilityType: '', planId: 9001 },
        { id: 2004, name: 'Пробен Делта', grade: 'VI', kind: 'internal', rasporediStudentId: 't-d', disabilityType: '', planId: 9001 }
    ],
    formerCaseloadStudents: [], schedule: emptyWeek(), scheduleHistory: {}, attendance: {},
    plans: [{ id: 9001, name: 'Пробна програма', activities: ['Активност'] }],
    links: [], studentProgress: {}, trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
};
payload.schedule.monday[0] = [2001];             // Алфа, the same in Кабинети
payload.schedule.tuesday[1] = [2002];            // Бета alone: its second half can be shared
payload.schedule.thursday[3] = [2002, 2004];     // two pupils: full
payload.schedule.wednesday[2] = [2004];          // only in the diary: the two places disagree here

const session = (day, time, pid, name, therapist = 7, who = ME) =>
    ({ day, time, therapist_id: therapist, therapist_name: who, student_public_id: pid, student_name: name });
let sessions = [
    session('понеделник', '08:00-08:40', 't-a', 'Пробен Алфа'),
    session('вторник', '08:45-09:25', 't-b', 'Пробен Бета'),
    session('четврток', '10:25-10:45', 't-b', 'Пробен Бета'),
    session('четврток', '10:45-11:05', 't-d', 'Пробен Делта'),
    // Алфа is with another therapist on Tuesday, first bell — as a half that still overlaps it.
    session('вторник', '08:20-08:40', 't-a', 'Пробен Алфа', 8, OTHER),
    // Somebody else's pupil in the other cabinet: no business of this suggestion.
    session('среда', '08:00-08:40', 't-z', 'Туѓ Ученик', 8, OTHER)
];
const roster = {
    year: '1901/1902-treat',
    therapists: [{ id: 7, name: ME, students: ['t-a', 't-b', 't-d'] }, { id: 8, name: OTHER, students: ['t-a'] }],
    students: [
        { public_id: 't-a', sdnevnik_id: '2001', name: 'Пробен Алфа', grade: 'V', kind: 'internal' },
        { public_id: 't-b', sdnevnik_id: '2002', name: 'Пробен Бета', grade: 'V', kind: 'internal' },
        { public_id: 't-d', sdnevnik_id: '2004', name: 'Пробен Делта', grade: 'VI', kind: 'internal' }
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
const dialogs = [];
const errors = [];

await context.addInitScript((me) => {
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
    localStorage.setItem('my_therapist_v1', me);
    // The comparison popup is another suite's subject; here it would only sit over the list.
    // This is the one difference the fixture holds, marked as already seen.
    localStorage.setItem('sdn_plan_sync_seen_v1', '2|2:t-d>');
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
        if (url.pathname === '/api/health') return json({ error: 'down' }, 503);
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

const modalOpen = () => page.$eval('#treatModal', (m) => m.classList.contains('active'));
const waitOpen = () => page.waitForFunction(() => document.getElementById('treatModal').classList.contains('active'));
const waitClosed = () => page.waitForFunction(() => !document.getElementById('treatModal').classList.contains('active'));
const count = (id) => page.$eval(`[data-treat="${id}"] .treat-count`, (b) => b.textContent);
const offered = () => page.$$eval('#treatBody input[name="treat-option"]', (o) => o.map((x) => x.value));
const optionText = (key) => page.$eval(`#treatBody input[value="${key}"]`, (i) => i.closest('label').textContent);
const live = (day, slot) => page.evaluate(([d, s]) => window.schedule[d][s].slice(), [day, slot]);
const more = (id) => page.click(`[data-treat="${id}"] [data-treat-more]`);
const less = (id) => page.click(`[data-treat="${id}"] [data-treat-less]`);

try {
    console.log('\nТретмани неделно');
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SdnPlanSync && window.SdnTreatments && window.SDiary);
    await page.evaluate((p) => {
        localStorage.removeItem('sdnevnik_row_writes_v1');
        window.SdnV3.applyPayload(p);
        if (typeof window.renderAll === 'function') window.renderAll();
        switchTab('students');
        renderStudentListSimple();
    }, payload);
    writes.length = 0;

    console.log('\nthe list');
    checkEq('each row shows how many terms the pupil has', [await count(2001), await count(2002), await count(2003), await count(2004)], ['1', '2', '0', '2']);
    check('„−" is off for a pupil with no term', await page.$eval('[data-treat="2003"] [data-treat-less]', (b) => b.disabled));
    check('and on for a pupil with one', !(await page.$eval('[data-treat="2001"] [data-treat-less]', (b) => b.disabled)));

    console.log('\n+1: what is offered');
    await more(2001);
    await waitOpen();
    checkEq('asking writes nothing', writes, []);
    const first = await offered();
    check('the pupil\'s own term is not offered', !first.includes('0|0'));
    check('a bell in which the pupil is with another therapist is not offered', !first.includes('1|0'));
    check('and is shown apart, with whose pupil they are then',
        new RegExp(`Вто · I.*кај ${OTHER} \\(08:20-08:40\\)`).test(await page.textContent('.treat-blocked')));
    check('a bell that already holds two pupils is not offered', !first.includes('3|3'));
    check('a bell where the diary and Кабинети disagree is not offered, and the note says so',
        !first.includes('2|2') && /1 термин\(и\) во кои дневникот и Кабинети се разликуваат/.test(await page.textContent('#treatNote')));
    checkEq('first a free whole bell on a day without a term, on a day with nothing elsewhere', first[0], '2|0');
    check('a day on which the pupil already has a term comes after the days without one',
        first.indexOf('0|1') > first.indexOf('4|4'));
    check('a shared half comes after every whole bell, and names who it is shared with',
        first[first.length - 1] === '1|1' && /втора половина \(20 мин\.\), по Пробен Бета/.test(await optionText('1|1')));
    check('the first one is marked as the suggestion and chosen',
        /★ предлог/.test(await optionText('2|0')) && await page.$eval('#treatBody input[value="2|0"]', (i) => i.checked));
    check('another cabinet\'s own pupil does not make a bell busy', /слободен цел час/.test(await optionText('2|0')));
    check('the best six are on screen and the rest wait behind one click',
        await page.$$eval('#treatBody .plan-sync-choices > label', (l) => l.length) === 6
        && new RegExp(`Уште ${first.length - 6} можности`).test(await page.textContent('.treat-rest summary'))
        && !(await page.isVisible('#treatBody input[value="1|1"]')));

    console.log('\n+1: the choice drawn on the week');
    const cellAt = (row, col) => `#treatViz tbody tr:nth-child(${row}) td:nth-child(${col})`;   // col 2 = Monday / the first therapist
    const cellClass = (sel) => page.$eval(sel, (c) => c.className);
    check('the therapist\'s own week is drawn, and it is not given the page\'s pin and fold',
        await page.$eval('#treatViz table', (t) => t.getAttribute('data-treat-grid') === 'week' && t.hasAttribute('data-mtb-plain')));
    check('the suggestion is marked on it, with the pupil in the bell',
        (await cellClass('[data-treat-cell="2|0"]')) === 'tv-pick' && /\+ Пробен Алфа/.test(await page.textContent('[data-treat-cell="2|0"]')));
    check('the pupil\'s own term is framed and cannot be picked',
        /tv-own/.test(await cellClass(cellAt(1, 2))) && !(await page.$eval(cellAt(1, 2), (c) => c.hasAttribute('data-treat-cell'))));
    check('a bell the pupil spends with another therapist is marked, with whose',
        /tv-no/.test(await cellClass(cellAt(1, 3))) && new RegExp(`кај ${OTHER}`).test(await page.textContent(cellAt(1, 3))));
    check('a full bell and a bell the two places disagree on are neither offered nor marked',
        (await cellClass(cellAt(4, 5))) === '' && (await cellClass(cellAt(3, 4))) === '');
    writes.length = 0;
    await page.click('[data-treat-cell="3|1"]');
    check('a click on a marked bell chooses it in the list, and the mark moves',
        await page.$eval('#treatBody input[value="3|1"]', (i) => i.checked)
        && (await cellClass('[data-treat-cell="3|1"]')) === 'tv-pick' && (await cellClass('[data-treat-cell="2|0"]')) === 'tv-can');
    await page.click('[data-treat-cell="1|1"]');
    check('a bell from the folded rest opens the fold; a shared bell shows both pupils',
        await page.isVisible('#treatBody input[value="1|1"]') && await page.$eval('#treatBody input[value="1|1"]', (i) => i.checked)
        && /Пробен Бета\+ Пробен Алфа \(20′\)/.test(await page.textContent('[data-treat-cell="1|1"]')));

    console.log('\n+1: every therapist, for the day of the choice');
    await page.click('[data-treat-view="day"]');
    check('the switch names the day of the choice', /Сите терапевти · вторник/.test(await page.textContent('[data-treat-view="day"]')));
    checkEq('a column for each therapist, the person\'s own marked',
        await page.$$eval('#treatViz thead th', (h) => h.map((x) => x.textContent + (x.classList.contains('tv-on') ? ' *' : ''))),
        ['Час', `${OTHER}`, `${ME}вие *`]);
    check('the pupil is seen where they are with the other therapist that day',
        /tv-own/.test(await cellClass(cellAt(1, 2))) && /Пробен Алфа 20′/.test(await page.textContent(cellAt(1, 2))));
    check('and the choice is in the person\'s own column', (await cellClass('[data-treat-cell="1|1"]')) === 'tv-pick');
    await page.check('#treatBody input[value="2|0"]');
    check('choosing a bell on another day turns the picture to that day',
        /Сите терапевти · среда/.test(await page.textContent('[data-treat-view="day"]'))
        && /Туѓ Ученик/.test(await page.textContent(cellAt(1, 2))) && (await cellClass('[data-treat-cell="2|0"]')) === 'tv-pick');
    if (process.env.SHOT) await page.screenshot({ path: path.join(process.env.SHOT, 'treatments-day-light.png') });
    check('the view is remembered for this browser, as a look and nothing else',
        await page.evaluate(() => localStorage.getItem('sdn_treat_view_v1')) === 'day');
    await page.click('[data-treat-view="week"]');
    checkEq('looking and choosing wrote nothing', writes, []);
    if (process.env.SHOT) {
        await page.screenshot({ path: path.join(process.env.SHOT, 'treatments-more-light.png') });
        await page.evaluate(() => document.body.classList.add('dark-mode'));
        await page.screenshot({ path: path.join(process.env.SHOT, 'treatments-more-dark.png') });
        await page.evaluate(() => document.body.classList.remove('dark-mode'));
    }

    console.log('\n+1: a free bell');
    await page.click('#treatApply');
    await waitClosed();
    checkEq('one write, through the block writer', writes, ['PUT /api/schedule/block']);
    checkEq('with the pupil, the therapist and what Кабинети held', blocks[0],
        { day: 'среда', time: '08:00-08:40', therapistId: 7, studentPublicIds: ['t-a'], expectedStudentPublicIds: [] });
    checkEq('the diary has the same term', await live('wednesday', 0), [2001]);
    checkEq('and the row counts it', await count(2001), '2');

    console.log('\n+1: the second half of a bell');
    writes.length = 0; blocks.length = 0;
    await more(2001);
    await waitOpen();
    await page.click('.treat-rest summary');
    await page.check('#treatBody input[value="1|1"]');
    await page.click('#treatApply');
    await waitClosed();
    checkEq('the bell\'s first pupil stays first, the new one is second', blocks[0],
        { day: 'вторник', time: '08:45-09:25', therapistId: 7, studentPublicIds: ['t-b', 't-a'], expectedStudentPublicIds: ['t-b'] });
    checkEq('the diary holds both, in that order', await live('tuesday', 1), [2002, 2001]);
    checkEq('the row counts three', await count(2001), '3');

    console.log('\n+1: Кабинети refuses');
    writes.length = 0; blocks.length = 0;
    await more(2001);
    await waitOpen();
    const before = await live('friday', 0);
    await page.check('#treatBody input[value="4|0"]');
    refuseNext = { error: 'that student already has an overlapping session', doubleBooked: true, therapistName: OTHER, time: '08:00-08:40', studentName: 'Пробен Алфа' };
    await page.click('#treatApply');
    await page.waitForSelector('#treatResult .plan-sync-result.bad');
    check('the refusal is said in words', new RegExp(`Пробен Алфа веќе е кај ${OTHER} во 08:00-08:40`).test(await page.textContent('#treatResult')));
    check('the popup stays open', await modalOpen());
    checkEq('the diary is as it was', await live('friday', 0), before);
    await page.click('#treatClose');
    await waitClosed();
    checkEq('the row still counts three', await count(2001), '3');

    console.log('\n−1');
    writes.length = 0; blocks.length = 0;
    await less(2001);
    await waitOpen();
    checkEq('asking writes nothing', writes, []);
    checkEq('the pupil\'s three terms are listed', await offered(), ['0|0', '1|1', '2|0']);
    check('nothing is chosen for the person', !(await page.$('#treatBody input:checked')));
    check('a shared bell says who then has all of it', /заедно со Пробен Бета.*потоа Пробен Бета го има целиот час/.test(await optionText('1|1')));
    await page.click('#treatApply');
    check('without a choice nothing is written', writes.length === 0 && /Изберете термин/.test(await page.textContent('#treatResult')));
    await page.check('#treatBody input[value="1|1"]');
    check('the term to take off is marked on the week, the pupil struck out and the other left',
        (await page.$eval('[data-treat-cell="1|1"]', (c) => c.className)) === 'tv-drop'
        && await page.$eval('[data-treat-cell="1|1"]', (c) => [...c.querySelectorAll('div')].map((d) => d.textContent + (d.classList.contains('tv-strike') ? ' ✗' : '')).join(', ')) === 'Пробен Бета, Пробен Алфа ✗');
    await page.click('#treatApply');
    await waitClosed();
    checkEq('Кабинети keeps the other pupil, with what it held as expected', blocks[0],
        { day: 'вторник', time: '08:45-09:25', therapistId: 7, studentPublicIds: ['t-b'], expectedStudentPublicIds: ['t-b', 't-a'] });
    checkEq('the diary keeps the other pupil', await live('tuesday', 1), [2002]);
    checkEq('the row counts two', await count(2001), '2');

    console.log('\na pupil the base does not know');
    writes.length = 0; dialogs.length = 0;
    await more(2003);
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);
    check('is refused in words', dialogs.some((d) => /Пробен Гама не е поврзан со базата/.test(d)), JSON.stringify(dialogs));
    check('with no popup and no write', !(await modalOpen()) && writes.length === 0);

    console.log('\nthe pure suggestion');
    const pure = await page.evaluate(() => window.SdnTreatments.suggest('p', 1,
        [{ day: 0, slot: 0, mine: [], differs: false }, { day: 0, slot: 1, mine: [{ pid: 'q', name: 'Q' }], differs: false }],
        [{ day: 'понеделник', time: '09:10-09:20', therapist_id: 2, therapist_name: 'T', student_public_id: 'p' },
         { day: 'понеделник', time: '08:45 - 09:05', therapist_id: 2, therapist_name: 'T', student_public_id: 'p' }]));
    checkEq('a half is judged by its own twenty minutes: the second half of II clashes with 09:10',
        [pure.options.map((o) => o.key), pure.blocked.map((o) => o.key)], [['0|0'], ['0|1']]);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
