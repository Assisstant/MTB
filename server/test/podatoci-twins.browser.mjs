/**
 * Податоци → Ученици: „Можеби исто дете запишано двапати" and „Спои", in a
 * real browser, every API call answered here from invented data. What the
 * merge itself moves is asserted against a database in student-merge.e2e.ts.
 *
 * What this proves:
 *   1. the look-alike pairs the server lists are shown, the two rows side by
 *      side with what each holds, the likelier keeper marked;
 *   2. nothing is merged without a question that names which row stays, and
 *      the request names exactly that row and the other one;
 *   3. a refusal (two filled евидентни листови) is said in words;
 *   4. „Не се исти" is remembered and the pair is not shown again;
 *   5. readable in both themes.
 *
 *   node test/podatoci-twins.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3993';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const row = (id, name, extra = {}) => ({ public_id: id, name, grade: 'VI-а', kind: 'internal', enrolled: true, last_year: YEAR,
    diary: false, therapists: [], terms: 0, marks: 0, records: 0, ...extra });
let pairs = [
    { a: row('p-old', 'Измислен Петкоски', { enrolled: false, grade: null, last_year: '2025/2026', diary: true, marks: 31, records: 2 }),
      b: row('p-new', 'Измислен Петковски', { therapists: ['Измислена Терапевтка'], terms: 2 }) },
    { a: row('p-z1', 'Пробен Жарко', { grade: 'V' }), b: row('p-z2', 'Пробен Жарко', { grade: 'VII' }) }
];
let refuseNext = null;
const writes = [];

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') writes.push({ method: req.method(), path: p, body: req.postData() ? req.postDataJSON() : null });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/categories') return json(200, { categories: [] });
        if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
        if (p === '/api/roster/look-alike') return json(200, { year: YEAR, pairs });
        if (p === '/api/roster/merge') {
            if (refuseNext) { const r = refuseNext; refuseNext = null; return json(409, r); }
            const { keep, fold } = req.postDataJSON();
            pairs = pairs.filter((x) => ![x.a.public_id, x.b.public_id].includes(fold));
            return json(200, { ok: true, kept: keep, folded: fold, moved: { attendance: 31 }, sameFact: { therapist_students: 1 },
                marksDiffered: 0, diaryNumber: '9001', diary: '', clashes: [] });
        }
        return json(404, { error: 'not in this test' });
    }
    const file = decodeURIComponent(p.replace(/^\//, ''));
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});

const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

const contrast = (selector) => page.evaluate((sel) => {
    const rgb = (v) => v.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const el = document.querySelector(sel);
    let bg = el, back = 'rgba(0, 0, 0, 0)';
    while (bg && /rgba\(0, 0, 0, 0\)|transparent/.test(back = getComputedStyle(bg).backgroundColor)) bg = bg.parentElement;
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(back));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, selector);

try {
    console.log('\nПодатоци → Ученици: one child held twice');
    await page.goto(`${ORIGIN}/Podatoci.html?tab=students`);
    await page.waitForSelector('#studentTwins .twin-pair');
    const shown = () => page.$$eval('#studentTwins .twin-pair', (rows) => rows.map((r) => r.getAttribute('data-twin')));
    check('both pairs are shown', (await shown()).length === 2, JSON.stringify(await shown()));
    const first = await page.textContent('#studentTwins .twin-pair:first-of-type');
    check('each row says what it holds: the list, the therapist, terms, marks, the diary',
        /не е на списокот годинава \(последно 2025\/2026\)/.test(first) && /кај Измислена Терапевтка/.test(first)
        && /31 ознаки/.test(first) && /поврзан со дневникот/.test(first), first);
    check('the row on this year\'s list is the suggested keeper',
        await page.$eval('#studentTwins .twin-card.suggested', (c) => c.textContent.includes('Петковски')));
    check('nothing was written by showing them', writes.length === 0);

    const light = await contrast('#studentTwins .twin-card .facts');
    const softLight = await contrast('#studentTwins [data-twin-not]');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => { delete document.documentElement.dataset.theme; delete document.body.dataset.theme; });
    await page.waitForTimeout(600);   // the buttons fade their colours over .3s (mtb-look.css)
    const dark = await contrast('#studentTwins .twin-card .facts');
    const softDark = await contrast('#studentTwins [data-twin-not]');
    if (process.env.TWINS_SHOTS) await page.screenshot({ path: join(process.env.TWINS_SHOTS, 'twins-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    if (process.env.TWINS_SHOTS) await page.screenshot({ path: join(process.env.TWINS_SHOTS, 'twins-light.png') });
    check('readable in both themes (4.5:1)', light >= 4.5 && dark >= 4.5, `light ${light.toFixed(2)}, dark ${dark.toFixed(2)}`);
    check('„Не се исти“ too', softLight >= 4.5 && softDark >= 4.5, `light ${softLight.toFixed(2)}, dark ${softDark.toFixed(2)}`);

    console.log('\nmerging');
    refuseNext = { error: 'both pupils have a filled евидентен лист for the same year — read both and empty one first' };
    await page.click('#studentTwins [data-twin-keep="p-new"]');
    await page.waitForFunction(() => /Не е споено/.test(document.body.textContent));
    check('it asks first, naming which row stays', /Останува:\s+Измислен Петковски[\s\S]*Се влева во него:\s+Измислен Петкоски/.test(dialogs[0] || ''), dialogs[0]);
    check('a refusal is said in words', /евидентен лист/.test(await page.textContent('body')));
    check('and the pair is still there', (await shown()).length === 2);

    await page.click('#studentTwins [data-twin-keep="p-new"]');
    await page.waitForFunction(() => document.querySelectorAll('#studentTwins .twin-pair').length === 1);
    const merge = writes.filter((w) => w.path === '/api/roster/merge').pop();
    check('the request names the row kept and the row folded in', merge && merge.body.keep === 'p-new' && merge.body.fold === 'p-old', JSON.stringify(merge));
    check('and it says what happened', /Споено во „Измислен Петковски“/.test(await page.textContent('body')));

    console.log('\n„Не се исти"');
    await page.click('#studentTwins [data-twin-not]');
    await page.waitForFunction(() => document.getElementById('studentTwins').hidden);
    await page.reload();
    await page.waitForFunction(() => window.MTBAppNavigation && document.getElementById('studentTwins'));
    await page.waitForTimeout(600);
    check('is remembered: the pair is not shown again', await page.$eval('#studentTwins', (b) => b.hidden));
    check('and it wrote nothing', writes.filter((w) => w.path === '/api/roster/merge').length === 2);

    check('no page errors', errors.length === 0, errors.join('\n'));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
