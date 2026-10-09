/**
 * Настава → „Распоред на часови" (the poster), предметна настава: a period says
 * the class and, under it, the subject of that lesson. In a real browser, every
 * API call answered here from invented data (rule 1). Owner, 9 Oct 2026:
 * „vo predmetna nastava … pod oddelenie predmet".
 *
 *   1. One lesson: the class, whole and first; its subject small beneath.
 *   2. A lesson with no subject entered: the class, and „—" in the subject's place.
 *   3. Two classes in one hour with one subject: both classes, the subject once.
 *   4. Two classes in one hour with two subjects: each class with its own.
 *   5. Одделенска настава is not changed: the subject in the period.
 *
 *   node test/nastava-poster.browser.mjs        SHOT=<folder> for a picture, CHROME=<path> for an installed browser
 */
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3987';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const ODD = 'Одделенска Измислена';
const PRED = 'Предметен Измислен';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const lesson = (teacher, day, ordinal, klass, subject) => ({ day, ordinal, teacher, teacherOnStaff: true, class: klass, subject, awayCount: 0, away: [] });
const cells = [
    lesson(ODD, 'понеделник', 1, 'II-а', 'Математика'),
    lesson(PRED, 'понеделник', 1, 'VI-а', 'Историја'),
    lesson(PRED, 'понеделник', 2, 'VI-б', ''),
    lesson(PRED, 'понеделник', 3, 'VII', 'Географија'),
    lesson(PRED, 'понеделник', 3, 'VIII-а', 'Географија'),
    lesson(PRED, 'понеделник', 4, 'IX-а', 'Историја'),
    lesson(PRED, 'понеделник', 4, 'IX-б', 'Географија')
];
const crossing = () => ({
    year: YEAR, isCurrentYear: true,
    bells: { teaching: [1, 2, 3, 4, 5, 6].map((o, i) => ({ ordinal: o, startsAt: ['08:00', '08:45', '09:40', '10:25', '11:10', '11:55'][i] })) },
    teachers: [
        { id: 11, name: ODD, kind: 'odd', homeroom: 'II-а', classes: ['II-а'], subject: '' },
        { id: 12, name: PRED, kind: 'pred', homeroom: '', classes: [], subject: 'Историја, Географија' }
    ],
    classes: ['II-а', 'VI-а', 'VI-б', 'VII', 'VIII-а', 'IX-а', 'IX-б'].map((label) => ({ label })),
    cells: cells.map((c) => ({ ...c })),
    unplaced: [], external: [],
    summary: { placed: 0, sessions: 0, external: 0, offStaffLessons: 0, lessonsDisrupted: 0 }
});

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // The two PDF libraries come from cdnjs, as for a person; nothing else leaves.
    if (url.origin === 'https://cdnjs.cloudflare.com') return route.continue();
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') return json(405, { error: 'not in this test' });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/teaching/crossing') return json(200, crossing());
        return json(404, { error: 'not in this test' });
    }
    const file = decodeURIComponent(p.replace(/^\//, ''));
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
    console.log('\nНастава → „Распоред на часови": во предметна, под одделението — предметот');
    await page.goto(`${ORIGIN}/Nastava.html`);
    await page.waitForSelector('#viewWeek');
    await page.click('#viewWeek');
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    await page.click('#printBtn');
    await page.click('[data-print="a2"]');
    await page.waitForFunction(() => window.__printed >= 1, null, { timeout: 8000 });

    // Each period of a row, as it reads: the classes in their order, what stands
    // first in the cell, and every small line under them.
    const row = (title, name) => page.evaluate(([t, n]) => {
        const sec = [...document.querySelectorAll('#poster .pz-sec')].find((s) => s.querySelector('h2').textContent.trim() === t);
        const tr = sec && [...sec.querySelectorAll('tbody tr')].find((r) => r.querySelector('th').firstChild.textContent === n);
        if (!tr) return null;
        return [...tr.querySelectorAll('td')].slice(2, 6).map((td) => ({
            classes: [...td.querySelectorAll('.pz-c')].map((c) => c.textContent),
            first: td.firstElementChild ? td.firstElementChild.className || td.firstElementChild.tagName.toLowerCase() : 'text',
            small: [...td.querySelectorAll('small')].map((s) => s.textContent),
            text: td.textContent.replace(/\s+/g, ' ').trim()
        }));
    }, [title, name]);

    const pred = await row('Предметна настава', PRED);
    check('the teacher is in предметна настава', !!pred, JSON.stringify(pred));
    if (pred) {
        checkEq('one lesson: the class first, its subject under it',
            { classes: pred[0].classes, first: pred[0].first, small: pred[0].small }, { classes: ['VI-а'], first: 'pz-c', small: ['историја'] });
        checkEq('a lesson with no subject entered: the class, and „—" holding the place',
            { classes: pred[1].classes, small: pred[1].small }, { classes: ['VI-б'], small: ['—'] });
        checkEq('two classes, one subject: both classes, the subject once',
            { classes: pred[2].classes, small: pred[2].small }, { classes: ['VII', 'VIII-а'], small: ['гео'] });
        checkEq('two classes, two subjects: each class with its own',
            { classes: pred[3].classes, small: pred[3].small }, { classes: ['IX-а', 'IX-б'], small: ['историја', 'гео'] });
    }
    const odd = await row('Одделенска настава', ODD);
    checkEq('одделенска is as it was: the subject in the period, no class under it in her own class',
        odd && { classes: odd[0].classes, small: odd[0].small, text: odd[0].text }, { classes: [], small: [], text: 'мат' });
    const lead = await page.evaluate(() => [...document.querySelectorAll('#poster .pz-sec')][1].querySelector('tbody td.lead').textContent.trim());
    check('the head of the row still says the teacher\'s subjects once', /ИСТ/.test(lead) && /ГЕО/.test(lead), lead);

    if (process.env.SHOT) {
        await mkdir(process.env.SHOT, { recursive: true });
        const table = await page.$('#poster .pz-sec:nth-of-type(2) .pz-table');
        await page.evaluate(() => { document.body.dataset.print = 'poster'; });
        if (table) await table.screenshot({ path: join(process.env.SHOT, 'poster-predmetna.png') }).catch(() => {});
    }
    // ⬇ PDF → „A0 на 16 листа A4" (owner, 9 Oct 2026): sixteen A4 sheets to cut
    // and glue into a poster of A0's size. Needs cdnjs; without it, it says so.
    console.log('\n⬇ PDF: A0 на 16 листа A4');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.click('#printBtn');
    await page.click('[data-pdf="poster"]');
    await page.waitForSelector('.mtb-pdf', { timeout: 5000 });
    const drawn = await page.waitForFunction(() => {
        const d = document.querySelector('.mtb-pdf');
        if (/не може/.test(d.querySelector('.say').textContent)) return 'offline';
        return d.querySelector('.wait').hidden ? 'drawn' : false;
    }, null, { timeout: 60000 }).then((h) => h.jsonValue(), () => 'timeout');
    const offered = await page.evaluate(() => {
        const i = document.querySelector('.mtb-pdf input[name=format][value="a0-16"]');
        return i ? i.closest('label').textContent.replace(/\s+/g, ' ').trim() : null;
    });
    check('the window offers „A0 на 16 листа A4" and says how large the glued poster is',
        /A0 на 16 листа A4/.test(offered || '') && /108 × 73 cm/.test(offered || ''), String(offered));
    if (drawn === 'offline') {
        console.log('  skip the file: no connection to cdnjs');
        await page.click('.mtb-pdf [data-close]');
    } else {
        await page.check('.mtb-pdf input[name=format][value="a0-16"]');
        // The preview follows the choice: the sheet with its fifteen cuts.
        await page.waitForTimeout(400);
        await page.waitForFunction(() => document.querySelector('.mtb-pdf .wait').hidden, null, { timeout: 60000 });
        const what = await page.evaluate(() => document.querySelector('.mtb-pdf .what').textContent);
        check('the preview says sixteen sheets', /^16 листа A4/.test(what), what);
        if (process.env.SHOT) { await mkdir(process.env.SHOT, { recursive: true }); await page.locator('.mtb-pdf').screenshot({ path: join(process.env.SHOT, 'poster-a0-16-preview.png') }); }
        const [got] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('.mtb-pdf [data-make]')]);
        const { readFileSync, copyFileSync } = await import('node:fs');
        const saved = await got.path();
        const text = readFileSync(saved).toString('latin1');
        const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${Math.round(m[1] * 25.4 / 72)}x${Math.round(m[2] * 25.4 / 72)}`);
        check('the file is sixteen pages, each exactly an A4 on its side',
            text.startsWith('%PDF') && boxes.length === 16 && boxes.every((b) => b === '297x210'), JSON.stringify(boxes));
        check('and is named after the timetable and the paper', /^Распоред на часови 2026-2027 — A0 на 16 листа A4\.pdf$/.test(got.suggestedFilename()), got.suggestedFilename());
        if (process.env.SHOT) { await mkdir(process.env.SHOT, { recursive: true }); copyFileSync(saved, join(process.env.SHOT, 'poster-a0-16.pdf')); }
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
