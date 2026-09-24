/** Read-only browser regression: every API call is intercepted with invented data. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const BASE = process.env.API || 'http://127.0.0.1:3000';
const year = '2026/2027';
const students = [
    { public_id: 'report-a', name: 'Пробно Име', grade: 'III', active: true },
    { public_id: 'report-b', name: 'Пробно Име', grade: 'IV', active: true },
    { public_id: 'report-c', name: 'Ученик Без Термин', grade: 'V', active: true }
];
const therapists = [
    { id: 1, name: 'Терапевт Пример А', students: students.map(s => s.public_id) },
    { id: 2, name: 'Терапевт Пример Б', students: ['report-a'] },
    { id: 3, name: 'Терапевт Без Посети', students: [] }
];
const session = (day, time, therapist_id, student_public_id) => ({ day, time, therapist_id, student_public_id });
const sessions = [session('понеделник', '08:00-08:20', 1, 'report-a'), session('понеделник', '08:20-08:40', 1, 'report-a'),
    session('вторник', '08:00-08:40', 1, 'report-a'), session('среда', '08:00-08:40', 2, 'report-a'),
    session('четврток', '08:00-08:20', 1, 'report-b')];
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = [], writes = [];
    await context.addInitScript(() => { window.print = () => {}; });
    await context.route('**/api/**', route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 405 }); }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists, teachers: [] },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: [{ label: 'I', startsAt: '08:00', minutes: 40 }] } },
            '/api/teaching/crossing': { cells: [] }
        }[path];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#listsTab');
    assert.equal(await page.locator('.report-section').count(), 3);
    assert.equal(await page.locator('[data-report-therapist="1"] tbody tr').count(), 3);
    const zero = page.locator('[data-report-therapist="1"] tbody tr').filter({ hasText: 'Ученик Без Термин' });
    assert.equal(await zero.locator('td').last().textContent(), '0');
    const popupPromise = context.waitForEvent('page');
    await page.locator('[data-print-therapist="1"]').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(await popup.locator('.report-section').count(), 1);
    assert.equal(await popup.locator('tbody tr').count(), 3);
    assert.equal(await popup.locator('button:visible').count(), 0);
    await popup.close();
    await page.selectOption('#reportTherapist', '1');
    assert.equal(await page.locator('.report-section').count(), 1);
    assert.match(await page.locator('[data-report-therapist="1"] .report-note').textContent(), /Вкупно посети неделно: 3/);
    await page.click('#visitsTab');
    assert.equal(await page.locator('#reportTherapist').inputValue(), '', 'aggregate has its own therapist filter');
    const rows = await page.locator('#reportContent tbody tr').evaluateAll(rs => rs.map(r => [...r.cells].map(c => c.textContent)));
    assert.deepEqual(rows.map(r => r.slice(1, 5)), [['Пробно Име', 'III', '2', '3'], ['Пробно Име', 'IV', '1', '1']]);
    assert.equal(await page.locator('.report-totals').textContent(), 'Кабинети со посети: 2 · Вкупно посети неделно: 4');
    await page.selectOption('#reportTherapist', '2');
    assert.equal(await page.locator('#reportContent tbody tr').count(), 1);
    assert.equal(await page.locator('#reportContent tbody tr td').nth(4).textContent(), '1');
    assert.equal(await page.locator('.report-totals').textContent(), 'Кабинети со посети: 1 · Вкупно посети неделно: 1');
    const filteredPrint = context.waitForEvent('page');
    await page.click('#printReport');
    const filteredSheet = await filteredPrint; await filteredSheet.waitForLoadState();
    assert.equal(await filteredSheet.locator('.report-scope').textContent(), 'Приказ: Терапевт Пример Б');
    assert.equal(await filteredSheet.locator('tbody tr').count(), 1);
    assert.equal(await filteredSheet.locator('.report-totals').textContent(), 'Кабинети со посети: 1 · Вкупно посети неделно: 1');
    await filteredSheet.close();
    await page.click('#listsTab');
    assert.equal(await page.locator('#reportTherapist').inputValue(), '1');
    await page.click('#visitsTab');
    assert.equal(await page.locator('#reportTherapist').inputValue(), '2');
    await page.selectOption('#reportTherapist', '3');
    assert.equal(await page.locator('.report-totals').textContent(), 'Кабинети со посети: 0 · Вкупно посети неделно: 0');
    assert.equal(await page.locator('#reportContent tbody').textContent(), 'Нема ученици.');
    await page.click('#reportAllTherapists');
    assert.equal(await page.locator('#reportTherapist').inputValue(), '');
    assert.equal(await page.locator('#reportContent tbody tr').count(), 2);
    await mkdir('../backups/fusion-reports-qa', { recursive: true });
    await page.screenshot({ path: '../backups/fusion-reports-qa/visits.png', fullPage: true });
    await page.click('#allDaysTab');
    assert.equal(await page.locator('#scheduleGrid .day-section').count(), 5);
    assert.deepEqual(await page.locator('#scheduleGrid .day-section > h3').allTextContents(), ['Понеделник', 'Вторник', 'Среда', 'Четврток', 'Петок']);
    assert.equal(await page.locator('#dayTabsBand').isVisible(), false);
    assert.ok(await page.locator('select[data-session-day="петок"]').count() > 0);
    const allPrint = context.waitForEvent('page');
    await page.click('#printSheet');
    const sheet = await allPrint; await sheet.waitForLoadState();
    assert.equal(await sheet.locator('.day-section').count(), 5);
    await sheet.close();
    await page.screenshot({ path: '../backups/fusion-reports-qa/days.png', fullPage: true });
    await page.click('label[for="checkbox"]');
    await page.click('#listsTab');
    await page.screenshot({ path: '../backups/fusion-reports-qa/lists-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#visitsTab');
    assert.ok(await page.locator('#reportContent').isVisible());
    await page.screenshot({ path: '../backups/fusion-reports-qa/mobile.png', fullPage: true });
    // A pupil taken off a list keeps the slot already booked. The list is who
    // is ON it; the slot left behind is named apart, with where it is, and
    // the printed list leaves it out (owner, 24 Sep 2026: it printed anyway).
    therapists[1].students = [];
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    await page.click('#listsTab');
    await page.selectOption('#reportTherapist', '2');
    const listB = page.locator('[data-report-therapist="2"]');
    assert.match(await listB.locator('.report-note').first().textContent(), / 0 ученици · Вкупно посети неделно: 0$/);
    assert.equal(await listB.locator('table.report-table').first().locator('tbody').textContent(), 'Нема ученици.');
    assert.match(await listB.locator('.report-stray h4').textContent(), /Закажани, а не се на списокот \(1\)/);
    assert.deepEqual(await listB.locator('.report-stray tbody td').allTextContents(), ['Пробно Име', 'III', 'среда 08:00']);
    const strayPrint = context.waitForEvent('page');
    await listB.locator('[data-print-therapist="2"]').click();
    const straySheet = await strayPrint; await straySheet.waitForLoadState();
    assert.equal(await straySheet.locator('.report-stray').isVisible(), false, 'the slot left behind is not printed as part of the list');
    assert.equal(await straySheet.locator('table.report-table').first().locator('tbody').textContent(), 'Нема ученици.');
    await straySheet.close();
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log('Fusion reports: independent therapist filters, scoped totals and printing, zero visits, stable identities, merged halves, all days, mobile and dark theme passed; no API writes.');
} finally { await browser.close(); }
