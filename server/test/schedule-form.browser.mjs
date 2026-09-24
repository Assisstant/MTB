/**
 * „📤 Формулар" → a colleague fills it in → „📥 Внеси формулар", end to end.
 *
 * Self-contained: the pages are read from disk on a fake origin and every API
 * call is answered here with invented people. The form is opened in a SECOND
 * browser context with no network at all, as a colleague would open it from
 * an e-mail. What is asserted is what reaches the server on import:
 *
 *   - since 24 Sep 2026 an answer is NOT written by Кабинети: it goes to the
 *     review queue (POST /api/forms/replies), several files in one request,
 *     and nothing touches the schedule. What the queue then writes — a block
 *     against what the database held, a typed name as ONE new pupil, a block
 *     changed meanwhile left alone — is asserted against a real database in
 *     form-replies.e2e.ts;
 *   - the form itself makes no request of any kind.
 *
 *   node test/schedule-form.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3996';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const year = '2026/2027';
const students = [
    { public_id: 'f-a', name: 'Прво Пробно', grade: 'III', active: true },
    { public_id: 'f-b', name: 'Второ Пробно', grade: 'IV', active: true },
    { public_id: 'f-c', name: 'Трето Пробно', grade: 'V', active: true }
];
const therapists = [
    { id: 1, name: 'Терапевт Формулар', students: ['f-a', 'f-b', 'f-c'] },
    { id: 2, name: 'Друг Терапевт', students: ['f-a'] }
];
const session = (day, time, therapist_id, student_public_id) => ({ day, time, therapist_id, student_public_id });
let sessions = [
    session('понеделник', '08:00-08:40', 1, 'f-a'),
    session('вторник', '08:45-09:05', 1, 'f-b'), session('вторник', '09:05-09:25', 1, 'f-c')
];
const bells = [{ label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 }];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
const errors = [], writes = [];
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') {
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            writes.push({ method: req.method(), path: decodeURIComponent(url.pathname), body });
            if (url.pathname === '/api/forms/replies') {
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    results: body.replies.map((r) => ({ fileName: r.fileName, outcome: 'stored', about: r.reply.therapist.name })) }) });
            }
            if (url.pathname === '/api/workspace/pupils') {
                return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ pupil: { public_id: 'f-new', name: body.name } }) });
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sessions: [] }) });
        }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists, teachers: [] },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: bells } },
            '/api/teaching/crossing': { cells: [] }
        }[url.pathname];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    }
    const file = url.pathname.replace(/^\//, '');
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(ORIGIN + '/RasporediFusion.html');
await page.locator('#scheduleGrid .schedule-grid').waitFor();

console.log('\nthe form is made for ONE therapist');
await page.click('#exportForm');
check('without a therapist chosen it asks for one', /Избери еден терапевт/.test(await page.locator('#notice').textContent()));
await page.selectOption('#focus', '1');
await page.locator('#scheduleGrid .schedule-grid').waitFor();
const waitingForm = page.waitForEvent('download');
await page.click('#exportForm');
const formDownload = await waitingForm;
const formHtml = await readFile(await formDownload.path(), 'utf8');
check('the file is named for the therapist', formDownload.suggestedFilename() === 'Распоред-формулар — Терапевт Формулар.html', formDownload.suggestedFilename());
check('it carries the therapist\'s pupils and not the others', formHtml.includes('Трето Пробно') && !formHtml.includes('Друг Терапевт'));
check('no write left the app to make it', writes.length === 0, JSON.stringify(writes));

console.log('\nthe colleague fills it in with no network at all');
const offline = await browser.newContext({ acceptDownloads: true });
const requests = [];
await offline.route('**/*', (route) => {
    const u = route.request().url();
    if (u === 'https://form.invalid/f.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formHtml });
    requests.push(u);
    return route.abort();
});
const form = await offline.newPage();
const formErrors = [];
form.on('pageerror', (e) => formErrors.push(e.message));
await form.goto('https://form.invalid/f.html');
const mon = form.locator('select[data-key="понеделник|08:00-08:40"][data-part="0"]');
check('the week arrives filled in', await mon.inputValue() === 'f-a');
check('two pupils in one block show as 20′ + 20′',
    await form.locator('select[data-key="вторник|08:45-09:25"][data-part="1"]').inputValue() === 'f-c');
await mon.selectOption('f-b');
form.once('dialog', (d) => d.accept('Ново   Дете'));
await form.locator('select[data-key="среда|08:00-08:40"][data-part="0"]').selectOption('__new__');
// The colleague also frees Tuesday's second half …
await form.locator('select[data-key="вторник|08:45-09:25"][data-part="1"]').selectOption('');
check('the typed name is offered as a pupil under observation',
    /Ново Дете \(ново · набљудување\)/.test(await form.locator('#list').textContent()));
check('three changed terms are counted', await form.locator('#count').textContent() === '3');
const waitingReply = form.waitForEvent('download');
await form.click('#save');
const replyDownload = await waitingReply;
const replyText = await readFile(await replyDownload.path(), 'utf8');
check('the answer is a .json named for the therapist', /^Распоред-одговор — Терапевт Формулар — \d{4}-\d{2}-\d{2}\.json$/.test(replyDownload.suggestedFilename()), replyDownload.suggestedFilename());
check('the form asked for nothing over the network', requests.length === 0, requests.join(', '));
check('no JavaScript error in the form', formErrors.length === 0, formErrors.join(' | '));
await offline.close();

console.log('\nthe answers come back — into the review queue, not into the schedule');
const second = JSON.stringify({ ...JSON.parse(replyText), savedAt: new Date(Date.now() + 60000).toISOString(), note: 'втор' });
await page.setInputFiles('#importFormFile', [
    { name: 'reply.json', mimeType: 'application/json', buffer: Buffer.from(replyText) },
    { name: 'reply-2.json', mimeType: 'application/json', buffer: Buffer.from(second) }
]);
await page.waitForFunction(() => /Одговори од формулари/.test(document.getElementById('notice').textContent || ''), null, { timeout: 8000 });
const queued = writes.filter((w) => w.path === '/api/forms/replies');
check('both files go to the queue in ONE request', queued.length === 1 && queued[0].body.replies.length === 2
    && queued[0].body.replies.map((r) => r.fileName).join() === 'reply.json,reply-2.json', JSON.stringify(queued.map((w) => w.body.replies.length)));
check('each answer is sent whole, as the colleague saved it',
    queued.length === 1 && queued[0].body.replies[0].reply.kind === 'mtb-schedule-reply' && queued[0].body.replies[0].reply.therapist.name === 'Терапевт Формулар');
check('nothing is written to the schedule, and no pupil is created',
    !writes.some((w) => w.path === '/api/schedule/block' || w.path === '/api/workspace/pupils' || /\/students\//.test(w.path)),
    JSON.stringify(writes.map((w) => w.path)));
const notice = await page.locator('#notice').textContent();
check('the notice says where to review them', /Ништо не е запишано во распоредот/.test(notice) && /Формулари/.test(notice), notice);
check('and links there', await page.locator('#notice a[href^="Podatoci.html?tab=forms"]').count() === 1);
check('no JavaScript error in the schedule', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exitCode = fails ? 1 : 0;
