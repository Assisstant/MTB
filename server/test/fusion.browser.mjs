/**
 * RasporediFusion.html in a browser against an isolated historical year.
 * All names are invented and every write is checked in PostgreSQL.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import 'dotenv/config';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const TAG = 'fusion-browser-test';
const YEAR = '1912/1913-fusion-ui';
const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (label, condition, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else {
        fails++;
        console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
    }
};
const checkEq = (label, actual, expected) => {
    const equal = JSON.stringify(actual) === JSON.stringify(expected);
    check(label, equal, equal ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1912-09-01', '1913-08-31', false) RETURNING id`, [YEAR]);
    const therapists = [];
    for (const suffix of ['A', 'B']) {
        const [therapist] = await q(
            'INSERT INTO therapists (name) VALUES ($1) RETURNING id, name',
            [`${TAG} Терапевт ${suffix}`]
        );
        therapists.push(therapist);
        await q(
            `INSERT INTO therapist_years (school_year_id, therapist_id, active)
             VALUES ($1, $2, true)`, [year.id, therapist.id]);
    }

    const students = [];
    for (const [suffix, grade, kind, name] of [
        ['a', 'IV-а', 'internal', `${TAG} Исто Име`],
        ['b', 'V-б', 'boarding', `${TAG} Исто Име`],
        ['c', null, 'external', `${TAG} Надворешен Ученик`]
    ]) {
        const [student] = await q(
            `INSERT INTO students (public_id, name, grade)
             VALUES ($1, $2, $3) RETURNING id, public_id`,
            [`${TAG}-${suffix}`, name, grade]
        );
        students.push(student);
        await q(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, $3, $4, true)`, [student.id, year.id, grade, kind]);
    }

    for (const therapist of therapists) {
        for (const student of students) {
            await q(
                `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
                 VALUES ($1, $2, $3)`, [year.id, therapist.id, student.id]);
        }
    }
    return { therapists, students };
}

async function storedSessions() {
    return q(
        `SELECT ss.time_slot, t.name AS therapist, s.public_id AS student
           FROM schedule_slots ss
           JOIN school_years sy ON sy.id = ss.school_year_id
           JOIN therapists t ON t.id = ss.therapist_id
           JOIN students s ON s.id = ss.student_id
          WHERE sy.label = $1 ORDER BY t.name, s.public_id`, [YEAR]);
}

async function run() {
    const fixture = await seed();
    console.log('RasporediFusion in a real browser\n');
    const browser = await chromium.launch({
        ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(() => localStorage.setItem('theme', 'dark-mode'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(`${BASE}/RasporediFusion.html?year=${encodeURIComponent(YEAR)}`);
    await page.waitForSelector('select[data-session-time="08:00-08:40"]', { timeout: 8000 });
    checkEq('the requested isolated year is selected', await page.inputValue('#year'), YEAR);
    checkEq('the grid has one column per active therapist',
        await page.locator('.schedule-grid > .schedule-header .schedule-header-name').count(), 2);
    checkEq('a cabinet dropdown contains each pupil once plus the empty choice',
        await page.locator('select[data-session-time="08:00-08:40"]').first().locator('option').count(), 4);

    const testedDay = await page.locator('select[data-session-time="08:00-08:40"]').first().getAttribute('data-session-day');
    const firstCell = `select[data-session-day="${testedDay}"][data-session-time="08:00-08:40"][data-therapist-id="${fixture.therapists[0].id}"]`;
    const secondCell = `select[data-session-day="${testedDay}"][data-session-time="08:00-08:40"][data-therapist-id="${fixture.therapists[1].id}"]`;
    const firstWrite = page.waitForResponse((response) =>
        response.url().endsWith('/api/schedule/block') && response.request().method() === 'PUT');
    await page.selectOption(firstCell, fixture.students[0].public_id);
    check('a cell write succeeds', (await firstWrite).status() === 200);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.disabled, firstCell);
    checkEq('the write is immediately in PostgreSQL',
        (await storedSessions()).map((row) => [row.therapist, row.student, row.time_slot]),
        [[fixture.therapists[0].name, fixture.students[0].public_id, '08:00-08:40']]);
    const fullWidth = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace').getBoundingClientRect();
        const schedule = document.querySelector('#schedulePanel').getBoundingClientRect();
        return {
            workspaceWidth: Math.round(workspace.width),
            scheduleWidth: Math.round(schedule.width),
            legacySidebar: document.querySelectorAll('.waiting-tool').length
        };
    });
    check('the schedule uses the complete workspace width',
        Math.abs(fullWidth.workspaceWidth - fullWidth.scheduleWidth) <= 1, JSON.stringify(fullWidth));
    checkEq('the old fixed waiting sidebar is gone', fullWidth.legacySidebar, 0);
    const firstSlot = page.locator(firstCell)
        .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " student-slot ")]');
    checkEq('the selected pupil is printed in full inside the slot',
        await firstSlot.locator('.slot-name').textContent(), `IV-а - ${TAG} Исто Име`);
    const pupilNameFit = await firstSlot.locator('.slot-name').evaluate((name) => ({
        whiteSpace: getComputedStyle(name).whiteSpace,
        clientHeight: name.clientHeight,
        scrollHeight: name.scrollHeight
    }));
    check('the visible pupil name wraps and is not vertically clipped',
        pupilNameFit.whiteSpace === 'normal' && pupilNameFit.scrollHeight <= pupilNameFit.clientHeight + 1,
        JSON.stringify(pupilNameFit));
    await firstSlot.click();
    check('clicking the visible slot focuses its native dropdown', await page.evaluate((selector) =>
        document.activeElement === document.querySelector(selector), firstCell));
    const firstBlock = `.schedule-cell:has(${firstCell})`;
    checkEq('one pupil is shown in exactly one field',
        await page.locator(firstBlock).locator('select[data-block-part]').count(), 1);
    checkEq('one pupil offers a compact add-second button',
        await page.locator(firstBlock).locator('button[data-add-second]').count(), 1);
    const theme = await page.evaluate(() => ({
        dark: document.body.classList.contains('dark-mode'),
        canvas: getComputedStyle(document.querySelector('.content')).backgroundColor,
        header: getComputedStyle(document.querySelector('.schedule-header')).backgroundColor,
        pupil: getComputedStyle(document.querySelector('.student-slot:not(.empty)')).backgroundColor
    }));
    check('the saved S-Dnevnik dark theme is active', theme.dark, JSON.stringify(theme));
    checkEq('the schedule uses the S-Dnevnik dark canvas', theme.canvas, 'rgb(26, 32, 44)');
    checkEq('the schedule uses the S-Dnevnik purple headers', theme.header, 'rgb(76, 81, 191)');
    checkEq('a pupil uses the S-Dnevnik blue card colour', theme.pupil, 'rgb(44, 82, 130)');

    await page.locator('#rosterTab').click();
    check('the students-by-therapist tab replaces the grid',
        await page.locator('#rosterPanel').isVisible() && !(await page.locator('#schedulePanel').isVisible()));
    checkEq('the selected therapist roster lists every assigned pupil once',
        await page.locator('#therapistRosterRows tr[data-student-id]').count(), 3);
    checkEq('the roster has visible sequential row numbers',
        await page.locator('#therapistRosterRows .roster-number').allTextContents(), ['1.', '2.', '3.']);
    await page.selectOption('#rosterKind', 'external');
    checkEq('the category filter isolates external pupils',
        await page.locator('#therapistRosterRows tr[data-kind="external"]').count(), 1);
    await page.selectOption('#rosterKind', 'boarding');
    checkEq('the category filter preserves boarding as its own category',
        await page.locator('#therapistRosterRows tr[data-kind="boarding"]').count(), 1);
    await page.selectOption('#rosterKind', 'all');
    await page.selectOption('#rosterSession', 'scheduled');
    checkEq('the schedule filter shows the one pupil who has a session',
        await page.locator('#therapistRosterRows tr[data-student-id]').count(), 1);
    checkEq('the roster counts one 40-minute weekly term',
        await page.locator('#therapistRosterRows .roster-sessions').textContent(), '1');
    await page.selectOption('#rosterSession', 'waiting');
    checkEq('the schedule filter shows the remaining pupils without a session',
        await page.locator('#therapistRosterRows tr[data-student-id]').count(), 2);
    await page.locator('#scheduleTab').click();
    check('returning to the schedule restores its controls and grid',
        await page.locator('#schedulePanel').isVisible() && await page.locator('#viewMode').isVisible());

    const refused = page.waitForResponse((response) =>
        response.url().endsWith('/api/schedule/block') && response.request().method() === 'PUT');
    await page.selectOption(secondCell, fixture.students[0].public_id);
    check('double booking is refused', (await refused).status() === 409);
    await page.waitForSelector('#notice.on.error');
    check('the refusal is explained on screen',
        /веќе е закажан/.test(await page.textContent('#notice')));
    checkEq('the refused cell returns to empty', await page.inputValue(secondCell), '');
    checkEq('the refused write did not create a second row', (await storedSessions()).length, 1);

    await page.selectOption('#viewMode', 'week');
    await page.waitForFunction(() => document.querySelector('#scheduleTitle')?.textContent.includes('Неделен распоред'));
    checkEq('weekly mode automatically chooses one cabinet',
        await page.inputValue('#focus'), String(fixture.therapists[0].id));
    check('weekly mode hides the single-day tabs', !(await page.locator('#dayTabsBand').isVisible()));
    checkEq('weekly mode has time plus five weekday columns',
        await page.locator('.schedule-grid > .schedule-header').count(), 6);
    checkEq('each empty weekly block starts with one pupil field',
        await page.locator('.schedule-grid select[data-block-time="08:00-08:40"]').count(), 5);
    checkEq('the single pupil fields cover all five days',
        await page.locator('.schedule-grid select[data-block-time="08:00-08:40"]').evaluateAll((nodes) =>
            nodes.map((node) => node.dataset.sessionDay)),
        ['понеделник', 'вторник', 'среда', 'четврток', 'петок']);
    check('the selected cabinet is named in the weekly heading',
        (await page.textContent('#scheduleTitle')).includes(fixture.therapists[0].name));

    const secondPupil = `select[data-session-day="${testedDay}"][data-block-time="08:00-08:40"][data-block-part="1"][data-therapist-id="${fixture.therapists[0].id}"]`;
    const addSecond = `button[data-add-second][data-session-day="${testedDay}"][data-block-time="08:00-08:40"][data-therapist-id="${fixture.therapists[0].id}"]`;
    await page.locator(addSecond).click();
    await page.waitForSelector(secondPupil);
    checkEq('the second field appears only after pressing plus', await page.locator(secondPupil).count(), 1);
    const weeklyWrite = page.waitForResponse((response) =>
        response.url().endsWith('/api/schedule/block') && response.request().method() === 'PUT');
    await page.selectOption(secondPupil, fixture.students[1].public_id);
    check('adding a second pupil atomically splits the weekly block', (await weeklyWrite).status() === 200);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.disabled, secondPupil);
    checkEq('two pupils are stored as ordered 20-minute halves',
        (await storedSessions()).map((row) => [row.therapist, row.student, row.time_slot]),
        [
            [fixture.therapists[0].name, fixture.students[0].public_id, '08:00-08:20'],
            [fixture.therapists[0].name, fixture.students[1].public_id, '08:20-08:40']
        ]);

    const mergeWrite = page.waitForResponse((response) =>
        response.url().endsWith('/api/schedule/block') && response.request().method() === 'PUT');
    await page.selectOption(secondPupil, '');
    check('removing the second pupil atomically merges the first back to 40 minutes', (await mergeWrite).status() === 200);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.disabled, firstCell);
    checkEq('one pupil is stored as one full 40-minute session',
        (await storedSessions()).map((row) => [row.therapist, row.student, row.time_slot]),
        [[fixture.therapists[0].name, fixture.students[0].public_id, '08:00-08:40']]);
    checkEq('removing pupil two hides its field again', await page.locator(secondPupil).count(), 0);
    checkEq('the compact add-second button returns', await page.locator(addSecond).count(), 1);

    const fullTime = '08:45-09:25';
    const compatibilityWrite = await page.evaluate(async (body) => {
        const response = await fetch('/api/schedule/session', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return response.status;
    }, {
        year: YEAR, day: 'понеделник', time: fullTime,
        therapistId: fixture.therapists[0].id,
        studentPublicId: fixture.students[0].public_id,
        expectedStudentPublicId: null
    });
    check('an existing 40-minute compatibility row can still be created', compatibilityWrite === 200);
    check('the compatibility row is in PostgreSQL before the UI reload',
        (await storedSessions()).some((row) =>
            row.student === fixture.students[0].public_id && row.time_slot === fullTime));
    const fullSelector = `select[data-session-day="понеделник"][data-session-time="${fullTime}"][data-therapist-id="${fixture.therapists[0].id}"]`;
    const compatibilityReload = Promise.all([
        page.waitForResponse((response) => response.url().includes('/api/roster?year=')),
        page.waitForResponse((response) => response.url().includes('/api/schedule/sessions?year='))
    ]);
    await page.locator('#refresh').click();
    await compatibilityReload;
    await page.waitForFunction(({ selector, value }) =>
        document.querySelector(selector)?.value === value,
    { selector: fullSelector, value: fixture.students[0].public_id });
    checkEq('an existing 40-minute row is shown once instead of being hidden',
        await page.locator(fullSelector).count(), 1);
    checkEq('the compatibility row is visibly labelled as 40 minutes',
        await page.locator(fullSelector)
            .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " student-slot ")]')
            .locator('.slot-badge').textContent(), '40′');
    checkEq('a full row keeps only one pupil field',
        await page.locator(`select[data-session-day="понеделник"][data-block-time="${fullTime}"][data-therapist-id="${fixture.therapists[0].id}"]`).count(), 1);
    const compatibilityCell = page.locator(fullSelector)
        .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " schedule-cell ")]');
    const compatibilityAddCount = await compatibilityCell.locator('button[data-add-second]').count();
    check('a full row offers the compact add-second button', compatibilityAddCount === 1,
        await compatibilityCell.evaluate((cell) => cell.outerHTML));

    const compatibilityClear = page.waitForResponse((response) =>
        response.url().endsWith('/api/schedule/block') && response.request().method() === 'PUT');
    await page.selectOption(fullSelector, '');
    check('the old full row can be cleared from the weekly UI', (await compatibilityClear).status() === 200);
    await page.waitForSelector(fullSelector);
    checkEq('clearing the old row leaves one empty pupil field ready',
        await page.locator(`select[data-session-day="понеделник"][data-block-time="${fullTime}"][data-therapist-id="${fixture.therapists[0].id}"]`).count(), 1);

    await q('UPDATE students SET active = false WHERE id = $1', [fixture.students[0].id]);
    const historicalReload = Promise.all([
        page.waitForResponse((response) => response.url().includes('/api/roster?year=')),
        page.waitForResponse((response) => response.url().includes('/api/schedule/sessions?year='))
    ]);
    await page.locator('#refresh').click();
    await historicalReload;
    await page.waitForSelector(firstCell);
    checkEq('a pupil archived later remains selected in the historical grid',
        await page.inputValue(firstCell), fixture.students[0].public_id);
    check('the historical grid keeps the real roster label instead of showing unknown',
        !/Непознат/.test(await page.locator(firstCell).locator('option:checked').textContent()));
    await q('UPDATE students SET active = true WHERE id = $1', [fixture.students[0].id]);

    await page.emulateMedia({ media: 'print' });
    check('printing keeps the weekly grid and hides navigation controls',
        await page.locator('.schedule-grid').isVisible() && !(await page.locator('.toolbar-band').isVisible()));
    await page.emulateMedia({ media: 'screen' });
    check('there are no JavaScript errors', errors.length === 0, errors.join(' | '));

    await context.close();

    const restricted = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await restricted.addInitScript(() => localStorage.setItem('evidence_token_v1', 'invented-fusion-token'));
    const ownPage = await restricted.newPage();
    await ownPage.route('**/api/evidence/me', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            person: { kind: 'therapist', id: fixture.therapists[0].id, name: fixture.therapists[0].name },
            permissions: { enforced: true, admin: false }
        })
    }));
    await ownPage.goto(`${BASE}/RasporediFusion.html?year=${encodeURIComponent(YEAR)}`);
    await ownPage.waitForFunction((id) =>
        document.querySelector('#focus')?.disabled && document.querySelector('#focus')?.value === String(id),
        fixture.therapists[0].id);
    check('a signed-in therapist is locked to their own weekly schedule',
        await ownPage.inputValue('#viewMode') === 'week' && await ownPage.locator('#viewMode').isDisabled() &&
        await ownPage.locator('#focus').isDisabled());
    checkEq('the therapist focus cannot target a same-name or different cabinet',
        await ownPage.locator('#focus option').count(), 1);
    checkEq('their weekly grid contains exactly five editable day cells',
        await ownPage.locator('.schedule-grid select[data-block-time="08:00-08:40"]:not([disabled])').count(), 5);
    await ownPage.click('#rosterTab');
    check('the caseload picker is also locked to the signed-in therapist',
        await ownPage.locator('#rosterTherapist').isDisabled() &&
        await ownPage.locator('#rosterTherapist option').count() === 1 &&
        await ownPage.locator('#openCaseloadBtn').isEnabled());
    await restricted.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await mobile.newPage();
    await phone.goto(`${BASE}/RasporediFusion.html?year=${encodeURIComponent(YEAR)}`);
    await phone.waitForSelector('select[data-session-time="08:00-08:40"]', { timeout: 8000 });
    await phone.selectOption('#focus', String(fixture.therapists[0].id));
    const fit = await phone.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        workspaceColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
        therapistColumns: document.querySelectorAll('.schedule-grid > .schedule-header .schedule-header-name').length
    }));
    check('the page itself does not overflow at phone width',
        fit.documentWidth <= fit.viewportWidth + 1, JSON.stringify(fit));
    checkEq('focused phone view shows one therapist column', fit.therapistColumns, 1);
    await mobile.close();
    await browser.close();
}

try {
    await run();
} catch (error) {
    fails++;
    console.error(error);
} finally {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
}

console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
