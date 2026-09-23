/**
 * „Сега“ and the reminder popup in RasporediFusion.html, on a fake clock.
 * Every API call is intercepted with invented data and nothing may be written:
 * the tab reads the week already loaded, and the only thing it keeps is this
 * browser's own choice of therapists to be reminded about.
 *
 *   node test/fusion-now.browser.mjs        (needs a server serving the page)
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
const students = [
    { public_id: 'now-a', name: 'Пробен Прв', grade: 'III', active: true },
    { public_id: 'now-b', name: 'Пробна Втора', grade: 'IV', active: true },
    { public_id: 'now-c', name: 'Пробен Трет', grade: 'V', active: true }
];
const therapists = [
    { id: 1, name: 'Терапевт Пример А', students: ['now-a', 'now-b'] },
    { id: 2, name: 'Терапевт Пример Б', students: ['now-c'] },
    { id: 3, name: 'Терапевт Без Термини', students: [] }
];
const session = (day, time, therapist_id, student_public_id) => ({ day, time, therapist_id, student_public_id });
// Wednesday: A's two halves are ONE 40-minute treatment and must remind once.
const sessions = [
    session('среда', '08:00-08:20', 1, 'now-a'), session('среда', '08:20-08:40', 1, 'now-a'),
    session('среда', '08:45-09:25', 1, 'now-b'),
    session('среда', '09:40-10:20', 2, 'now-c'),
    session('четврток', '08:00-08:40', 2, 'now-c')
];

let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); passed++; };

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = [];
    await context.route('**/api/**', (route) => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(req.method() + ' ' + path); return route.fulfill({ status: 405 }); }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists, teachers: [] },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: [
                { label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 },
                { label: 'III', startsAt: '09:40', minutes: 40 }] } },
            '/api/teaching/crossing': { cells: [] }
        }[path];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    // Wednesday 23 Sep 2026, 08:05 local time.
    await page.clock.install({ time: new Date(2026, 8, 23, 8, 5, 0) });
    await page.goto(BASE + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();

    eq(await page.locator('#remindStack .remind-card').count(), 0, 'no reminder before any therapist is ticked');

    await page.click('#nowTab');
    ok(await page.locator('#nowPanel').isVisible(), 'the Сега panel is shown');
    ok(await page.locator('#schedulePanel').isHidden(), 'the grid is hidden behind it');
    eq(await page.locator('#nowSummary').textContent(), 'Во третман сега: 1 ученик.');
    const rowA = page.locator('tr[data-now-therapist="1"]');
    ok(await rowA.evaluate((row) => row.classList.contains('is-live')), 'the therapist in a treatment is marked live');
    ok(/Пробен Прв/.test(await rowA.locator('.now-current').textContent()), 'current pupil named');
    ok(/08:00–08:40 · уште 35 мин\./.test(await rowA.locator('.now-current').textContent()),
        'the two halves read as one 40-minute treatment');
    ok(/Пробна Втора.*од 08:45/.test(await rowA.locator('.now-next').textContent()), 'next pupil and start');
    ok(/слободно/.test(await page.locator('tr[data-now-therapist="2"] .now-current').textContent()), 'free therapist');
    ok(/од 09:40/.test(await page.locator('tr[data-now-therapist="2"] .now-next').textContent()), 'their next start');
    ok(/нема термини денес/.test(await page.locator('tr[data-now-therapist="3"] .now-current').textContent()),
        'a therapist with no terms today says so');

    // Tick therapist A: the treatment already running reminds at once.
    await page.check('input[data-remind="1"]');
    await page.locator('#remindStack .remind-card').first().waitFor();
    eq(await page.locator('#remindStack .remind-card').count(), 1, 'one reminder, not one per half');
    ok(/Пробен Прв/.test(await page.locator('#remindStack .remind-card').textContent()), 'the reminder names the pupil');
    ok((await page.title()).startsWith('🔔 (1)'), 'the tab title shows an open reminder');

    // 08:30: still inside the same treatment, nothing is duplicated.
    await page.clock.fastForward('25:00');
    eq(await page.locator('#remindStack .remind-card').count(), 1, 'the second half does not remind again');

    // 08:46: the next treatment started — the unanswered reminder is lost and the new one shows.
    await page.clock.fastForward('16:00');
    await page.waitForFunction(() => /Пробна Втора/.test(document.querySelector('#remindStack')?.textContent || ''));
    eq(await page.locator('#remindStack .remind-card').count(), 1, 'the old reminder is gone when the next starts');
    ok(!/Пробен Прв/.test(await page.locator('#remindStack').textContent()), 'the unanswered one did not linger');

    // „Во ред“ dismisses it, and it stays dismissed across a reload.
    await page.click('#remindStack [data-remind-ok]');
    eq(await page.locator('#remindStack .remind-card').count(), 0, 'dismissed');
    ok(!(await page.title()).startsWith('🔔'), 'the title clears');
    await page.clock.fastForward('00:30');
    eq(await page.locator('#remindStack .remind-card').count(), 0, 'a dismissed reminder does not come back on the next tick');
    await page.reload();
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    eq(await page.locator('#remindStack .remind-card').count(), 0, 'nor after a reload');
    await page.click('#nowTab');
    ok(await page.locator('input[data-remind="1"]').isChecked(), 'the ticked therapist is remembered in this browser');
    ok(!(await page.locator('input[data-remind="2"]').isChecked()), 'and only that one');

    // An unticked therapist never reminds, even when their treatment starts.
    await page.clock.fastForward('55:00'); // 09:41
    eq(await page.locator('#remindStack .remind-card').count(), 0, 'therapist B is not ticked, so no popup at 09:40');
    await page.check('input[data-remind="2"]');
    await page.locator('#remindStack .remind-card').first().waitFor();
    ok(/Пробен Трет/.test(await page.locator('#remindStack').textContent()), 'ticking B during the treatment reminds');
    await page.click('#nowRemindNone');
    eq(await page.locator('#remindStack .remind-card').count(), 0, '„Ниеден“ clears every reminder');

    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mtb_fusion_remind')).sort());
    ok(stored.every((k) => ['mtb_fusion_remind_seen_v1', 'mtb_fusion_remind_v1'].includes(k)), 'only the two reminder keys');
    eq(writes.length, 0, 'nothing was written to the server: ' + writes.join(', '));
    eq(errors.length, 0, 'no page errors: ' + errors.join(' | '));
    console.log('fusion-now: ' + passed + ' assertions passed');
} finally {
    await browser.close();
}
