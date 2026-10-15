// Евидентен лист for the owner without a PIN (owner, 15 Oct 2026): the
// server's /api/evidence/me says „owner" from the owner's own cloud sign-in,
// the page skips the gate and offers „Пополнува". Everything here is
// invented; no server and no database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3993';
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let owner = true;
const sheetReads = [], errors = [];
const context = await browser.newContext({ viewport: { width: 1300, height: 900 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/AkciskiPlan.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: await readFile(resolve(root, 'AkciskiPlan.html')) });
    if (u.pathname === '/api/health') return json(200, { ok: true, server: { label: 'пробен' } });
    if (u.pathname === '/api/evidence/me') return owner
        ? json(200, { person: { kind: 'owner', id: 0, name: 'Администраторот' }, owner: true, permissions: { enforced: false, admin: true } })
        : json(401, { error: 'not signed in', signedOut: true });
    if (u.pathname === '/api/evidence/people') return json(200, { people: [
        { kind: 'therapist', id: 5, name: 'Измислен Терапевт', has_pin: true }, { kind: 'teacher', id: 9, name: 'Измислен Наставник', has_pin: false }] });
    if (u.pathname === '/api/years') return json(200, [{ label: '2026/2027', is_current: true }]);
    if (u.pathname === '/api/evidence/catalog') return json(200, { periods: [], sections: [] });
    if (u.pathname === '/api/categories') return json(200, { categories: [] });
    if (u.pathname === '/api/evidence/sheets') {
        sheetReads.push(u.searchParams.get('filler'));
        const all = [{ public_id: 'a', name: 'Измислен Ученик Алфа', grade: 'IV-т', sheet_id: null }, { public_id: 'b', name: 'Измислен Ученик Бета', grade: 'V-т', sheet_id: null }];
        return json(200, { year: '2026/2027', isCurrentYear: true, pupils: u.searchParams.get('filler') === 'therapist:5' ? all.slice(0, 1) : all });
    }
    return json(404, {});
});

const p = await context.newPage(); p.on('pageerror', (e) => errors.push(e.message));
await p.goto(origin + '/AkciskiPlan.html');
await p.waitForFunction(() => document.querySelectorAll('#plist .pupil').length === 2);
assert.equal(await p.isHidden('#gate'), true, 'no PIN is asked of the owner');
assert.match(await p.textContent('#who'), /Администраторот · без PIN/);
assert.equal(await p.isVisible('#filler'), true);
assert.deepEqual(await p.$$eval('#filler option', (o) => o.map((x) => x.value)), ['', 'therapist:5', 'teacher:9']);
await p.selectOption('#filler', 'therapist:5');
await p.waitForFunction(() => document.querySelectorAll('#plist .pupil').length === 1);
assert.equal(sheetReads.at(-1), 'therapist:5', 'the list is asked for that colleague\'s pupils');
await p.selectOption('#filler', '');
await p.waitForFunction(() => document.querySelectorAll('#plist .pupil').length === 2);
assert.equal(sheetReads.at(-1), null);

// Anyone else: the gate, and no „Пополнува".
owner = false;
const q = await context.newPage(); q.on('pageerror', (e) => errors.push(e.message));
await q.goto(origin + '/AkciskiPlan.html');
await q.waitForSelector('#gate:not([hidden])');
assert.equal(await q.isHidden('#filler'), true);

assert.deepEqual(errors, []);
await browser.close();
console.log('akciski owner: OK');
