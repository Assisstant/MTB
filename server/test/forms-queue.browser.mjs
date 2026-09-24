/**
 * Податоци → „📥 Формулари", in a real browser, with every API call answered
 * here from invented data (like schedule-form.browser.mjs). What the server
 * decides and writes is asserted against a real database in
 * form-replies.e2e.ts; this is the screen that leads the administrator there:
 *
 *   - without MTB_ADMIN it says how to set it;
 *   - signed out it offers the PIN, and after signing in the list is fetched
 *     WITH the token;
 *   - several files go to the queue in one request, each with its outcome;
 *   - in the review a clean item is pre-ticked, a conflict is not, a refused
 *     one cannot be ticked, and accepting a conflict asks first;
 *   - the item text is readable in both themes (≥ 4.5:1).
 *
 *   node test/forms-queue.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3995';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const TOKEN = 'invented-admin-token';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

let mode = 'no-admin';                  // → 'signed-out' → 'signed-in'
const calls = [];
const review = {
    reply: { id: 7, about: 'Терапевт Измислен', filledAt: '2026-09-24T10:00:00Z', status: 'pending' },
    note: 'од понеделник', errors: [], unchanged: 2,
    names: { 'p-a': 'Ана Измислена (II-б)', 'p-b': 'Бојан Измислен (III)' },
    items: [
        { key: 'block:понеделник|08:00-08:40', type: 'block', state: 'conflict', day: 'понеделник', time: '08:00-08:40',
          from: [], to: ['p-b'], reasons: ['Бојан Измислен е веќе кај Друг Терапевт (08:00-08:40)'] },
        { key: 'block:вторник|08:00-08:40', type: 'block', state: 'changed', day: 'вторник', time: '08:00-08:40',
          from: ['p-b'], to: ['p-a'], reasons: ['сменето во базата откако е направен формуларот'] },
        { key: 'block:среда|08:00-08:40', type: 'block', state: 'clean', day: 'среда', time: '08:00-08:40',
          from: [], to: ['p-a'], reasons: [] },
        { key: 'block:петок|09:00-09:40', type: 'block', state: 'refused', day: 'петок', time: '09:00-09:40', reasons: ['терминот не постои во распоредот'] }
    ]
};

async function serve(context) {
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname.startsWith('/api/')) {
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            const token = req.headers()['x-mtb-evidence-token'] || '';
            calls.push({ method: req.method(), path: decodeURIComponent(url.pathname), body, token });
            const p = url.pathname;
            if (p === '/api/health') return json(200, { ok: true, server: { label: 'Пробна база' } });
            if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
            if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
                candidates: { students: [], teachers: [], therapists: [], classes: [] } });
            if (p === '/api/categories') return json(200, { categories: [] });
            if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
            if (p === '/api/evidence/people') return json(200, { people: [{ kind: 'therapist', id: 3, name: 'Админ Измислен', has_pin: true }] });
            if (p === '/api/evidence/login') { mode = 'signed-in'; return json(200, { token: TOKEN, person: { name: 'Админ Измислен' } }); }
            if (p === '/api/evidence/me') return token ? json(200, { person: { kind: 'therapist', id: 3, name: 'Админ Измислен' }, permissions: { admin: true } }) : json(401, {});
            if (p.startsWith('/api/forms/')) {
                if (mode === 'no-admin') return json(403, { error: 'Нема поставен администратор. Во server/.env додај MTB_ADMIN=therapist:Име Презиме и рестартирај го серверот.', needsAdmin: true, noAdmin: true });
                if (token !== TOKEN) return json(401, { error: 'not signed in', signedOut: true });
                if (p === '/api/forms/replies' && req.method() === 'GET') return json(200, { year: YEAR, replies: [
                    { id: 7, about: 'Терапевт Измислен', fileName: 'одговор.json', filledAt: '2026-09-24T10:00:00Z', receivedAt: '2026-09-24T11:00:00Z', status: 'pending', decided: 0 },
                    { id: 6, about: 'Терапевт Измислен', fileName: 'постар.json', filledAt: '2026-09-23T10:00:00Z', receivedAt: '2026-09-24T11:00:00Z', status: 'superseded', decided: 0 }] });
                if (p === '/api/forms/replies' && req.method() === 'POST') return json(200, { results: body.replies.map((r, i) => ({
                    fileName: r.fileName, outcome: i === 0 ? 'stored' : 'superseded', about: 'Терапевт Измислен' })) });
                if (p === '/api/forms/replies/7/review') return json(200, review);
                if (p === '/api/forms/replies/7/decide') return json(200, { id: 7, outcomes: Object.fromEntries((body.accept || []).map((k) => [k, 'запишано'])), rejected: body.reject || [] });
            }
            return json(404, { error: 'not in this test' });
        }
        const file = url.pathname.replace(/^\//, '');
        const path = join(ROOT, file);
        if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
    });
}

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
await serve(context);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log('only the administrator');
await page.goto(`${ORIGIN}/Podatoci.html?tab=forms`);
await page.waitForSelector('#formsGate .form-gate', { timeout: 8000 });
check('the tab opens from the address', await page.locator('#tab-forms').isVisible());
check('without MTB_ADMIN it says how to set it', /MTB_ADMIN/.test(await page.locator('#formsGate').textContent()));
check('and offers no import', !(await page.locator('#formsTools').isVisible()));

mode = 'signed-out';
await page.click('[data-tab="students"]');
await page.click('[data-tab="forms"]');
await page.waitForSelector('#formsPin', { timeout: 4000 });
check('signed out, it offers the PIN', await page.locator('#formsWho option').count() === 1);
await page.fill('#formsPin', '1234');
await page.click('#formsSignIn');
await page.waitForSelector('#formsList table', { timeout: 4000 });
const listCall = calls.filter((c) => c.path === '/api/forms/replies' && c.method === 'GET').pop();
check('after signing in the list is fetched with the token', listCall && listCall.token === TOKEN, JSON.stringify(listCall));
const statuses = await page.$$eval('#formsList .form-status', (x) => x.map((n) => n.textContent));
check('the newer answer waits, the older one is shown as superseded', JSON.stringify(statuses) === JSON.stringify(['чека преглед', 'заменет со понов']), JSON.stringify(statuses));

console.log('\nseveral files at once');
const reply = { kind: 'mtb-schedule-reply', version: 1, year: YEAR, therapist: { id: 1, name: 'Терапевт Измислен' }, blocks: {}, baseline: {} };
await page.setInputFiles('#formsFiles', [
    { name: 'a.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reply)) },
    { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...reply, note: 'b' })) },
    { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') }
]);
await page.waitForSelector('#formsImport li', { timeout: 4000 });
const posted = calls.filter((c) => c.path === '/api/forms/replies' && c.method === 'POST');
check('the readable files go in ONE request', posted.length === 1 && posted[0].body.replies.map((r) => r.fileName).join() === 'a.json,b.json',
    JSON.stringify(posted.map((c) => c.body.replies.length)));
const lines = await page.$$eval('#formsImport li', (x) => x.map((n) => n.textContent));
check('each file says what happened to it, the unreadable one too',
    lines.length === 3 && /чека преглед/.test(lines.join()) && /понов/.test(lines.join()) && /не е читлив JSON/.test(lines.join()), JSON.stringify(lines));

console.log('\nthe review');
await page.click('[data-form-review="7"]');
await page.waitForSelector('.form-review .form-item', { timeout: 4000 });
const box = (state) => page.locator(`.form-review input[data-state="${state}"]`);
check('a clean item is ticked', await box('clean').isChecked());
check('a conflict is not', !(await box('conflict').isChecked()));
check('nor a term changed meanwhile', !(await box('changed').isChecked()));
check('a refused one cannot be ticked', await box('refused').isDisabled());
check('the conflict says with whom', /веќе кај Друг Терапевт/.test(await page.locator('.form-item.conflict').textContent()));
check('pupils are named with their class', /Бојан Измислен \(III\)/.test(await page.locator('.form-item.conflict').textContent()));

await page.click('#formsAccept');
await page.waitForTimeout(400);
let decide = calls.filter((c) => c.path === '/api/forms/replies/7/decide').pop();
check('accepting sends only the ticked clean item', decide && JSON.stringify(decide.body.accept) === JSON.stringify(['block:среда|08:00-08:40']), JSON.stringify(decide && decide.body));

await page.waitForSelector('.form-review .form-item', { timeout: 4000 });
await box('conflict').check();
let asked = '';
page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
const before = calls.length;
await page.click('#formsAccept');
await page.waitForTimeout(300);
check('accepting a conflict asks first', /конфликт/.test(asked), asked);
check('and a „no" sends nothing', !calls.slice(before).some((c) => c.path.endsWith('/decide')));

console.log('\nreadable in both themes');
const ratio = () => page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255,255,255)'; };
    const r = (el) => { const a = lum(getComputedStyle(el).color), z = lum(bg(el)); return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05); };
    return Math.min(...Array.from(document.querySelectorAll('.form-item .what, .form-item .why, .form-status')).map(r));
});
for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const worst = await ratio();
    check(`${theme}: the least readable text is ≥ 4.5:1`, worst >= 4.5, worst.toFixed(2));
}
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exitCode = fails ? 1 : 0;
