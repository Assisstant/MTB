/**
 * Колега → „✓ Присуство" for a teacher: a class's pupils by day, for the meals
 * (owner, 5 Oct 2026; migration 057). Every API call is invented here; what
 * the server allows is asserted against a database in class-attendance.test.ts.
 *
 *   - a teacher without a cabinet has the tab, opened on their own class;
 *   - „✓ Сите присутни" sends the day's unmarked pupils in ONE write, with
 *     what the page saw as `expected`, and the „Присутни" row follows;
 *   - a click cycles one pupil; a refusal is told and the sheet re-read;
 *   - a class they only teach can be marked only on the lesson's weekday;
 *   - the owner sees „Присутни по паралелки — за храна", numbers per class.
 *
 *   node test/kolega-class-attendance.browser.mjs   (SHOT=<dir> keeps pictures)
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3990';
const TODAY = '2026-10-06';                       // a Tuesday
const days = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
const pupils = [{ studentId: 1, name: 'Измислен Ученик Еден' }, { studentId: 2, name: 'Измислен Ученик Два' }, { studentId: 3, name: 'Измислен Ученик Три' }];
const classes = [
    { classId: 21, label: 'ИЗМ-А', alias: 'Изм. А', homeroom: true, weekdays: [] },
    { classId: 22, label: 'ИЗМ-Б', alias: null, homeroom: false, weekdays: ['вторник'] }];
const marks = new Map();                           // classId|date|studentId → status
const writes = [], errors = [];
let owner = false, refuseNext = false;

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1300, height: 1000 }, serviceWorkers: 'block' });
await context.addInitScript(() => localStorage.setItem('mtb_portal_token_v1', 'a'.repeat(64)));
await context.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.origin !== origin) return route.fulfill({ status: 404, body: '' });
    if (u.pathname === '/Kolega.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: await readFile(resolve(root, 'Kolega.html')) });
    if (u.pathname === '/api/portal/me') return json(200, { person: { employeeId: 7, name: 'Измислена Наставничка' }, usernames: { latin: 'T', cyrillic: 'Т' },
        year: '2026/2027', roles: ['teacher', 'homeroom'], teacher: { id: 3, kind: 'odd', classes: [] }, therapist: null, author: 'Измислен Автор', owner });
    if (u.pathname === '/api/attendance/transport/access') return json(owner ? 200 : 403, { allowed: owner });
    if (u.pathname === '/api/portal/week') return json(200, { year: '2026/2027', days, periods: [], me: { teacherId: 3, therapistId: null, homeroom: ['ИЗМ-А'] },
        classes: [], teachers: [], lessons: [], clashes: [], notices: [], classPupils: {} });
    if (u.pathname === '/api/portal/class-attendance/classes') return json(200, { classes, readOnly: false });
    if (u.pathname === '/api/portal/class-attendance' && req.method() === 'PUT') {
        const b = req.postDataJSON(); writes.push(b);
        if (refuseNext) { refuseNext = false; return json(409, { error: 'Пробно: присуството е изменето во друг прозорец.' }); }
        b.marks.forEach((m) => { const k = `${b.classId}|${b.date}|${m.studentId}`; if (m.status) marks.set(k, m.status); else marks.delete(k); });
        return json(200, { ok: true, written: b.marks.length });
    }
    if (u.pathname === '/api/portal/class-attendance') {
        const id = Number(u.searchParams.get('classId')), from = u.searchParams.get('from'), to = u.searchParams.get('to');
        const cls = classes.find((c) => c.classId === id), out = [];
        for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
            const date = new Date(t).toISOString().slice(0, 10), wd = new Date(t).getUTCDay(), dayName = days[wd - 1] || 'недела';
            const closed = wd === 0 || wd === 6 ? 'Викенд' : null;
            const day = { date, dayName, closed, future: date > TODAY, marks: {} };
            day.mayMark = !closed && date <= TODAY && (cls.homeroom || cls.weekdays.includes(dayName));
            pupils.forEach((p) => { const s = marks.get(`${id}|${date}|${p.studentId}`); if (s) day.marks[p.studentId] = s; });
            out.push(day);
        }
        return json(200, { class: { id, label: cls.label, alias: cls.alias }, from, to, year: '2026/2027', today: TODAY, calendarAvailable: true, pupils, days: out, readOnly: false });
    }
    if (u.pathname === '/api/attendance/class-summary') return json(200, { date: u.searchParams.get('date'), year: '2026/2027', closed: null, calendarAvailable: true,
        classes: [{ classId: 21, label: 'ИЗМ-А', alias: 'Изм. А', pupils: 3, present: 2, absent: 1, unmarked: 0, markedBy: ['Измислена Наставничка'] },
                  { classId: 22, label: 'ИЗМ-Б', alias: null, pupils: 4, present: 3, absent: 0, unmarked: 1, markedBy: [] }],
        totals: { pupils: 7, present: 5, absent: 1, unmarked: 1 } });
    if (u.pathname === '/api/attendance/transport') return json(200, { month: u.searchParams.get('month'), year: '2026/2027', generatedAt: '2026-10-06T08:00:00Z', note: '', pupils: [] });
    return json(404, {});
});

const p = await context.newPage();
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { if (process.env.SHOT) await p.screenshot({ path: join(process.env.SHOT, name), fullPage: true }); };
const cell = (date, id) => p.locator(`[data-class-mark="${date}|${id}"]`);
const settled = () => p.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.querySelector('#attendanceSheet table'));
let failed = 0;
const step = async (label, fn) => {
    try { await fn(); console.log('  ok   ' + label); }
    catch (e) { failed++; console.log('  FAIL ' + label + '\n       ' + e.message.split('\n')[0]); }
};

try {
    await p.goto(origin + '/Kolega.html');
    await p.click('#welcomeContinue');
    console.log('a teacher without a cabinet');
    await step('has „✓ Присуство", opened on the class they lead, for the meals', async () => {
        await p.click('[data-tab="attendance"]');
        await p.locator('#attendanceDate').fill('2026-10-05'); await settled();
        assert.match(await p.textContent('#attendanceSheet h2'), /Изм\. А/);
        assert.match(await p.textContent('#tabHint'), /храната/);
        assert.match(await p.textContent('#attendanceSheet'), /не влегува во извештајот за превоз/);
    });
    await step('the choice lists both classes and neither the transport nor the kitchen count', async () => {
        const options = await p.$$eval('#attendanceScope option', (o) => o.map((x) => x.value));
        assert.deepEqual(options, ['class:21', 'class:22']);
    });
    await shot('class-attendance-before.png');
    await step('„✓ Сите присутни" is one write of the unmarked pupils, expected empty', async () => {
        await p.click('[data-class-all="2026-10-05"]'); await settled();
        const w = writes.at(-1);
        assert.equal(w.classId, 21); assert.equal(w.date, '2026-10-05');
        assert.deepEqual(w.marks, pupils.map((x) => ({ studentId: x.studentId, status: 'present', expected: null })));
        assert.match(await cell('2026-10-05', 1).getAttribute('class'), /present/);
        assert.equal(await p.locator('[data-class-all="2026-10-05"]').count(), 0, 'nothing left to mark: the button goes');
        const total = await p.locator('tr.class-total td').allTextContents();
        assert.equal(total[0], '3');
    });
    await step('a click moves one pupil on: present → absent, and the total follows', async () => {
        await cell('2026-10-05', 2).click(); await settled();
        assert.deepEqual(writes.at(-1).marks, [{ studentId: 2, status: 'absent', expected: 'present' }]);
        assert.match(await cell('2026-10-05', 2).getAttribute('class'), /absent/);
        assert.equal((await p.locator('tr.class-total td').allTextContents())[0], '2');
    });
    await step('a refusal is said, and the sheet is read again rather than shown as saved', async () => {
        refuseNext = true;
        await cell('2026-10-05', 3).click(); await settled();
        assert.match(await p.textContent('#weekMsg'), /изменето во друг прозорец/);
        assert.match(await cell('2026-10-05', 3).getAttribute('class'), /present/);
    });
    await step('a future day and a weekend cannot be marked', async () => {
        assert.equal(await cell('2026-10-07', 1).isDisabled(), true);
        assert.equal(await p.locator('[data-class-mark^="2026-10-10|"]').count(), 0, 'the weekend is not a column');
    });
    await shot('class-attendance-marked.png');
    await step('a class they only teach: marked on the lesson day only', async () => {
        await p.selectOption('#attendanceScope', 'class:22'); await settled();
        assert.equal(await cell('2026-10-05', 1).isDisabled(), true, 'Monday: no lesson there');
        assert.equal(await cell('2026-10-06', 1).isDisabled(), false, 'Tuesday: their lesson');
    });

    console.log('\nthe owner: the count for the kitchen');
    owner = true;
    await p.reload(); await p.click('#welcomeContinue');
    await step('„Присутни по паралелки — за храна" is offered, beside the transport report', async () => {
        await p.click('[data-tab="attendance"]');
        await p.waitForFunction(() => document.querySelector('#attendanceScope option[value="meals"]'));
        const options = await p.$$eval('#attendanceScope option', (o) => o.map((x) => x.value));
        assert.deepEqual(options, ['class:21', 'class:22', 'meals', 'transport']);
    });
    await step('and the owner\'s look at a teacher still opens on HER class, not on transport', async () => {
        await settled();
        assert.equal(await p.$eval('#attendanceScope', (s) => s.value), 'class:21');
        assert.match(await p.textContent('#attendanceSheet h2'), /Изм\. А/);
    });
    await step('one day, per class and in total, with the unmarked named as such', async () => {
        await p.selectOption('#attendanceScope', 'meals'); await settled();
        assert.match(await p.textContent('.meals-total'), /Присутни: 5/);
        assert.match(await p.textContent('.meals-total'), /уште 1 неозначени/);
        const total = await p.locator('table.meals tr.class-total').innerText();
        assert.match(total, /Вкупно\s+7\s+5\s+1\s+1/);
        assert.equal(await p.getAttribute('#attendanceDate', 'type'), 'date');
    });
    await shot('class-attendance-meals.png');
    await step('no page errors', async () => assert.deepEqual(errors, []));
} finally {
    await browser.close();
}
console.log(failed ? `\n${failed} failed\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
