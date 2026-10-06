/**
 * S-Дневник → „Паралелка" in the schedule's bar (`SdnClassLessons`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so nothing real can be read or written. The
 * people are invented.
 *
 * What it holds the picker to:
 *   - it offers the classes of „Мои ученици", written as every class picker
 *     writes a class, and nothing is drawn until one is chosen;
 *   - each term then carries the lesson that class has at that time — the
 *     period the crossing says the 40-minute block falls on (the larger share,
 *     periods 1–6), with the subject and the teacher; a period without a
 *     lesson says so;
 *   - a class taught in two groups shows both lessons;
 *   - the pupils of the chosen class are marked, the others are not;
 *   - the lines come back after the grid is redrawn, and go when „без часови"
 *     is chosen;
 *   - it is a look: it writes nothing, and the choice is remembered in this
 *     browser only.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://localhost:4615';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const ME = 'Измислен Терапевт Часови';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const payload = {
    students: [
        { id: 3001, name: 'Пробен Алфа', grade: 'V-а', kind: 'internal', disabilityType: '', planId: null },
        { id: 3002, name: 'Пробен Бета', grade: 'VI-б', kind: 'internal', disabilityType: '', planId: null },
        { id: 3003, name: 'Пробен Гама', grade: 'екстерен', kind: 'external', disabilityType: '', planId: null }
    ],
    formerCaseloadStudents: [], schedule: emptyWeek(), scheduleHistory: {}, attendance: {},
    plans: [], links: [], studentProgress: {}, trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
};
payload.schedule.monday[0] = [3001];
payload.schedule.monday[1] = [3002];
payload.schedule.tuesday[1] = [3001, 3003];

const roster = {
    year: '1901/1902-lessons',
    therapists: [{ id: 7, name: ME, students: [] }],
    students: [],
    // IX-а is a class of the school that none of „Мои ученици" is in.
    classes: [{ label: 'V-а', homeroom: 'Наставник Прв', description: '' }, { label: 'VI-б', homeroom: 'Наставник Втор', description: '' }, { label: 'IX-а', homeroom: '', description: '' }]
};
const crossing = {
    year: roster.year,
    bells: { cabinet: [
        { startsAt: '08:00', minutes: 40, covers: [{ ordinal: 1, minutes: 40 }] },
        // Most of the second block is the second period, a little is the third.
        { startsAt: '08:45', minutes: 40, covers: [{ ordinal: 3, minutes: 10 }, { ordinal: 2, minutes: 30 }] },
        { startsAt: '09:40', minutes: 40, covers: [{ ordinal: 3, minutes: 40 }] },
        { startsAt: '10:25', minutes: 40, covers: [{ ordinal: 4, minutes: 40 }] },
        // The last block falls mostly on a seventh period, which has no cell: the sixth is said.
        { startsAt: '11:10', minutes: 40, covers: [{ ordinal: 7, minutes: 30 }, { ordinal: 6, minutes: 10 }] }
    ] },
    cells: [
        { day: 'понеделник', ordinal: 1, class: 'V-а', subject: 'Математика', teacher: 'Наставник Прв' },
        { day: 'понеделник', ordinal: 2, class: 'V-а', subject: 'Англиски јазик', teacher: 'Наставник Трет' },
        { day: 'понеделник', ordinal: 3, class: 'V-а', subject: 'Погрешен час', teacher: 'Никој' },
        { day: 'вторник', ordinal: 2, class: 'V-а', subject: 'Ликовно', teacher: 'Наставник Прв' },
        { day: 'вторник', ordinal: 2, class: 'V-а', subject: 'Информатика', teacher: 'Наставник Четврт' },
        { day: 'понеделник', ordinal: 6, class: 'V-а', subject: 'Физичко', teacher: '' },
        { day: 'понеделник', ordinal: 1, class: 'VI-б', subject: 'Историја', teacher: 'Наставник Втор' }
    ]
};

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, serviceWorkers: 'block' });
const writes = [];
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
        if (url.pathname === '/api/teaching/crossing') return json(crossing);
        if (url.pathname === '/api/roster') return json(roster);
        if (url.pathname === '/api/schedule/sessions') return json({ year: roster.year, sessions: [] });
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
page.on('dialog', (d) => d.accept());

const lines = () => page.$$eval('#scheduleGrid .sdn-lesson-line', (n) => Object.fromEntries(n.map((x) => [x.dataset.lessonLine, x.textContent + (x.classList.contains('none') ? ' ∅' : '')])));
const marked = () => page.$$eval('#scheduleGrid .student-slot.in-lesson-class', (n) => [...new Set(n.map((x) => x.dataset.sid))].sort());

try {
    console.log('\nПаралелка во распоредот на дневникот');
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SdnClassLessons && window.SDiary);
    await page.evaluate((p) => { window.SdnV3.applyPayload(p); window.renderAll(); switchTab('schedule'); }, payload);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('lessonClassWrap')).display !== 'none', null, { timeout: 8000 });

    console.log('\nthe picker');
    const options = await page.$$eval('#lessonClass option', (o) => o.map((x) => [x.value, x.textContent]));
    checkEq('the classes of „Мои ученици“, not every class of the school, and a way to show none',
        options.map((o) => o[0]), ['', 'V-а', 'VI-б']);
    check('a class is written as every class picker writes it: with its teacher', /V-а · Наставник Прв/.test(options[1][1]), options[1][1]);
    checkEq('nothing is drawn until a class is chosen', await lines(), {});

    console.log('\nthe lessons of the chosen class');
    // The comparison with Кабинети is another suite's subject: its popup would sit over the grid.
    await page.evaluate(() => { const m = document.getElementById('planSyncModal'); if (m) m.classList.remove('active'); });
    await page.selectOption('#lessonClass', 'V-а');
    await page.waitForSelector('#scheduleGrid .sdn-lesson-line');
    let got = await lines();
    checkEq('a line in every term of the week', Object.keys(got).length, 25);
    check('the first term: the first period, its subject and teacher', got['0|0'] === '1. МатематикаНаставник Прв', got['0|0']);
    check('a block over two periods shows the one it mostly falls on', got['0|1'] === '2. Англиски јазикНаставник Трет', got['0|1']);
    check('a block that is mostly a seventh period shows the sixth, and says when nobody teaches it', got['0|4'] === '6. Физичкобез наставник', got['0|4']);
    check('a class taught in two groups shows both', got['1|1'] === '2. Ликовно / ИнформатикаНаставник Прв / Наставник Четврт', got['1|1']);
    check('a period with no lesson says so, with its number', got['2|0'] === '1. час · нема час ∅', got['2|0']);
    check('the whole lesson is on hover', /1\. час · Математика · Наставник Прв/.test(await page.getAttribute('[data-lesson-line="0|0"]', 'title')));
    checkEq('the pupils of that class are marked, the others are not', await marked(), ['3001']);
    if (process.env.SHOT) {
        await page.screenshot({ path: path.join(process.env.SHOT, 'class-lessons-light.png') });
        await page.evaluate(() => document.body.classList.add('dark-mode'));
        await page.screenshot({ path: path.join(process.env.SHOT, 'class-lessons-dark.png') });
        await page.evaluate(() => document.body.classList.remove('dark-mode'));
    }

    console.log('\nredrawing, another class, none');
    await page.evaluate(() => renderSchedule());
    await page.waitForSelector('#scheduleGrid .sdn-lesson-line');
    checkEq('the lines come back after the grid is redrawn, once each', [Object.keys(await lines()).length, (await page.$$('#scheduleGrid .sdn-lesson-line')).length], [25, 25]);
    await page.evaluate(() => changeWeek(1));
    await page.waitForSelector('#scheduleGrid .sdn-lesson-line');
    check('and on another week', (await lines())['0|0'] === '1. МатематикаНаставник Прв');
    await page.selectOption('#lessonClass', 'VI-б');
    await page.waitForFunction(() => /Историја/.test((document.querySelector('[data-lesson-line="0|0"]') || {}).textContent || ''));
    got = await lines();
    check('another class, its own lessons and its own pupils', got['0|0'] === '1. ИсторијаНаставник Втор' && JSON.stringify(await marked()) === '["3002"]', got['0|0']);
    check('the choice is remembered in this browser, as a look', await page.evaluate(() => localStorage.getItem('sdn_lesson_class_v1')) === 'VI-б');
    await page.selectOption('#lessonClass', '');
    await page.waitForFunction(() => !document.querySelector('#scheduleGrid .sdn-lesson-line'));
    checkEq('„без часови“ takes the lines and the marks away', [await lines(), await marked()], [{}, []]);
    check('and forgets the choice', await page.evaluate(() => localStorage.getItem('sdn_lesson_class_v1')) === null);
    checkEq('none of it wrote anything', writes, []);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
