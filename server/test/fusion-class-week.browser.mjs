/**
 * Кабинети → „По одделение" (RasporediFusion.html, `drawClassWeek`).
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed. Writes
 * are answered 405 and only recorded. The people and classes are invented.
 *
 * What it holds the tab to (owner, 3 Oct 2026):
 *   - it is the therapist's week, with the chosen паралелка's lesson on top of
 *     every cell — lessons 1–6 only, a seventh never shown;
 *   - the lesson is the one the crossing says the block covers
 *     (`bells.cabinet[].covers`), not a row number;
 *   - two 20′ sessions in one block are both there, under one lesson;
 *   - the picker offers the classes of this therapist's booked pupils, in the
 *     year's order, one no longer on the list marked „неактивна";
 *   - the chosen class's pupils are marked, and choosing another class moves
 *     the lessons and the marks; the choice is a Back/Forward step;
 *   - a cell edits through the plain week's own writer (`/api/schedule/block`);
 *   - „Термини" is untouched (the control).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://localhost:4613';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const year = '2026/2027';

const students = [
    { public_id: 'p-a', name: 'Пробен Прв', grade: 'V-а', active: true },
    { public_id: 'p-b', name: 'Пробна Втора', grade: 'V-а', active: true },
    { public_id: 'p-c', name: 'Пробен Трет', grade: 'VI-а', active: true },
    { public_id: 'p-d', name: 'Пробна Четврта', grade: 'IX-з', active: true }
];
const therapists = [
    { id: 1, name: 'Терапевт Пример А', students: [] },
    { id: 2, name: 'Терапевт Пример Б', students: ['p-a', 'p-b', 'p-c', 'p-d'] }
];
const classes = [
    { id: 11, label: 'V-а', description: 'пробна паралелка' },
    { id: 12, label: 'VI-а', description: '' }
];
const teachers = [{ id: 7, name: 'Наставничка Измислена', classes: [{ label: 'V-а', role: 'homeroom' }] }];

const bells = [['I', '08:00'], ['II', '08:45'], ['III', '09:40'], ['IV', '10:25'], ['V', '11:10'], ['VI', '11:55']]
    .map(([label, startsAt]) => ({ label, startsAt, minutes: 40 }));
// The crossing's answer: block n covers lesson n — and block VI also touches a
// 7th lesson a little, which must still never be shown.
const blocks = bells.map((b, i) => ({ ...b, covers: [{ ordinal: i + 1, minutes: 40, share: 1 }].concat(
    i === 5 ? [{ ordinal: 7, minutes: 45, share: 1 }] : []) }));
const lesson = (day, ordinal, cls, subject, teacher) => ({ day, ordinal, class: cls, subject, teacher, away: [], awayCount: 0 });
const cells = [
    lesson('понеделник', 1, 'V-а', 'Математика', 'Наставник Еден'),
    lesson('вторник', 2, 'V-а', 'Македонски јазик', 'Наставник Два'),
    lesson('вторник', 2, 'VI-а', 'Ликовно образование', 'Наставник Три'),
    lesson('петок', 6, 'V-а', 'Музичко образование', 'Наставник Четири'),
    lesson('петок', 7, 'V-а', 'СЕДМИОТ ЧАС', 'Никој')
];
const sessions = [
    { day: 'понеделник', time: '08:00-08:40', therapist_id: 2, student_public_id: 'p-a' },
    { day: 'вторник', time: '08:45-09:05', therapist_id: 2, student_public_id: 'p-b' },
    { day: 'вторник', time: '09:05-09:25', therapist_id: 2, student_public_id: 'p-c' },
    { day: 'среда', time: '09:40-10:20', therapist_id: 2, student_public_id: 'p-d' }
];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const errors = [], writes = [];
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
await context.addInitScript(() => localStorage.setItem('my_therapist_v1', 'Терапевт Пример Б'));
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== SERVED) return route.abort();
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') { writes.push(req.method() + ' ' + url.pathname); return route.fulfill({ status: 405, contentType: 'application/json', body: '{"error":"test"}' }); }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists, teachers, classes },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: bells } },
            '/api/teaching/crossing': { cells, bells: { cabinet: blocks }, unplaced: [], external: [] }
        }[url.pathname];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
    if (name === 'mtb-runtime.js') return route.fulfill({ status: 200, contentType: TYPES['.js'], body: 'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;' });
    try {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body: await readFile(path.join(ROOT, name)) });
    } catch { return route.fulfill({ status: 404, body: '' }); }
});

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));

/** One cell of the week: its lesson line, and each slot's text and mark. */
const cell = (day, row) => page.evaluate(([dayIndex, rowIndex]) => {
    const grid = document.querySelector('#scheduleGrid .schedule-grid');
    const all = Array.from(grid.querySelectorAll('.schedule-cell'));
    const node = all[rowIndex * 5 + dayIndex];
    const line = node.querySelector('.lesson-line');
    return {
        lesson: line ? line.textContent.replace(/\s+/g, ' ').trim() : null,
        none: line ? line.classList.contains('none') : null,
        slots: Array.from(node.querySelectorAll('.student-slot')).map((s) => ({
            pupil: s.querySelector('select').value, marked: s.classList.contains('in-class')
        }))
    };
}, [['понеделник', 'вторник', 'среда', 'четврток', 'петок'].indexOf(day), row]);

try {
    console.log('\nКабинети → По одделение');
    await page.goto(`${SERVED}/RasporediFusion.html`);
    await page.locator('#scheduleGrid .schedule-grid').waitFor();

    // The control: the plain week has no lesson line.
    await page.selectOption('#viewMode', 'week');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    checkEq('the control: „Термини" draws no lesson line', await page.locator('#scheduleGrid .lesson-line').count(), 0);

    await page.click('[data-panel="classWeek"]');
    await page.locator('#scheduleGrid .lesson-line').first().waitFor();
    check('the tab shows the class picker', await page.locator('#classWeekBar').isVisible());
    check('the day/week switch is out of the way', !(await page.locator('.field.view').isVisible()));
    check('the title names the tab, the therapist and the class',
        /По одделение · Терапевт Пример Б · /.test(await page.locator('#scheduleTitle').textContent()));
    checkEq('it is the therapist from „Терапевт"', await page.locator('#focus').inputValue(), '2');

    const options = await page.locator('#classWeekClass option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    checkEq('the picker offers the booked pupils\' classes, in the year\'s order, the unlisted one last',
        options.map((o) => o[0]), ['V-а', 'VI-а', 'IX-з']);
    check('a class is said the shared way (with its homeroom teacher)', /Наставничка Измислена/.test(options[0][1]), options[0][1]);
    check('a class off the year\'s list is marked „неактивна"', /неактивна/.test(options[2][1]), options[2][1]);
    checkEq('the first class is chosen', await page.locator('#classWeekClass').inputValue(), 'V-а');

    let c = await cell('понеделник', 0);
    checkEq('Mon I: the lesson the block covers, with its teacher', c.lesson, '1. Математика Наставник Еден');
    checkEq('Mon I: the class\'s pupil is marked', c.slots, [{ pupil: 'p-a', marked: true }]);

    c = await cell('вторник', 1);
    checkEq('Tue II: one lesson over the two 20′ sessions', c.lesson, '2. Македонски јазик Наставник Два');
    checkEq('Tue II: both sessions are there, only the class\'s pupil marked', c.slots,
        [{ pupil: 'p-b', marked: true }, { pupil: 'p-c', marked: false }]);

    c = await cell('среда', 2);
    checkEq('Wed III: no lesson for the class says so', [c.lesson, c.none], ['3. час · нема час', true]);

    // One height for every cell: the two 20′ sessions of Tue II split it, they do not grow it.
    const heights = await page.locator('#scheduleGrid .schedule-cell').evaluateAll((cs) =>
        [...new Set(cs.map((c) => Math.round(c.getBoundingClientRect().height)))]);
    checkEq('every cell has one height, two sessions included', heights.length, 1);
    const slotFont = await page.locator('#scheduleGrid .student-slot').evaluateAll((ss) =>
        [...new Set(ss.map((s) => getComputedStyle(s).fontSize))]);
    checkEq('and one text size, two sessions included', slotFont.length, 1);
    const lineHeights = await page.locator('#scheduleGrid .lesson-line').evaluateAll((ls) =>
        [...new Set(ls.map((l) => Math.round(l.getBoundingClientRect().height)))]);
    checkEq('every lesson line is one line, a long subject included', lineHeights.length, 1);

    // SHOT=<folder>: pictures of the tab in both themes, for looking at it.
    if (process.env.SHOT) {
        await page.screenshot({ path: path.join(process.env.SHOT, 'class-week-light.png'), fullPage: true });
        await page.evaluate(() => document.getElementById('checkbox').click());
        await page.screenshot({ path: path.join(process.env.SHOT, 'class-week-dark.png'), fullPage: true });
        await page.evaluate(() => document.getElementById('checkbox').click());
    }

    c = await cell('петок', 5);
    checkEq('Fri VI: lesson 6, never the 7th', c.lesson, '6. Музичко образование Наставник Четири');
    checkEq('the 7th lesson is nowhere', await page.locator('#scheduleGrid', { hasText: 'СЕДМИОТ' }).count(), 0);

    await page.selectOption('#classWeekClass', 'VI-а');
    c = await cell('вторник', 1);
    checkEq('another class: its lesson in the same cell', c.lesson, '2. Ликовно образование Наставник Три');
    checkEq('another class: the marks move to its pupil', c.slots,
        [{ pupil: 'p-b', marked: false }, { pupil: 'p-c', marked: true }]);
    check('the class is in the address', new URL(page.url()).searchParams.get('class') === 'VI-а', page.url());

    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById('classWeekClass').value === 'V-а');
    checkEq('Back returns to the class before', await page.locator('#classWeekClass').inputValue(), 'V-а');
    check('and still on the tab', (await page.locator('#classWeekTab').getAttribute('aria-selected')) === 'true');

    // Editing is the plain week's: the same block writer, nothing of its own.
    await page.locator('#scheduleGrid .schedule-cell').nth(0).locator('select').first().selectOption('');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);
    check('a cell edits through the same writer as the week', writes.some((w) => w.endsWith('/api/schedule/block')), writes.join(', '));
    checkEq('and through nothing else', writes.filter((w) => !w.endsWith('/api/schedule/block')), []);

    await page.click('[data-panel="schedule"]');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    checkEq('back on „Термини": no lesson line, no picker', [await page.locator('#scheduleGrid .lesson-line').count(),
        await page.locator('#classWeekBar').isVisible()], [0, false]);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
