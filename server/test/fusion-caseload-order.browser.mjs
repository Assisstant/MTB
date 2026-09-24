/**
 * ▲▼ on a therapist's own list in RasporediFusion.html (owner, 24 Sep 2026).
 *
 * Every API call is intercepted with invented data; the one write allowed is
 * the order itself, and it is recorded. What this proves:
 *   - the list reads in the order the server gives, not re-sorted by name;
 *   - one click is one place and ONE save;
 *   - a held arrow keeps moving every 0.3 s and still saves ONCE, on release;
 *   - Enter on a focused arrow is one place and one save;
 *   - the printed list and the picker in a schedule cell follow the same order;
 *   - an older server (no `caseloadOrder`) keeps the old sort and shows no arrows.
 *
 *     npm run start
 *     CHROME=... npm run test:fusion-order
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
// Names chosen so that alphabetical order is NOT the stored order.
const students = [
    { public_id: 'ord-c', name: 'Ведран Пробен', grade: 'VI-а', active: true },
    { public_id: 'ord-a', name: 'Анда Пробна', grade: 'IX-б', active: true },
    { public_id: 'ord-b', name: 'Борис Пробен', grade: 'II-а', active: true },
    { public_id: 'ord-d', name: 'Гоце Пробен', grade: 'V-а', active: true }
];
const therapist = { id: 7, name: 'Терапевт Редослед', students: ['ord-c', 'ord-a', 'ord-b', 'ord-d'] };
let serverKnowsOrder = true;
const puts = [];

const names = (ids) => ids.map((id) => students.find((s) => s.public_id === id).name.split(' ')[0]);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = [], otherWrites = [];
    await context.addInitScript(() => { window.print = () => {}; });
    await context.route('**/api/**', async (route) => {
        const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname);
        if (req.method() === 'PUT' && path === `/api/therapists/${therapist.name}/students-order`) {
            const body = JSON.parse(req.postData() || '{}');
            puts.push(body.order);
            therapist.students = body.order.slice();
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        }
        if (req.method() !== 'GET') { otherWrites.push(req.method() + ' ' + path); return route.fulfill({ status: 405 }); }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': Object.assign({ year, students, therapists: [JSON.parse(JSON.stringify(therapist))], teachers: [] },
                serverKnowsOrder ? { caseloadOrder: true } : {}),
            '/api/schedule/sessions': { sessions: [] },
            '/api/teaching/timetable': { bells: { kabinet: [{ label: 'I', startsAt: '08:00', minutes: 40 }] } },
            '/api/teaching/crossing': { cells: [] }
        }[path];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#rosterTab');
    await page.locator('#therapistRosterRows tr[data-student-id]').first().waitFor();
    const shown = () => page.locator('#therapistRosterRows tr[data-student-id]').evaluateAll((rs) => rs.map((r) => r.dataset.studentId));
    const arrowOf = (id, delta) => `#therapistRosterRows [data-caseload-key="${id}"][data-caseload-move="${delta}"]`;

    assert.deepEqual(names(await shown()), ['Ведран', 'Анда', 'Борис', 'Гоце'], 'the list reads in the stored order, not by name');
    assert.equal(await page.locator(arrowOf('ord-c', -1)).isDisabled(), true, 'the first row cannot go up');
    assert.equal(await page.locator(arrowOf('ord-d', 1)).isDisabled(), true, 'the last row cannot go down');

    // One click: one place, one save.
    await page.click(arrowOf('ord-c', 1));
    await page.waitForTimeout(400);
    assert.deepEqual(names(await shown()), ['Анда', 'Ведран', 'Борис', 'Гоце']);
    assert.equal(puts.length, 1, 'one click is one save');
    assert.deepEqual(names(puts[0]), ['Анда', 'Ведран', 'Борис', 'Гоце']);

    // Held: a step at once, another every 0.3 s — and nothing saved until release.
    const press = async (selector, ms) => {
        const b = await page.locator(selector).boundingBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(ms);
    };
    await press(arrowOf('ord-d', -1), 450);                        // steps at 0 and 300 ms
    assert.deepEqual(names(await shown()), ['Анда', 'Гоце', 'Ведран', 'Борис'], 'held, it moved twice in 0.45 s');
    assert.equal(puts.length, 1, 'nothing is saved while the arrow is held');
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.equal(puts.length, 2, 'two places held is ONE save, on release');
    assert.deepEqual(names(puts[1]), ['Анда', 'Гоце', 'Ведран', 'Борис']);

    // Held into the top: it stops there and saves once — and letting go adds nothing.
    await press(arrowOf('ord-d', -1), 1200);
    assert.deepEqual(names(await shown()), ['Гоце', 'Анда', 'Ведран', 'Борис'], 'it stops at the top');
    assert.equal(puts.length, 3, 'reaching the end saves once, without waiting for the release');
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.equal(puts.length, 3, 'and the release does not save again');

    // A short press is one place, not a burst.
    await press(arrowOf('ord-b', -1), 120);
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.deepEqual(names(await shown()), ['Гоце', 'Анда', 'Борис', 'Ведран'], 'a short press moves one place');
    assert.equal(puts.length, 4);

    // Keyboard: Enter on a focused arrow is one place and one save.
    await page.focus(arrowOf('ord-a', 1));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.deepEqual(names(await shown()), ['Гоце', 'Борис', 'Анда', 'Ведран'], 'Enter moves one place');
    assert.equal(puts.length, 5, 'Enter is one save');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.caseloadKey), 'ord-a',
        'focus stays on the same pupil\'s arrow, so the keyboard can keep going');

    // The same order in the printed list and in the picker of a schedule cell.
    await page.click('#listsTab');
    const listed = await page.locator('[data-report-therapist="7"] table.report-table').first().locator('tbody tr td:nth-child(2)').allTextContents();
    assert.deepEqual(listed.map((n) => n.split(' ')[0]), ['Гоце', 'Борис', 'Анда', 'Ведран'], 'the printed list follows the order');
    await page.click('#scheduleTab');
    const picker = await page.locator('#scheduleGrid select').first().locator('option').allTextContents();
    const pupilsInPicker = picker.filter((t) => / - /.test(t)).map((t) => t.split(' - ')[1].split(' ')[0]);
    assert.deepEqual(pupilsInPicker, ['Гоце', 'Борис', 'Анда', 'Ведран'], 'the picker in a cell follows the order');

    // An older server: the old sort (class, then name) and no arrows.
    serverKnowsOrder = false;
    await page.reload();
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#rosterTab');
    await page.locator('#therapistRosterRows tr[data-student-id]').first().waitFor();
    assert.deepEqual(names(await shown()), ['Борис', 'Анда', 'Гоце', 'Ведран'], 'without the flag, the old sort (class label as text, then name)');
    assert.equal(await page.locator('#therapistRosterRows .ord-btn').count(), 0, 'and no arrows it could not save');

    assert.deepEqual(otherWrites, []);
    assert.deepEqual(errors, []);
    console.log('Fusion caseload order: stored order read everywhere, one click = one save, a held arrow = one save, Enter, older server fallback — passed.');
} finally { await browser.close(); }
