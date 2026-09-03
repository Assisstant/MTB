/**
 * The database layers are additive: a JSON produced by the legacy diary must
 * still load, and its five stored periods must keep their two half-slot fields
 * even though the current UI presents each period as one 40-minute class.
 */
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const LEGACY_KEYS = [
    'students', 'schedule', 'scheduleHistory', 'attendance', 'plans', 'links',
    'studentProgress', 'trijazenTestovi', 'student_records', 'audiograms',
    'assessments', 'scaleTemplates'
];

const emptyWeek = () => ({
    monday: [[], [], [], [], []],
    tuesday: [[], [], [], [], []],
    wednesday: [[], [], [], [], []],
    thursday: [[], [], [], [], []],
    friday: [[], [], [], [], []]
});

const legacyPayload = {
    students: [{ id: 990001, name: 'Compat Student', grade: 'V', kind: 'internal', rasporediStudentId: 'compat-active', disabilityType: '', planId: 990101 }],
    formerCaseloadStudents: [{ id: 990002, name: 'Former Compat', grade: 'VI', kind: 'internal', rasporediStudentId: 'compat-former', disabilityType: '', planId: 990101 }],
    schedule: emptyWeek(),
    scheduleHistory: {},
    attendance: {
        '2026-09-07': {
            990001: { 'monday-0': { status: 'present', time: '08:00-08:40' } }
        }
    },
    plans: [{ id: 990101, name: 'Compat Plan', activities: ['Activity'] }],
    links: [],
    studentProgress: { 990001: { 990101: [0] } },
    trijazenTestovi: [],
    student_records: [],
    audiograms: [],
    assessments: [],
    scaleTemplates: []
};
legacyPayload.schedule.monday[0] = [990001];

let fails = 0;
const check = (label, condition, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else {
        fails++;
        console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`);
    }
};

const run = async () => {
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('dialog', (dialog) => dialog.accept());
    await page.addInitScript(() => localStorage.setItem('sdn_local_server_autosync_v1', '0'));
    await page.route('**/api/roster*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            year: '2026/2027',
            students: [
                { public_id: 'compat-active', sdnevnik_id: '990001', name: 'Compat Student', grade: 'V', kind: 'internal' },
                { public_id: 'compat-external', sdnevnik_id: '990003', name: 'External Compat', grade: null, kind: 'external' },
                { public_id: 'compat-former', sdnevnik_id: '990002', name: 'Former Compat', grade: 'VI', kind: 'internal' },
                { public_id: 'compat-extra', sdnevnik_id: '990004', name: 'Extra Compat', grade: null, kind: 'external' },
                { public_id: 'compat-boarding', sdnevnik_id: '990005', name: 'Boarding Compat', grade: 'VII', kind: 'boarding' }
            ]
        })
    }));

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForFunction(() => window.SdnV3 && window.SdnYear && window.SDiary);

    const result = await page.evaluate((payload) => {
        localStorage.removeItem('sdnevnik_row_writes_v1');
        window.SdnV3.applyPayload(payload);
        window.schoolCalendar = window.calendarFromStored({
            label: '2025/2026',
            yearStart: '2025-09-01',
            firstHalfEnd: '2026-01-31',
            yearEnd: '2026-06-10',
            holidays: []
        });

        const here = window.mondayOf(new Date());
        const target = window.mondayOf(new Date(2027, 4, 31, 12));
        window.currentWeek = Math.round((target - here) / (7 * 24 * 60 * 60 * 1000));
        window.updateWeekDisplay();
        window.renderSchedule();
        window.SdnYear.render();

        const exported = window.SdnV3.currentPayload('compatibility_test');
        return {
            exported,
            rowWrites: window.SDiary.enabled(),
            mismatch: document.getElementById('weekDisplay').dataset.calendarMismatch,
            configuredYear: document.getElementById('weekDisplay').dataset.configuredYear,
            viewedYear: document.getElementById('weekDisplay').dataset.viewedYear,
            statusText: document.getElementById('weekDisplay').textContent,
            periods: Array.from(document.querySelectorAll('.schedule-time')).map((cell) => ({
                label: cell.firstElementChild?.textContent,
                range: cell.querySelector('.schedule-time-range')?.textContent,
                text: cell.textContent
            })),
            slotShape: window.timeSlots.map((slot) => ({
                time: slot.time,
                half1: slot.half1,
                half2: slot.half2
            })),
            leaverCount: document.querySelectorAll('.syLeaver').length,
            suggestion: Array.from(document.querySelectorAll('#sdnYearPanel button'))
                .map((button) => button.textContent)
                .find((text) => text.includes('Предложи')) || ''
        };
    }, legacyPayload);

    console.log('\nlegacy JSON contract');
    check('all legacy fields are still exported', LEGACY_KEYS.every((key) => Object.hasOwn(result.exported, key)));
    check('the legacy student loads unchanged', result.exported.students.some((student) => student.id === 990001 && student.name === 'Compat Student'));
    check('the legacy schedule slot remains assigned', result.exported.schedule.monday[0][0] === 990001);
    check('the legacy attendance mark remains present', result.exported.attendance['2026-09-07']['990001']['monday-0'].status === 'present');
    check('the additive former-caseload collection survives export', result.exported.formerCaseloadStudents?.[0]?.id === 990002);
    check('the school-year panel refreshes with the active list', result.leaverCount === 1, String(result.leaverCount));
    check('database row writes remain opt-in', result.rowWrites === false);

    console.log('\nannual roster picker');
    await page.evaluate(() => {
        window.switchTab('students');
        window.showAddStudentModal();
    });
    await page.waitForFunction(() => window.annualRosterState?.rows?.length === 5);
    const picker = await page.evaluate(() => ({
        summary: document.getElementById('annualRosterSummary')?.textContent || '',
        rows: Array.from(document.querySelectorAll('#annualRosterList .annual-roster-row')).map((row) => row.textContent),
        activeHeader: document.querySelector('.student-list-toolbar h3')?.textContent || '',
        activeFilters: Array.from(document.querySelectorAll('#studentListSimple .student-filter-btn')).map((button) => button.textContent)
    }));
    check('the picker reports all three student categories', picker.summary.includes('5 ученици (2 интерни, 1 интернатски, 2 екстерни)'), picker.summary);
    check('every annual-roster row has a stable serial number', picker.rows.every((row, index) => row.trim().startsWith(`${index + 1}.`)), JSON.stringify(picker.rows));
    check('the active list reports only its own student', picker.activeHeader.includes('(1)'), picker.activeHeader);
    check('the active filters show all three category counts', picker.activeFilters.includes('Интерни 1') && picker.activeFilters.includes('Интернатски 0') && picker.activeFilters.includes('Екстерни 0'), JSON.stringify(picker.activeFilters));

    await page.locator('#annualRosterFilters').getByRole('button', { name: 'Интернатски 1' }).click();
    const boardingRows = await page.locator('#annualRosterList .annual-roster-row').allTextContents();
    check('the boarding filter keeps its stable source number', boardingRows.length === 1 && boardingRows[0].trim().startsWith('5.') && boardingRows[0].includes('Интернатски'), JSON.stringify(boardingRows));

    await page.locator('#annualRosterFilters').getByRole('button', { name: 'Екстерни 2' }).click();
    const externalRows = await page.locator('#annualRosterList .annual-roster-row').allTextContents();
    check('the external filter keeps original serial numbers', externalRows.length === 2 && externalRows[0].trim().startsWith('2.') && externalRows[1].trim().startsWith('4.'), JSON.stringify(externalRows));

    await page.evaluate(() => window.setAnnualRosterFilter('internal'));
    const formerButton = page.locator('#annualRosterList .annual-roster-row').filter({ hasText: 'Former Compat' }).getByRole('button');
    check('a former caseload student is offered as a restore', (await formerButton.textContent())?.trim() === 'Врати');
    await formerButton.click();
    const restored = await page.evaluate(() => ({
        active: window.students.length,
        former: window.formerCaseloadStudents.length,
        exportedFormer: window.SdnV3.currentPayload('former_restore_test').formerCaseloadStudents.length
    }));
    check('restoring reuses the former record instead of creating a duplicate', restored.active === 2 && restored.former === 0 && restored.exportedFormer === 0, JSON.stringify(restored));

    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePicker = await page.evaluate(() => {
        const list = document.getElementById('annualRosterList');
        const actions = Array.from(document.querySelectorAll('#annualRosterList .annual-roster-action'));
        const badges = Array.from(document.querySelectorAll('#annualRosterList .student-kind-badge'));
        return {
            pageFits: document.documentElement.scrollWidth <= window.innerWidth + 1,
            listFits: list.scrollWidth <= list.clientWidth + 1,
            actionsFit: actions.every((button) => button.scrollWidth <= button.clientWidth + 1),
            badgesFit: badges.every((badge) => badge.scrollWidth <= badge.clientWidth + 1)
        };
    });
    check('the annual-roster picker fits a mobile viewport', mobilePicker.pageFits && mobilePicker.listFits && mobilePicker.actionsFit && mobilePicker.badgesFit, JSON.stringify(mobilePicker));
    const rosterMobileShot = join(tmpdir(), 'mtb-sdnevnik-roster-mobile.png');
    await page.screenshot({ path: rosterMobileShot });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
        window.closeModal('addStudentModal');
        window.switchTab('schedule');
        window.updateWeekDisplay();
        window.renderSchedule();
    });

    console.log('\ncalendar diagnosis');
    check('the mismatch is detected', result.mismatch === 'true');
    check('the saved calendar year is named', result.configuredYear === '2025/2026', result.statusText);
    check('the viewed week year is named', result.viewedYear === '2026/2027', result.statusText);
    check('the calendar suggestion follows the viewed week', result.suggestion.includes('2026/2027'), result.suggestion);

    const openingWeeks = await page.evaluate(() => {
        const previous = window.calendarToStored(window.schoolCalendar);
        const previousWeek = window.currentWeek;
        window.schoolCalendar = window.calendarFromStored({
            label: '2026/2027',
            yearStart: '2026-09-01',
            firstHalfEnd: '2027-01-31',
            yearEnd: '2027-06-10',
            holidays: []
        });
        const first = window.getSchoolWeekInfo(new Date(2026, 8, 1, 12));
        const second = window.getSchoolWeekInfo(new Date(2026, 8, 7, 12));
        const august31 = window.nonWorkingEntry(new Date(2026, 7, 31, 12));
        const september1 = window.nonWorkingEntry(new Date(2026, 8, 1, 12));
        const here = window.mondayOf(new Date());
        const opening = window.mondayOf(new Date(2026, 7, 31, 12));
        window.currentWeek = Math.round((opening - here) / (7 * 24 * 60 * 60 * 1000));
        window.updateWeekDisplay();
        window.renderSchedule();
        const mondayHeader = document.querySelectorAll('.schedule-header')[1]?.textContent || '';
        window.schoolCalendar = window.calendarFromStored(previous);
        window.currentWeek = previousWeek;
        window.updateWeekDisplay();
        window.renderSchedule();
        return { first, second, august31, september1, mondayHeader };
    });
    check('the partial 1-4 September block is week 1', openingWeeks.first.inSchoolYear && openingWeeks.first.week === 1, JSON.stringify(openingWeeks.first));
    check('7-11 September is week 2', openingWeeks.second.inSchoolYear && openingWeeks.second.week === 2, JSON.stringify(openingWeeks.second));
    check('31 August remains the previous year summer break', openingWeeks.august31?.name === 'Летен распуст 2025/2026', JSON.stringify(openingWeeks.august31));
    check('1 September starts the new working year', openingWeeks.september1 == null, JSON.stringify(openingWeeks.september1));
    check('the Monday header shows the previous year summer break', openingWeeks.mondayHeader.includes('Летен распуст 2025/2026'), openingWeeks.mondayHeader);

    console.log('\n40-minute presentation');
    const expectedRanges = ['08:00 - 08:40', '08:45 - 09:25', '09:40 - 10:20', '10:25 - 11:05', '11:10 - 11:50'];
    check('five 40-minute class ranges are shown', JSON.stringify(result.periods.map((period) => period.range)) === JSON.stringify(expectedRanges), JSON.stringify(result.periods));
    check('20-minute halves are no longer printed in the timetable', result.periods.every((period) => !period.text.includes('08:00 - 08:20') && !period.text.includes('08:20 - 08:40')));
    check('the two legacy halves remain in memory', result.slotShape[0].half1 === '08:00 - 08:20' && result.slotShape[0].half2 === '08:20 - 08:40');

    await page.evaluate(() => document.body.classList.add('dark-mode'));
    const desktopShot = join(tmpdir(), 'mtb-sdnevnik-compat-desktop.png');
    await page.screenshot({ path: desktopShot, fullPage: true });

    await page.locator('.week-calendar-button').click();
    check('the mismatch action opens the school-calendar editor', await page.locator('#data').evaluate((node) => node.classList.contains('active')));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        window.switchTab('schedule');
        window.updateWeekDisplay();
        window.renderSchedule();
    });
    const boxes = await page.locator('.week-nav > *').evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }));
    check('mobile week controls do not overlap', boxes.every((box, index) => boxes.every((other, otherIndex) =>
        index === otherIndex || box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top
    )), JSON.stringify(boxes));
    const mobileShot = join(tmpdir(), 'mtb-sdnevnik-compat-mobile.png');
    await page.screenshot({ path: mobileShot, fullPage: true });
    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    console.log(`\nscreenshots\n  ${desktopShot}\n  ${mobileShot}\n  ${rosterMobileShot}`);
    console.log(fails ? `\n${fails} FAILED\n` : '\nall assertions held\n');
    process.exit(fails ? 1 : 0);
};

run().catch((error) => { console.error(error); process.exit(1); });
