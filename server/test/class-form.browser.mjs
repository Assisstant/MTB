/**
 * Уреди настава → „📤 Формулар" → a homeroom teacher fills it in → „📥 Внеси
 * формулар", end to end (docs/PLAN-formulari.md, step 3).
 *
 * Self-contained like schedule-form.browser.mjs: the page is read from disk
 * on a fake origin and every API call is answered here with invented classes
 * and people. The form is opened in a SECOND browser context with no network
 * at all. What the queue then does with the answer is asserted against a real
 * database in form-replies.e2e.ts.
 *
 * The second half is the TEACHER form from the same page („📤 Формулар ·
 * наставници"): each teacher's own week, class + subject per period, and the
 * class's week read only, put together from everybody's entries.
 *
 *   node test/class-form.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3997';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const year = '2026/2027';
const timetable = {
    year,
    bells: {
        'nastava-am': [1, 2].map((o) => ({ id: o, schedule: 'nastava-am', ordinal: o, label: String(o), startsAt: o === 1 ? '08:00' : '08:50', minutes: 40 })),
        'nastava-pm': [], kabinet: []
    },
    classes: [{ id: 11, label: 'II-б', sort_key: '2б', description: 'комбинирана' }, { id: 12, label: 'III-а', sort_key: '3а', description: null }],
    teachers: [
        { id: 21, name: 'Наставничка Прва', kind: 'odd', subject: null, classes: [{ label: 'II-б', role: 'homeroom' }], homeroom: 'II-б' },
        { id: 22, name: 'Наставник Втор', kind: 'pred', subject: 'Англиски', classes: [{ label: 'III-а', role: 'subject' }], homeroom: null }
    ],
    lessons: [
        { id: 31, day: 'понеделник', day_order: 1, ordinal: 1, class: 'II-б', class_id: 11, subject: 'Математика', teacher: 'Наставничка Прва', teacher_id: 21, teacher_on_staff: true },
        { id: 32, day: 'понеделник', day_order: 1, ordinal: 2, class: 'III-а', class_id: 12, subject: 'Англиски јазик', teacher: 'Наставник Втор', teacher_id: 22, teacher_on_staff: true }
    ],
    clashes: []
};
const roster = {
    year, therapists: [], teachers: [], classes: [],
    students: [
        { public_id: 'c-a', name: 'Ана Измислена', grade: 'II-б', oddelenie: 'II', active: true },
        { public_id: 'c-b', name: 'Бојан Измислен', grade: 'III-а', oddelenie: 'III', active: true }
    ]
};
const subjects = (cls) => ({ year, class: cls || null, basis: cls ? 'label' : 'all', grades: [],
    subjects: (cls === 'II-б' ? ['Математика', 'Македонски јазик'] : ['Математика', 'Македонски јазик', 'Англиски јазик', 'Ликовно образование'])
        .map((subject) => ({ subject, category: 'задолжителен', grades: ['II'] })) });

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
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') {
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            writes.push({ method: req.method(), path: decodeURIComponent(url.pathname), body });
            if (url.pathname === '/api/forms/replies') {
                return json(200, { results: body.replies.map((r) => ({ fileName: r.fileName, outcome: 'stored', about: r.reply.class ? r.reply.class.label : r.reply.teacher.name, applied: 1 })) });
            }
            return json(200, { ok: true });
        }
        if (url.pathname === '/api/teaching/subjects') return json(200, subjects(url.searchParams.get('class')));
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': roster,
            '/api/teaching/timetable': timetable
        }[url.pathname];
        return json(data ? 200 : 404, data || { error: 'not in this test' });
    }
    const file = url.pathname.replace(/^\//, '');
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(ORIGIN + '/NastavaUredi.html');
await page.waitForFunction(() => /часа/.test(document.getElementById('status').textContent || ''), null, { timeout: 8000 });

console.log('one form for every class');
const waitingForm = page.waitForEvent('download');
await page.click('#exportClassForm');
const formDownload = await waitingForm;
const formHtml = await readFile(await formDownload.path(), 'utf8');
check('the file is named for the year', formDownload.suggestedFilename() === 'Формулар-одделенија — 2026-2027.html', formDownload.suggestedFilename());
check('it carries every class with its homeroom', formHtml.includes('II-б') && formHtml.includes('III-а') && formHtml.includes('Наставничка Прва'));
check('no write left the app to make it', writes.length === 0, JSON.stringify(writes));

console.log('\nthe homeroom teacher fills it in with no network at all');
const offline = await browser.newContext({ acceptDownloads: true });
const requests = [];
await offline.route('**/*', (route) => {
    const u = route.request().url();
    if (u === 'https://form.invalid/c.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formHtml });
    requests.push(u);
    return route.abort();
});
const form = await offline.newPage();
const formErrors = [];
form.on('pageerror', (e) => formErrors.push(e.message));
await form.goto('https://form.invalid/c.html');
check('nothing is shown before a class is chosen', !(await form.locator('#work').isVisible()));
check('the dropdown reads „class · homeroom"', (await form.locator('#who option').allTextContents()).includes('II-б · Прва'),
    JSON.stringify(await form.locator('#who option').allTextContents()));
await form.selectOption('#who', 'II-б');
const cell = (key, part) => form.locator(`select[data-key="${key}"][data-part="${part}"]`);
check('the week arrives filled in, subject and teacher', await cell('понеделник|1', 'subject').inputValue() === 'Математика'
    && await cell('понеделник|1', 'teacher').inputValue() === 'Наставничка Прва');
check('the class\'s subjects are ticked, the others are not',
    await form.locator('input[data-subject="Македонски јазик"]').isChecked() && !(await form.locator('input[data-subject="Ликовно образование"]').isChecked()));
check('an unticked subject is not offered in a cell', !/Ликовно/.test(await cell('вторник|1', 'subject').textContent()));
await form.locator('input[data-subject="Ликовно образование"]').check();
check('ticking it offers it', /Ликовно/.test(await cell('вторник|1', 'subject').textContent()));
await cell('вторник|1', 'subject').selectOption('Ликовно образование');
await cell('вторник|1', 'teacher').selectOption('Наставник Втор');
await cell('понеделник|1', 'subject').selectOption('');
await form.locator('input[data-report="Ана Измислена"]').fill('е во III-а');
check('two changed periods and one report are counted', await form.locator('#count').textContent() === '3', await form.locator('#count').textContent());
check('only this class\'s pupils are listed, with their generation',
    /Ана Измислена/.test(await form.locator('#pupils').textContent()) && !/Бојан/.test(await form.locator('#pupils').textContent())
    && /генерација II/.test(await form.locator('#pupils').textContent()));
const waitingImage = form.waitForEvent('download');
await form.click('#image');
check('„🖼 Слика" saves the week as a PNG', (await waitingImage).suggestedFilename() === 'Распоред — II-б.png');
const waitingReply = form.waitForEvent('download');
await form.click('#save');
const replyDownload = await waitingReply;
const reply = JSON.parse(await readFile(await replyDownload.path(), 'utf8'));
check('the answer names the class and its homeroom', reply.kind === 'mtb-class-reply' && reply.class.label === 'II-б' && reply.homeroom === 'Наставничка Прва');
check('it carries the week as shown and as left', reply.baseline['понеделник|1'].subject === 'Математика' && !reply.cells['понеделник|1']
    && reply.cells['вторник|1'].subject === 'Ликовно образование' && reply.cells['вторник|1'].teacher === 'Наставник Втор', JSON.stringify(reply.cells));
check('and the report, not a move', JSON.stringify(reply.reports) === JSON.stringify([{ name: 'Ана Измислена', generation: 'II', text: 'е во III-а' }]));
check('the form asked for nothing over the network', requests.length === 0, requests.join(', '));
check('no JavaScript error in the form', formErrors.length === 0, formErrors.join(' | '));
await offline.close();

console.log('\nthe answer comes back — into the review queue');
await page.setInputFiles('#importClassFormFile', [{ name: 'c.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reply)) }]);
await page.waitForFunction(() => /Одговори од формулари/.test(document.getElementById('formReport').textContent || ''), null, { timeout: 8000 });
const queued = writes.filter((w) => w.path === '/api/forms/replies');
check('it goes to the queue whole', queued.length === 1 && queued[0].body.replies[0].reply.class.label === 'II-б');
check('nothing is written to the timetable', !writes.some((w) => /\/api\/teaching\//.test(w.path)), JSON.stringify(writes.map((w) => w.path)));
check('and it links to the review', await page.locator('#formReport a[href^="Podatoci.html?tab=forms"]').count() === 1);
console.log('\na teacher\'s own week');
const waitingTeacher = page.waitForEvent('download');
await page.click('#exportTeacherForm');
const teacherDownload = await waitingTeacher;
const teacherHtml = await readFile(await teacherDownload.path(), 'utf8');
check('the file is named for the year', teacherDownload.suggestedFilename() === 'Формулар-наставници — 2026-2027.html', teacherDownload.suggestedFilename());
check('it carries no pupil', !teacherHtml.includes('Ана Измислена') && !teacherHtml.includes('Бојан Измислен'));
const offline2 = await browser.newContext({ acceptDownloads: true });
const requests2 = [];
await offline2.route('**/*', (route) => {
    const u = route.request().url();
    if (u === 'https://form.invalid/t.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: teacherHtml });
    requests2.push(u);
    return route.abort();
});
const tf = await offline2.newPage();
const tErrors = [];
tf.on('pageerror', (e) => tErrors.push(e.message));
await tf.goto('https://form.invalid/t.html');
check('each name says what the person is', (await tf.locator('#who option').allTextContents()).some((o) => /Наставничка Прва · одделенски раководител на II-б/.test(o))
    && (await tf.locator('#who option').allTextContents()).some((o) => /Наставник Втор · предметен наставник/.test(o)));
await tf.selectOption('#who', '22');
const slot = (key, part) => tf.locator(`#grid select[data-key="${key}"][data-part="${part}"]`);
check('the week arrives filled in: class and subject', await slot('понеделник|2', 'class').inputValue() === 'III-а'
    && await slot('понеделник|2', 'subject').inputValue() === 'Англиски јазик');
check('own subjects come first', (await slot('понеделник|2', 'subject').locator('optgroup').first().getAttribute('label')) === 'Мои предмети');
await slot('понеделник|1', 'class').selectOption('II-б');
await slot('понеделник|1', 'subject').selectOption('Англиски јазик');
check('another teacher with another subject there is flagged', /⚠ во тој час: Наставничка Прва — Математика/.test(await tf.locator('#grid .warn').first().textContent()));
await slot('понеделник|1', 'subject').selectOption('Математика');
check('the same subject reads as teaching together', /заедно со Наставничка Прва/.test(await tf.locator('#grid .with').first().textContent()));
await slot('вторник|2', 'class').selectOption('III-а');
check('two changed periods are counted', await tf.locator('#count').textContent() === '2', await tf.locator('#count').textContent());
await tf.click('[data-tab="klass"]');
await tf.selectOption('#klassPick', 'II-б');
const klass = await tf.locator('#klassGrid').textContent();
check('the class view puts everybody\'s entries together, this draft included',
    /МатематикаНаставничка Прва/.test(klass) && /МатематикаНаставник Втор/.test(klass), klass);
check('and has no field to edit', await tf.locator('#klassGrid select').count() === 0);
const waitingKlassImage = tf.waitForEvent('download');
await tf.click('#klassImage');
check('the class view saves as a PNG', (await waitingKlassImage).suggestedFilename() === 'Распоред — II-б.png');
await tf.click('[data-tab="mine"]');
const waitingOwn = tf.waitForEvent('download');
await tf.click('#save');
const own = JSON.parse(await readFile(await (await waitingOwn).path(), 'utf8'));
check('the answer names the teacher and carries the week as shown and as left', own.kind === 'mtb-teacher-reply' && own.teacher.name === 'Наставник Втор'
    && own.baseline['понеделник|2'].class === 'III-а' && own.cells['понеделник|1'].class === 'II-б' && own.cells['вторник|2'].class === 'III-а', JSON.stringify(own.cells));
check('the teacher form asked for nothing over the network', requests2.length === 0, requests2.join(', '));
check('no JavaScript error in the teacher form', tErrors.length === 0, tErrors.join(' | '));
await offline2.close();
await page.setInputFiles('#importClassFormFile', [{ name: 't.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(own)) }]);
await page.waitForFunction(() => /Наставник Втор/.test(document.getElementById('formReport').textContent || ''), null, { timeout: 8000 });
check('it goes in through the same import, and says what was written', /запишани 1/.test(await page.locator('#formReport').textContent()));
check('no JavaScript error in Уреди настава', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exitCode = fails ? 1 : 0;
