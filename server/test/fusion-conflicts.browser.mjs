/** Conflict display only. All API calls and people invented; no database writes. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const origin = 'http://localhost:4619';
const year = '2026/2027';
const students = ['a', 'b', 'c', 'd'].map((id) => ({ public_id: id, name: id === 'b' ? 'Пробен Ученик а' : 'Пробен Ученик ' + id, grade: 'III', active: true }));
const therapists = [1, 2, 3].map((id) => ({ id, name: 'Пробен Терапевт ' + id, students: students.map((s) => s.public_id) }));
const session = (day, time, therapist, pupil) => ({ day, time, therapist_id: therapist, therapist_name: therapists[therapist - 1].name, student_public_id: pupil, student_name: students.find((s) => s.public_id === pupil).name });
let sessions = [
    session('понеделник', '08:00-08:20', 1, 'a'), session('понеделник', '08:20-08:40', 1, 'b'),
    session('понеделник', '08:00-08:40', 2, 'a'), session('понеделник', '08:00-08:40', 3, 'a'),
    session('вторник', '08:00-08:20', 1, 'c'), session('вторник', '08:20-08:40', 2, 'c'),
    session('среда', '08:00-08:40', 1, 'a'), session('среда', '08:00-08:40', 2, 'a'),
    session('четврток', '08:00-08:40', 1, 'd'), session('четврток', '08:00-08:20', 1, 'd')
];
let failRead = false, refuse = null, restricted = false, failWrite = false;
const writes = [], errors = [];
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname.startsWith('/api/')) {
            if (req.method() !== 'GET') {
                const body = req.postDataJSON();
                writes.push({ path: url.pathname, body });
                if (failWrite) return route.abort();
                if (refuse) return json(409, refuse);
                sessions = sessions.filter((s) => !(s.day === body.day && s.therapist_id === body.therapistId && s.time === body.time));
                const added = (body.studentPublicIds || []).map((id) => session(body.day, body.time, body.therapistId, id));
                sessions.push(...added);
                return json(200, { sessions: added });
            }
            if (url.pathname === '/api/schedule/sessions' && failRead) return json(503, { error: 'Пробен прекин' });
            const data = {
                '/api/health': { ok: true, signinRequired: restricted, server: { label: 'Пробна база' } },
                '/api/evidence/me': { person: { id: 1, kind: 'therapist', name: therapists[0].name }, permissions: { enforced: restricted, admin: false } },
                '/api/years': [{ id: 1, label: year, is_current: true }, { id: 2, label: '2025/2026', is_current: false }],
                '/api/roster': { year, students, therapists, teachers: [] },
                '/api/schedule/sessions': { sessions: url.searchParams.get('year') === '2025/2026' ? [] : sessions },
                '/api/teaching/timetable': { bells: { kabinet: [8, 9, 10, 11, 12, 13].map((h, i) => ({ label: ['I', 'II', 'III', 'IV', 'V', 'VI'][i], startsAt: String(h).padStart(2, '0') + ':00', minutes: 40 })) } },
                '/api/teaching/crossing': { cells: [] }
            }[url.pathname];
            return json(data ? 200 : 401, data || {});
        }
        const name = decodeURIComponent(url.pathname.split('/').pop());
        if (name === 'mtb-runtime.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.MTB_CLOUD_SAME_ORIGIN=false;' });
        try { return route.fulfill({ contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(name)], body: await readFile(path.join(root, name)) }); }
        catch { return route.fulfill({ status: 404, body: '' }); }
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/RasporediFusion.html');
    await page.locator('.schedule-grid').first().waitFor();
    await page.click('[data-day="понеделник"]');
    const count = async (n) => { await page.waitForFunction((n) => document.querySelector('#metricConflicts').textContent === n, String(n)); };
    await count(1);
    await page.selectOption('#focus', '1');
    await count(1);
    const half = (i) => page.locator('select[data-session-day="понеделник"][data-therapist-id="1"][data-block-time="08:00-08:40"][data-block-part="' + i + '"]');
    assert.equal(await half(0).evaluate((e) => e.closest('.student-slot').classList.contains('conflict')), true);
    assert.equal(await half(1).evaluate((e) => e.closest('.student-slot').classList.contains('conflict')), false, 'same name, different id; second half stays clear');
    await page.click('#openConflicts');
    assert.equal(await page.locator('.conflict-group').count(), 1);
    assert.equal(await page.locator('.conflict-pair').count(), 2, 'focused cabinet only its two pairs');
    await page.locator('[data-open-conflict]').nth(1).click();
    assert.equal(await page.locator('#focus').inputValue(), '2');
    await page.goBack();
    assert.equal(await page.locator('#focus').inputValue(), '1');
    await page.goForward();
    assert.equal(await page.locator('#focus').inputValue(), '2');
    await page.selectOption('#viewMode', 'week');
    await page.selectOption('#focus', '');
    await count(2);
    await page.click('#openConflicts');
    assert.equal(await page.locator('.conflict-group').count(), 2);
    assert.equal(await page.locator('.conflict-pair').count(), 4, 'three-way Monday plus Wednesday');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#openConflicts').evaluate((e) => document.activeElement === e), true);
    await page.selectOption('#focus', '1');
    await count(2);
    await page.click('#classWeekTab');
    await count(2);
    await page.click('#scheduleTab');
    await page.selectOption('#viewMode', 'day');
    await page.click('[data-day="вторник"]');
    await count(0);
    await page.click('[data-day="четврток"]');
    await count(0);
    assert.equal(await page.locator('.cell-irregular').count(), 1);
    assert.equal(writes.length, 0, 'reading and navigating never writes');

    // Both writers refuse at the cell, even after the 409 reload redraws it.
    refuse = { doubleBooked: true, therapistName: therapists[1].name, studentName: students[0].name, time: '13:20-13:40' };
    await page.selectOption('#focus', '1');
    const bottom = page.locator('select[data-block-time="13:00-13:40"][data-therapist-id="1"]');
    await bottom.selectOption('a');
    await page.locator('.cell-failure').waitFor();
    assert.match(await page.locator('.cell-failure').innerText(), /13:20.*13:40.*Промената не е зачувана/s);
    assert.equal(await bottom.inputValue(), '');
    assert.equal(await page.locator('.cell-failure').evaluate((e) => e.getBoundingClientRect().top >= 0 && e.getBoundingClientRect().bottom <= innerHeight), true);
    await page.click('#refresh');
    await page.locator('#busyLayer.on').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.cell-failure').count(), 1, 'failure survives refresh');
    await page.locator('[data-dismiss-failure]').click();
    const legacy = page.locator('select[data-legacy-session][data-session-time="08:00-08:40"][data-therapist-id="1"]');
    await legacy.selectOption('a');
    await page.locator('.cell-failure').waitFor();
    assert.equal(writes.at(-1).path, '/api/schedule/session');
    assert.equal(await legacy.inputValue(), 'd');
    await page.locator('[data-dismiss-failure]').click();
    refuse = { actualStudentPublicIds: [], error: 'stale' };
    await bottom.selectOption('a');
    await page.locator('.cell-failure').waitFor();
    assert.match(await page.locator('.cell-failure').innerText(), /друг уред/);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.locator('.cell-failure').scrollIntoViewIfNeeded();
    if (process.env.SHOT) {
        await mkdir(process.env.SHOT, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SHOT, 'cell-light.png') });
        await page.evaluate(() => window.MTBTheme.set('dark'));
        await page.screenshot({ path: path.join(process.env.SHOT, 'cell-dark.png') });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('[data-dismiss-failure]').click();
    refuse = null;
    await page.selectOption('#viewMode', 'week');
    await page.selectOption('#focus', '2');
    await page.locator('select[data-session-day="среда"][data-block-time="08:00-08:40"]').selectOption('');
    await count(1);
    await page.click('#openConflicts');
    assert.equal(await page.locator('.conflict-group').count(), 1);
    if (process.env.SHOT) await page.screenshot({ path: path.join(process.env.SHOT, 'list-dark.png') });
    await page.setViewportSize({ width: 390, height: 780 });
    assert.equal(await page.locator('#conflictDialog').evaluate((e) => e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= innerWidth), true);
    if (process.env.SHOT) {
        await page.screenshot({ path: path.join(process.env.SHOT, 'list-mobile-dark.png') });
        await page.evaluate(() => window.MTBTheme.set('light'));
        await page.screenshot({ path: path.join(process.env.SHOT, 'list-mobile-light.png') });
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    failWrite = true;
    await page.locator('select[data-session-day="среда"][data-block-time="13:00-13:40"]').selectOption('b');
    await page.locator('.cell-failure').waitFor();
    assert.match(await page.locator('.cell-failure').innerText(), /Нема врска со серверот/);
    failWrite = false;
    failRead = true;
    await page.click('#refresh');
    await count('—');
    await page.click('#openConflicts');
    assert.match(await page.locator('#conflictStatus').innerText(), /последната/);
    assert.equal(await page.locator('.conflict-group').count(), 1);
    await page.keyboard.press('Escape');
    failRead = false;
    await page.selectOption('#year', '2025/2026');
    await count(0);
    await page.click('#openConflicts');
    assert.match(await page.locator('#conflictScope').innerText(), /2025\/2026/);
    assert.equal(await page.locator('.conflict-group').count(), 0);
    await page.keyboard.press('Escape');
    restricted = true;
    await page.evaluate(() => localStorage.setItem('evidence_token_v1', 'invented-token'));
    await page.goto(origin + '/RasporediFusion.html');
    await page.locator('.schedule-grid').waitFor();
    await count(1);
    await page.click('#openConflicts');
    assert.equal(await page.locator('[data-open-conflict]:disabled').count(), 2, 'other cabinets visible in details but cannot bypass own-week restriction');
    assert.equal(await page.locator('#focus').inputValue(), '1');
    assert.deepEqual(errors, []);
    console.log('PASS: scoped groups, exact halves, adjacent times, identities, legacy overlap, navigation, both refusals, stale write, correction, failed read, history, mobile and themes');
} finally { await browser.close(); }
