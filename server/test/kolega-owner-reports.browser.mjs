// The owner's attendance reports without a colleague sign-in (owner, 14 Oct
// 2026): Кабинети → „🚌 Превоз" and „🔍 Барај" open Kolega.html with
// `#report=…`. No colleague token: the owner's own sign-in decides. Every
// response here is invented; nothing reaches a database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3991';
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let ownerAllowed = true;
const asked = [], portalCalls = [], errors = [];
const context = await browser.newContext({ viewport: { width: 1300, height: 900 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/Kolega.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: await readFile(resolve(root, 'Kolega.html')) });
    if (u.pathname.startsWith('/api/portal/')) { portalCalls.push(u.pathname); return json(u.pathname === '/api/portal/door' ? 200 : 401, {}); }
    if (u.pathname === '/api/attendance/transport/access') return asked.push('access'), json(ownerAllowed ? 200 : 403, ownerAllowed ? { allowed: true } : { error: 'Пробно одбиено.' });
    if (u.pathname === '/api/attendance/transport') {
        asked.push(u.search);
        const month = u.searchParams.get('month');
        return json(200, { month, year: '2026/2027', generatedAt: '2026-10-14T12:00:00Z', note: 'Само потврдени различни датуми.', pupils: [
            { studentId: 21, name: 'Измислен Надворешен Гама', dates: [month + '-06', month + '-13'], daysPresent: 2 }] });
    }
    if (u.pathname === '/api/attendance/class-summary') {
        asked.push(u.search);
        return json(200, { date: u.searchParams.get('date'), year: '2026/2027', closed: null,
            classes: [{ classId: 1, label: 'Измислена I-1', alias: '', pupils: 5, present: 3, absent: 1, unmarked: 1, markedBy: ['Измислен Наставник'] }],
            totals: { pupils: 5, present: 3, absent: 1, unmarked: 1 } });
    }
    return json(404, {});
});

const p = await context.newPage();
p.on('pageerror', (e) => errors.push(e.message));

// Transport, straight from Кабинети: no login, no colleague call that needs a token.
await p.goto(origin + '/Kolega.html#tab=attendance&report=transport');
await p.waitForSelector('#attendanceSheet table.transport-dates');
assert.equal(await p.isHidden('#login'), true, 'no colleague sign-in is asked for');
assert.equal(await p.textContent('#homeName'), 'Извештаи за присуство');
assert.match(await p.textContent('#attendanceSheet'), /Измислен Надворешен Гама/);
assert.equal(asked.at(-1).includes('year='), false, 'the server\'s current year answers; no empty year is sent');
for (const id of ['tabs', 'logout', 'openPassword', 'openNotices', 'weekSheet', 'stay', 'plan'])
    assert.equal(await p.isHidden('#' + id), true, id + ' belongs to a colleague and stays hidden');
assert.equal(await p.isVisible('#openWorkspace'), true);
assert.deepEqual(await p.$$eval('#attendanceScope option', (o) => o.map((x) => x.value)), ['meals', 'transport']);
assert.equal(await p.isEnabled('[data-att-docx]'), true, 'Word, as on the colleague page');
assert.equal(portalCalls.filter((c) => c !== '/api/portal/door').length, 0, 'no colleague API is called: ' + portalCalls.join(', '));

// The other report on the same page.
await p.selectOption('#attendanceScope', 'meals');
await p.waitForSelector('#attendanceSheet .meals-total');
assert.match(await p.textContent('#attendanceSheet'), /Присутни: 3/);
assert.equal(asked.at(-1).includes('year='), false);

// Asked for directly: `#report=meals`.
const q = await context.newPage(); q.on('pageerror', (e) => errors.push(e.message));
await q.goto(origin + '/Kolega.html#report=meals');
await q.waitForSelector('#attendanceSheet .meals-total');
await q.close();

// Without the owner's sign-in it is the ordinary login, nothing more.
ownerAllowed = false;
const r = await context.newPage(); r.on('pageerror', (e) => errors.push(e.message));
await r.goto(origin + '/Kolega.html#tab=attendance&report=transport');
await r.waitForSelector('#login:not([hidden])');
assert.equal(await r.isHidden('#home'), true);

// A plain visit without `#report` never asks for the owner's access.
ownerAllowed = true;
asked.length = 0;
const s = await context.newPage(); s.on('pageerror', (e) => errors.push(e.message));
await s.goto(origin + '/Kolega.html');
await s.waitForSelector('#login:not([hidden])');
assert.equal(asked.length, 0);

assert.deepEqual(errors, []);
await browser.close();
console.log('kolega owner reports: OK');
