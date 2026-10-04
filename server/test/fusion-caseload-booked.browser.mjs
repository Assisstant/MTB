/**
 * Кабинети → „Ученици по терапевт": a child who still has a term with the
 * therapist cannot be taken off the list (4 Oct 2026, lib/caseload.ts — the
 * same answer as the pupil form, Администрација and Колега). The page says so
 * BEFORE writing anything, so the list is never half-saved; a child with no
 * term leaves the list as before. Every API call is invented.
 *
 *     npm run start
 *     npm run test:fusion-caseload-booked
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
const students = [
    { public_id: 'bk-a', name: 'Ана Пробна', grade: 'II-а', active: true },
    { public_id: 'bk-b', name: 'Бојан Пробен', grade: 'III-а', active: true }
];
const therapist = { id: 7, name: 'Терапевт Листа', students: ['bk-a', 'bk-b'] };
const sessions = [{ day: 'среда', time: '08:00-08:40', therapist_id: 7, student_public_id: 'bk-a' }];
const writes = [];

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = [];
    await context.route('**/api/**', async (route) => {
        const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname);
        if (req.method() !== 'GET') {
            writes.push(req.method() + ' ' + path);
            if (req.method() === 'DELETE') therapist.students = therapist.students.filter((id) => !path.endsWith('/' + id));
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists: [JSON.parse(JSON.stringify(therapist))], teachers: [], caseloadOrder: true },
            '/api/schedule/sessions': { sessions },
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

    const untickAndSave = async (id) => {
        await page.click('#openCaseloadBtn');
        await page.locator(`#caseloadGrid input[value="${id}"]`).uncheck();
        await page.click('#saveCaseloadBtn');
        await page.waitForTimeout(500);
    };

    await untickAndSave('bk-a');
    const notice = await page.textContent('#notice');
    assert.deepEqual(writes, [], 'nothing was written for a child who still has a term');
    assert.match(notice, /Ана Пробна има термин \(среда 08:00\)/, notice);
    assert.match(notice, /прво испразнете го терминот во „Термини“/, notice);
    assert.equal(await page.isVisible('#caseloadModal'), true, 'the list stays open to be corrected');

    await page.locator('#caseloadGrid input[value="bk-a"]').check();
    await page.locator('#caseloadGrid input[value="bk-b"]').uncheck();
    await page.click('#saveCaseloadBtn');
    await page.waitForTimeout(500);
    assert.deepEqual(writes, [`DELETE /api/therapists/${therapist.name}/students/bk-b`], 'a child with no term leaves the list as before');
    assert.deepEqual(errors, []);
    console.log('Fusion caseload: a booked child stays on the list and the page says which term; an unbooked one leaves — passed.');
} finally { await browser.close(); }
