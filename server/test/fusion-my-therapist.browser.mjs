/**
 * Whose week Кабинети opens on (RasporediFusion.html, `myTherapistId`).
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing may be written. The people are invented.
 *
 * What it holds the default to:
 *   - with nothing known about this browser's person, the week opens on the
 *     first therapist of the year's list, as before (the control);
 *   - with the name S-Dnevnik keeps on the same origin, it opens on that
 *     therapist -- in the week and in „Ученици по терапевт“ -- and the list
 *     keeps its own order;
 *   - it is a default only: a therapist the person then picks stays picked;
 *   - a name that two therapists carry, or nobody carries, decides nothing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://localhost:4612';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const year = '2026/2027';
const students = [{ public_id: 'my-a', name: 'Пробен Прв', grade: 'III', active: true }];
let therapists = [
    { id: 1, name: 'Терапевт Пример А', students: [] },
    { id: 2, name: 'Терапевт Пример Б', students: ['my-a'] },
    { id: 3, name: 'Терапевт Пример В', students: [] }
];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const errors = [], writes = [];

/** A fresh browser profile each time: what it remembers is the thing under test. */
const open = async (myName, view = 'week') => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    if (myName) await context.addInitScript((name) => localStorage.setItem('my_therapist_v1', name), myName);
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== SERVED) return route.abort();
        if (url.pathname.startsWith('/api/')) {
            if (req.method() !== 'GET') { writes.push(req.method() + ' ' + url.pathname); return route.fulfill({ status: 405 }); }
            const data = {
                '/api/health': { ok: true, server: { label: 'Пробна база' } },
                '/api/years': [{ id: 1, label: year, is_current: true }],
                '/api/roster': { year, students, therapists, teachers: [] },
                '/api/schedule/sessions': { sessions: [{ day: 'среда', time: '08:45-09:25', therapist_id: 2, student_public_id: 'my-a' }] },
                '/api/teaching/timetable': { bells: { kabinet: [
                    { label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 }] } },
                '/api/teaching/crossing': { cells: [] }
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
    await page.goto(`${SERVED}/RasporediFusion.html`);
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.selectOption('#viewMode', view);
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    return { page, context };
};
const seen = (page) => page.evaluate(() => ({
    focus: document.getElementById('focus').value,
    order: Array.from(document.getElementById('focus').options).map((o) => o.value),
    roster: document.getElementById('rosterTherapist').value
}));

try {
    console.log('\nКабинети: чија недела се отвора');

    let { page, context } = await open('');
    checkEq('the control: nobody known, the week opens on the first of the list', (await seen(page)).focus, '1');
    await context.close();

    ({ page, context } = await open('  терапевт  пример Б '));
    let now = await seen(page);
    checkEq('known from the diary: the week opens on that therapist', now.focus, '2');
    checkEq('the list keeps its own order', now.order, ['1', '2', '3']);
    await page.selectOption('#focus', '3');
    await page.selectOption('#viewMode', 'day');
    await page.selectOption('#viewMode', 'week');
    checkEq('a therapist the person picked stays picked', (await seen(page)).focus, '3');
    await context.close();

    // Day by day shows every cabinet, so there the list of pupils is where it matters.
    ({ page, context } = await open('Терапевт Пример Б', 'day'));
    checkEq('day by day still shows every cabinet', (await seen(page)).focus, '');
    await page.click('[data-panel="roster"]');
    checkEq('and „Ученици по терапевт“ opens on that therapist', (await seen(page)).roster, '2');
    await context.close();

    ({ page, context } = await open('Некој Што Го Нема'));
    checkEq('a name nobody carries decides nothing', (await seen(page)).focus, '1');
    await context.close();

    therapists = [...therapists, { id: 4, name: 'Терапевт Пример Б', students: [] }];
    ({ page, context } = await open('Терапевт Пример Б'));
    checkEq('a name two therapists carry decides nothing', (await seen(page)).focus, '1');
    await context.close();

    checkEq('nothing was written', writes, []);
    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
