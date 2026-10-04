/**
 * Настава's ✏️ pupil doors (docs/PLAN-eden-urednik.md step 3, 4 Oct 2026), in
 * a real browser, every API call answered here from invented data (rule 1):
 *
 *   1. Hidden until „✏️ Уреди" is on; then beside the pupil in „Неповрзани
 *      третмани", in „Екстерни без доделено одделение" and in a lesson's panel.
 *   2. The door opens the ONE pupil form (mtb-forms.js) and its save goes
 *      through /api/workspace/pupils, as from every other screen.
 *   3. After the save the crossing is read again: the fixed session leaves
 *      the unplaced list.
 *   4. Two pupils who share a name are two pupils in the job count.
 *
 *   node test/nastava-doors.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3989';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const T = 'Наставничка Измислена';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const pupil = (id, name, grade, kind = 'internal') => ({
    public_id: id, name, grade, oddelenie: 'V', enrollment_type: kind, boarding: false, programme: 'unknown', placement: 'unknown',
    annual_active: true, globally_active: true, therapists: [], expected: { at: id + '-v1' }
});
const pupils = [
    pupil('nd-1', 'Измислено Дете Едно', 'VX-а'),
    pupil('nd-1b', 'Измислено Дете Едно', 'VX-а'),
    pupil('nd-2', 'Измислено Дете Надвор', '', 'external'),
    pupil('nd-3', 'Измислено Дете Час', 'V-а')
];
let fixed = false;
const session = (p, slot) => ({ day: 'понеделник', time_slot: slot, therapist: 'Терапевт Измислен', student: p.name, student_public_id: p.public_id, grade: p.grade, kind: p.enrollment_type });
const crossing = () => ({
    year: YEAR, isCurrentYear: true,
    bells: { teaching: [1, 2].map((o, i) => ({ ordinal: o, startsAt: ['08:00', '08:45'][i] })) },
    teachers: [{ id: 11, name: T, kind: 'odd', homeroom: 'V-а', classes: ['V-а'], subject: '' }],
    classes: [{ label: 'V-а' }],
    cells: [{ day: 'понеделник', ordinal: 1, teacher: T, teacherOnStaff: true, class: 'V-а', subject: 'Математика', awayCount: 1,
        away: [{ student: 'Измислено Дете Час', studentPublicId: 'nd-3', therapist: 'Терапевт Измислен', slots: ['08:00-08:40'], minutes: 40 }] }],
    unplaced: (fixed ? [] : [{ ...session(pupils[0], '09:00-09:40'), reasonCode: 'unknown-class' }])
        .concat([{ ...session(pupils[1], '10:00-10:40'), reasonCode: 'unknown-class' }]),
    external: [{ ...session(pupils[2], '11:00-11:40'), reasonCode: 'external' }],
    summary: { placed: 1, sessions: 4, external: 1, offStaffLessons: 0, lessonsDisrupted: 1 }
});

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
const writes = [];
let crossingReads = 0;
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/teaching/crossing') { crossingReads++; return json(200, crossing()); }
        if (p === '/api/workspace') return json(200, { year: YEAR, pupils, classes: [{ label: 'V-а' }, { label: 'V-б' }], employees: [] });
        if (p === '/api/workspace/pupils/nd-1' && req.method() === 'PUT') {
            const body = req.postDataJSON();
            writes.push(body);
            Object.assign(pupils[0], { grade: body.grade });
            fixed = true;
            return json(200, { pupil: { ...pupils[0], expected: { at: 'nd-1-v2' } } });
        }
        if (req.method() !== 'GET') { writes.push(req.method() + ' ' + p); return json(405, { error: 'not in this test' }); }
        return json(404, { error: 'not in this test' });
    }
    const file = decodeURIComponent(p.replace(/^\//, ''));
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shown = (selector) => page.$$eval(selector, (ns) => ns.filter((n) => getComputedStyle(n).display !== 'none').length);

try {
    console.log('\nНастава: ✏️ до ученикот');
    await page.goto(`${ORIGIN}/Nastava.html?view=week`);
    await page.locator('#unplaced table').waitFor();
    check('the doors are there, and hidden while editing is off',
        await page.locator('#unplaced .mtb-door').count() === 2 && await shown('#unplaced .mtb-door, #external .mtb-door') === 0);
    const job = (await page.textContent('#unplaced .jobs')).replace(/\s+/g, ' ');
    check('two pupils who share a name are two pupils', /2 термини, 2 ученици/.test(job), job);

    await page.click('.mtb-app-nav__editing');
    check('„✏️ Уреди" shows them in both lists', await shown('#unplaced .mtb-door') === 2 && await shown('#external .mtb-door') === 1);
    await page.click('#grid td.cell.clickable');
    check('and in a lesson\'s panel', await shown('#detail .mtb-door') === 1
        && (await page.getAttribute('#detail .mtb-door', 'data-id')) === 'nd-3');

    await page.click('#unplaced .mtb-door[data-id="nd-1"]');
    await page.locator('dialog.mtb-form select[name="grade"]').waitFor();
    check('the door opens the one pupil form', (await page.textContent('dialog.mtb-form .mtb-form__title')) === 'Измислено Дете Едно');
    const before = crossingReads;
    await page.selectOption('dialog.mtb-form select[name="grade"]', 'V-а');
    await page.click('dialog.mtb-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('dialog.mtb-form'), null, { timeout: 5000 });
    check('it saves through /api/workspace/pupils for the year', writes.length === 1 && writes[0].year === YEAR && writes[0].grade === 'V-а', JSON.stringify(writes));
    await page.waitForFunction((n) => !document.querySelector('#unplaced .mtb-door[data-id="nd-1"]'), null, { timeout: 5000 }).catch(() => {});
    check('the crossing is read again, and the fixed session leaves the list',
        crossingReads > before && await page.locator('#unplaced .mtb-door[data-id="nd-1"]').count() === 0, `reads ${before} → ${crossingReads}`);

    await page.emulateMedia({ media: 'print' });
    check('a printout carries no ✏️', await shown('.mtb-door') === 0);
    await page.emulateMedia({ media: 'screen' });
} finally {
    check('no page errors', errors.length === 0, errors.join('\n       '));
    await browser.close();
}
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
