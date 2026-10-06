/**
 * Кабинети → „↶ Врати" / „↷ Повтори" for one block (owner, 6 Oct 2026).
 *
 * A change of a term is taken back through the SAME block writer, with what
 * the change left as `expected`; a block somebody changed since is refused in
 * the writer's own words and nothing is forced. Every API call is invented;
 * the page itself is served by the running server.
 *
 *     npm run start
 *     npm run test:fusion-undo
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
const students = [
    { public_id: 'un-a', name: 'Ана Пробна', grade: 'II-а', active: true },
    { public_id: 'un-b', name: 'Бојан Пробен', grade: 'III-а', active: true }
];
const therapist = { id: 7, name: 'Терапевт Враќање', students: ['un-a', 'un-b'] };
let sessions = [{ day: 'среда', time: '08:00-08:40', therapist_id: 7, therapist_name: therapist.name, student_public_id: 'un-a', student_name: 'Ана Пробна' }];
const blocks = [];
let refuseNext = null;

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = [];
    await context.route('**/api/**', async (route) => {
        const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname);
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (req.method() === 'PUT' && path === '/api/schedule/block') {
            const body = req.postDataJSON();
            blocks.push(body);
            if (refuseNext) { const answer = refuseNext; refuseNext = null; return json(409, answer); }
            sessions = body.studentPublicIds.map((pid) => ({ day: body.day, time: body.time, therapist_id: 7, therapist_name: therapist.name,
                student_public_id: pid, student_name: students.find((s) => s.public_id === pid).name }));
            return json(200, { ok: true, sessions });
        }
        if (req.method() !== 'GET') return json(405, { error: 'not in this test' });
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists: [JSON.parse(JSON.stringify(therapist))], teachers: [], caseloadOrder: true },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: [{ label: 'I', startsAt: '08:00', minutes: 40 }] } },
            '/api/teaching/crossing': { cells: [] }
        }[path];
        return json(data ? 200 : 401, data || {});
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#dayTabs .day-tab[data-day="среда"]');

    const first = '#scheduleGrid select[data-session-day="среда"][data-therapist-id="7"][data-block-part="0"]';
    const shown = () => page.$eval(first, (s) => s.value);
    const pill = () => page.$$eval('.mtb-undo button', (bs) => bs.map((b) => b.textContent + (b.disabled ? ' off' : '')));
    const settled = () => page.waitForFunction(() => {
        const b = [...document.querySelectorAll('.mtb-undo button')];
        return b.length && b.some((x) => !x.disabled);
    }, null, { timeout: 5000 });
    const sent = (n) => page.waitForFunction((k) => true, n).then(async () => { for (let i = 0; i < 50 && blocks.length < n; i++) await page.waitForTimeout(100); });

    await page.locator(first).waitFor();
    assert.equal(await page.$('.mtb-undo'), null, 'no control before anything was changed');
    await page.selectOption(first, 'un-b');
    await sent(1);
    assert.deepEqual(blocks[0], { year, day: 'среда', time: '08:00-08:40', therapistId: 7, studentPublicIds: ['un-b'], expectedStudentPublicIds: ['un-a'] });
    await settled();
    assert.deepEqual(await pill(), ['↶ Врати (1)', '↷ Повтори off'], 'one step to take back');
    assert.match(await page.getAttribute('.mtb-undo [data-mtb-undo="undo"]', 'title'), /Врати: Терапевт Враќање · среда · 08:00-08:40/);

    await page.click('.mtb-undo [data-mtb-undo="undo"]');
    await sent(2);
    assert.deepEqual(blocks[1], { year, day: 'среда', time: '08:00-08:40', therapistId: 7, studentPublicIds: ['un-a'], expectedStudentPublicIds: ['un-b'] },
        '„Врати" writes the block back, against what the change left');
    await settled();
    await page.locator(first).waitFor();
    assert.equal(await shown(), 'un-a', 'the schedule is read again and shows the pupil who was there');
    assert.deepEqual(await pill(), ['↶ Врати off', '↷ Повтори (1)']);

    await page.click('.mtb-undo [data-mtb-undo="redo"]');
    await sent(3);
    assert.deepEqual(blocks[2].studentPublicIds, ['un-b']);
    assert.deepEqual(blocks[2].expectedStudentPublicIds, ['un-a'], '„Повтори" makes the change again, against what „Врати" put back');
    await settled();
    assert.equal(await shown(), 'un-b');

    // In the meantime the pupil was booked with somebody else: the writer refuses, nothing is forced.
    refuseNext = { error: 'overlap', doubleBooked: true, therapistName: 'Друг Терапевт', time: '08:00-08:40' };
    await page.click('.mtb-undo [data-mtb-undo="undo"]');
    await sent(4);
    await page.waitForFunction(() => (document.querySelector('.mtb-toast') || { dataset: {} }).dataset.kind === 'error', null, { timeout: 5000 });
    assert.match(await page.textContent('.mtb-toast'), /Не е вратено — Терапевт Враќање · среда · 08:00-08:40: Ученикот веќе е закажан кај Друг Терапевт/);
    await page.waitForFunction(() => document.querySelector('.mtb-undo').hidden, null, { timeout: 5000 });
    assert.equal(await shown(), 'un-b', 'the block stays as the database holds it');
    assert.equal(blocks.length, 4, 'and nothing more was sent');
    assert.deepEqual(errors, []);
    console.log('Fusion undo: a block is taken back and made again through the block writer; a refusal is said and the step dropped — passed.');
} finally { await browser.close(); }
