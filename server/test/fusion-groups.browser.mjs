/**
 * Кабинети → a group term (063; owner, 14 Oct 2026): several pupils together
 * for the whole bell. A group cell has no picker (a picker holds one pupil and
 * would split it); „👥" opens the same check boxes Колега has. Every API call is
 * invented; the page itself is served by the running server.
 *
 *     node test/with-scratch.mjs test/fusion-groups.browser.mjs
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
const students = ['Ана', 'Бојан', 'Вера', 'Горан'].map((name, i) => ({ public_id: 'gr-' + 'abcd'[i], name: name + ' Пробна', grade: 'II-а', active: true }));
const therapist = { id: 7, name: 'Терапевтка Група', students: students.map((s) => s.public_id) };
const row = (time, pid) => ({ day: 'среда', time, therapist_id: 7, therapist_name: therapist.name, student_public_id: pid,
    student_name: students.find((s) => s.public_id === pid).name });
let sessions = ['gr-a', 'gr-b', 'gr-c'].map((pid) => row('08:00-08:40', pid));
const blocks = [];

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
            const [h, m] = body.time.split('-')[0].split(':').map(Number), start = h * 60 + m;
            const at = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
            const n = body.studentPublicIds.length, together = n > 2 || body.mode === 'together';
            const times = body.studentPublicIds.map((_, i) => n === 1 || together ? body.time
                : `${at(start + 20 * i)}-${at(start + 20 * (i + 1))}`);
            const half = [`${at(start)}-${at(start + 20)}`, `${at(start + 20)}-${at(start + 40)}`];
            sessions = sessions.filter((s) => ![body.time, ...half].includes(s.time));
            const fresh = body.studentPublicIds.map((pid, i) => row(times[i], pid));
            sessions.push(...fresh);
            return json(200, { ok: true, sessions: fresh, together, previousTogether: true });
        }
        if (req.method() !== 'GET') return json(405, { error: 'not in this test' });
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists: [JSON.parse(JSON.stringify(therapist))], teachers: [], caseloadOrder: true },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: [{ label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 }] } },
            '/api/teaching/crossing': { cells: [] }
        }[path];
        return json(data ? 200 : 401, data || {});
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#dayTabs .day-tab[data-day="среда"]');
    const cell = (time) => page.locator(`#scheduleGrid .schedule-cell[data-bell="${time}"]`).first();
    const sent = async (n) => { for (let i = 0; i < 50 && blocks.length < n; i++) await page.waitForTimeout(100); };

    await cell('08:00-08:40').locator('.group-member').first().waitFor();
    const text = await cell('08:00-08:40').innerText();
    assert.match(text, /гр\. 3/, 'a group says so');
    for (const name of ['Ана', 'Бојан', 'Вера']) assert.match(text, new RegExp(name), 'with every child in it');
    assert.equal(await cell('08:00-08:40').locator('select').count(), 0, 'and no picker that would split it');

    await cell('08:00-08:40').locator('[data-group-edit]').click();
    await page.locator('#groupDialog[open]').waitFor();
    assert.equal(await page.locator('#groupTicks input:checked').count(), 3, 'the editor opens with the group ticked');
    await page.uncheck('#groupTicks [data-group-pupil="gr-c"]');
    assert.equal(await page.isVisible('#groupWay'), true, 'two ask: together or 20 each');
    assert.equal(await page.isChecked('#groupWay [value="together"]'), true, 'and a group of two stays together unless chosen');
    await page.click('#groupDialog button[value="save"]');
    await sent(1);
    assert.deepEqual(blocks[0], { year, day: 'среда', time: '08:00-08:40', therapistId: 7, studentPublicIds: ['gr-a', 'gr-b'],
        expectedStudentPublicIds: ['gr-a', 'gr-b', 'gr-c'], mode: 'together' }, 'the one block writer, with the mode for two');
    await page.waitForFunction(() => /гр\. 2/.test(document.querySelector('#scheduleGrid .schedule-cell[data-bell="08:00-08:40"]').innerText), null, { timeout: 5000 });

    // An ordinary empty term becomes a group from its „👥".
    await cell('08:45-09:25').locator('[data-group-edit]').click();
    await page.locator('#groupDialog[open]').waitFor();
    for (const pid of ['gr-a', 'gr-c', 'gr-d']) await page.check(`#groupTicks [data-group-pupil="${pid}"]`);
    assert.equal(await page.isVisible('#groupWay'), false, 'three are a group: nothing more to choose');
    assert.match(await page.textContent('#groupCount'), /Група: 3/);
    await page.click('#groupDialog button[value="save"]');
    await sent(2);
    assert.deepEqual(blocks[1].studentPublicIds, ['gr-a', 'gr-c', 'gr-d']);
    assert.equal('mode' in blocks[1], false, 'three send no mode: they can only be together');
    await page.waitForFunction(() => /гр\. 3/.test(document.querySelector('#scheduleGrid .schedule-cell[data-bell="08:45-09:25"]').innerText), null, { timeout: 5000 });

    // „Откажи" sends nothing.
    await cell('08:45-09:25').locator('[data-group-edit]').click();
    await page.uncheck('#groupTicks [data-group-pupil="gr-d"]');
    await page.click('#groupDialog button[value="cancel"]');
    await page.waitForTimeout(300);
    assert.equal(blocks.length, 2, '„Откажи" writes nothing');

    // „Врати" puts the first group back whole.
    await page.click('.mtb-undo [data-mtb-undo="undo"]');
    await sent(3);
    assert.deepEqual([blocks[2].time, blocks[2].studentPublicIds, blocks[2].expectedStudentPublicIds], ['08:45-09:25', [], ['gr-a', 'gr-c', 'gr-d']],
        '„Врати" takes back the last change, the new group, against what it left');
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    console.log('Fusion groups: a group shows every child and no picker; „👥" edits it through the block writer with the right mode; „Откажи" sends nothing — passed.');
} finally { await browser.close(); }
