/**
 * A teacher's own week — Податоци → „🗓️ Распоред" and Настава → „👤 Наставник ·
 * недела", which draw it from ONE file, mtb-teacher-week.js — in a real
 * browser, with every API call answered here from invented data (rule 1).
 * What the server decides about a lesson is asserted against a real database
 * in teaching-edit.e2e.ts; this proves what the page sends and shows:
 *
 *   1. Locked by default: the sheet reads and prints, no picker anywhere.
 *   2. 🔒/🔓 sits in the table's corner beside 📌 and opens the pickers.
 *   3. ОДДЕЛЕНСКИ: the class is theirs — no class picker; the subject is
 *      chosen from what the class learns, and written into their class.
 *   4. ПРЕДМЕТЕН: the class first, their own паралелки before the rest, then
 *      one of their own subjects; with two of their own none is guessed.
 *   5. „✕ слободен час" frees the period; every write carries `expected`.
 *   6. Настава draws the same sheet from the same file.
 *
 *   node test/teacher-week.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3987';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const ODD = 'Ода Одделенска';
const PRED = 'Пре Предметна';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const cells = [
    { day: 'понеделник', ordinal: 1, teacher: ODD, teacherOnStaff: true, class: 'V-а', subject: 'Македонски јазик', awayCount: 1,
      away: [{ student: 'Измислено Дете', studentPublicId: 'RS-1', therapist: 'Терапевт Проба', slots: ['08:00-08:40'], minutes: 40 }] },
    { day: 'вторник', ordinal: 2, teacher: PRED, teacherOnStaff: true, class: 'VI-б', subject: 'Англиски јазик', awayCount: 0, away: [] }
];
const crossing = () => ({
    year: YEAR, isCurrentYear: true,
    bells: { teaching: [{ ordinal: 1, startsAt: '08:00' }, { ordinal: 2, startsAt: '08:45' }, { ordinal: 3, startsAt: '09:40' }] },
    teachers: [
        { id: 11, name: ODD, kind: 'odd', homeroom: 'V-а', classes: ['V-а'], subject: '' },
        { id: 12, name: PRED, kind: 'pred', homeroom: null, classes: ['V-а', 'VI-б'], subject: 'Англиски јазик, Германски јазик' }
    ],
    classes: [{ label: 'V-а' }, { label: 'VI-б' }, { label: 'IX-а' }],
    cells: cells.map((c) => ({ ...c })),
    unplaced: [], external: [],
    summary: { placed: 1, sessions: 1, external: 0, offStaffLessons: 0, lessonsDisrupted: 1 }
});

const writes = [];
let refuseNext = null;        // what the lesson route answers next, when not 200
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (p === '/api/teaching/teacher-lesson' && req.method() === 'PUT') {
            const b = JSON.parse(req.postData() || '{}');
            writes.push(b);
            if (refuseNext) { const answer = refuseNext; refuseNext = null; return json(409, answer); }
            // What the server would now hold, so the reload shows it.
            const at = cells.findIndex((c) => c.teacher === b.teacher && c.day === b.day && c.ordinal === b.ordinal);
            if (at >= 0) cells.splice(at, 1);
            if (b.class) cells.push({ day: b.day, ordinal: b.ordinal, teacher: b.teacher, teacherOnStaff: true,
                class: b.class, subject: b.subject || '', awayCount: 0, away: [] });
            return json(200, { ok: true });
        }
        if (req.method() !== 'GET') return json(405, { error: 'not in this test' });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/categories') return json(200, { categories: [] });
        if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
        if (p === '/api/teaching/crossing') return json(200, crossing());
        if (p === '/api/teaching/subjects') return json(200, { subjects: [
            { subject: 'Македонски јазик' }, { subject: 'Математика' }, { subject: 'Англиски јазик' }] });
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
page.on('dialog', (d) => d.dismiss());

const sheet = '#weekSheet .personal';
const cell = (day, ordinal) => `#weekSheet td.p-cell[data-day="${day}"][data-ordinal="${ordinal}"]`;
const waitWrites = async (n) => { for (let i = 0; i < 40 && writes.length < n; i++) await page.waitForTimeout(100); };
const optionTexts = (selector) => page.$$eval(selector + ' option', (os) => os.map((o) => o.textContent.trim()));
const groupOf = (selector, label) => page.$$eval(selector + ' optgroup', (gs, l) => {
    const g = gs.find((x) => x.label.startsWith(l));
    return g ? [...g.querySelectorAll('option')].map((o) => o.value) : null;
}, label);

try {
    console.log('Податоци → 🗓️ Распоред, заклучено');
    await page.goto(`${ORIGIN}/Podatoci.html?tab=week`);
    await page.waitForSelector(sheet, { timeout: 8000 });
    check('the tab is in the strip', await page.isVisible('.tabs [data-tab="week"]'));
    const head = await page.textContent(sheet + ' .p-head');
    check('the first teacher on the list, as a одделенски with their class', head.includes(ODD) && /одделенски наставник · V-а/.test(head), head);
    check('locked by default: not one picker', (await page.$$(sheet + ' select')).length === 0);
    const days = await page.$$eval(sheet + ' thead th', (ths) => ths.slice(1).map((t) => t.textContent.trim()));
    check('all five days, even with lessons on two', days.length === 5, JSON.stringify(days));
    const body = await page.textContent(sheet + ' tbody');
    check('the lesson and who leaves it for a therapy', body.includes('Македонски јазик') && body.includes('↳ Измислено Дете'));
    const corner = sheet + ' thead th:first-child';
    check('🔒 in the corner of the table…', (await page.getAttribute(corner + ' [data-p-lock]', 'aria-pressed')) === 'false');
    await page.waitForSelector(corner + ' .mtb-hpin', { timeout: 3000 }).catch(() => {});
    check('…beside 📌', Boolean(await page.$(corner + ' .mtb-hpin')));

    console.log('\n🔓 отворено: одделенски');
    await page.click(corner + ' [data-p-lock]');
    await page.waitForSelector(cell('среда', 2) + ' select', { timeout: 5000 });
    check('the corner now says 🔓', (await page.getAttribute(sheet + ' thead th:first-child [data-p-lock]', 'aria-pressed')) === 'true');
    await page.waitForSelector(corner + ' .mtb-hpin', { timeout: 3000 }).catch(() => {});
    check('📌 stays beside it on the redrawn table', Boolean(await page.$(corner + ' .mtb-hpin')));
    check('no class picker: V-а is theirs', (await page.$$(sheet + ' select.p-class')).length === 0);
    check('the hint says so', /Одделенски наставник: паралелката е V-а/.test(await page.textContent(sheet + ' .p-edithint')));
    await page.waitForFunction((s) => [...document.querySelectorAll(s + ' option')].some((o) => o.value === 'Математика'),
        cell('среда', 2) + ' select.p-subj', { timeout: 5000 }).catch(() => {});
    check('the subject from what the class learns', (await optionTexts(cell('среда', 2) + ' select.p-subj')).includes('Математика'));
    await page.selectOption(cell('среда', 2) + ' select.p-subj', 'Математика');
    await waitWrites(1);
    const w1 = writes[0] || {};
    check('written into their own class', w1.teacher === ODD && w1.day === 'среда' && w1.ordinal === 2
        && w1.class === 'V-а' && w1.subject === 'Математика', JSON.stringify(w1));
    check('with what the cell showed as expected', w1.expected && w1.expected.class === null, JSON.stringify(w1.expected));
    await page.waitForFunction(() => /Математика/.test(document.querySelector('#weekSheet .personal tbody').textContent), null, { timeout: 5000 }).catch(() => {});
    check('the sheet is read again from the server', (await page.$eval(cell('среда', 2), (td) => td.dataset.subject)) === 'Математика');

    console.log('\n🔓 отворено: предметен');
    await page.selectOption('#weekTeacher', PRED);
    await page.waitForSelector(`${sheet}[data-teacher="${PRED}"]`, { timeout: 5000 });
    const own = await groupOf(cell('среда', 1) + ' select.p-class', 'Паралелки на');
    const rest = await groupOf(cell('среда', 1) + ' select.p-class', 'Други');
    check('their own паралелки first', JSON.stringify(own) === JSON.stringify(['V-а', 'VI-б']), JSON.stringify(own));
    check('the others under „Други"', JSON.stringify(rest) === JSON.stringify(['IX-а']), JSON.stringify(rest));
    check('an empty period is one picker, not two', !(await page.$(cell('среда', 1) + ' select.p-subj')));
    await page.selectOption(cell('среда', 1) + ' select.p-class', 'V-а');
    await waitWrites(2);
    const w2 = writes[1] || {};
    check('the class is written, and with two subjects of their own none is guessed',
        w2.teacher === PRED && w2.class === 'V-а' && w2.subject === null, JSON.stringify(w2));
    await page.waitForSelector(cell('среда', 1) + ' select.p-subj', { timeout: 5000 });
    const subjects = await groupOf(cell('среда', 1) + ' select.p-subj', 'Предмети на');
    check('then the subject, from their own', JSON.stringify(subjects) === JSON.stringify(['Англиски јазик', 'Германски јазик']), JSON.stringify(subjects));
    await page.selectOption(cell('вторник', 2) + ' select.p-subj', '__clear');
    await waitWrites(3);
    const w3 = writes[2] || {};
    check('„✕ слободен час" frees the period, against what was there',
        w3.class === null && w3.expected && w3.expected.class === 'VI-б', JSON.stringify(w3));

    // „Врати" / „Повтори" (owner, 6 Oct 2026): the last writes of this window,
    // taken back through the SAME route with what each left as `expected`.
    console.log('\n↶ Врати / ↷ Повтори');
    const undoBtn = '.mtb-undo [data-mtb-undo="undo"]', redoBtn = '.mtb-undo [data-mtb-undo="redo"]';
    const pill = () => page.$$eval('.mtb-undo button', (bs) => bs.map((b) => b.textContent + (b.disabled ? ' off' : '')));
    const toastText = () => page.$eval('.mtb-toast', (t) => t.dataset.kind + ': ' + t.textContent).catch(() => '');
    check('three writes, three steps to take back, nothing to repeat', JSON.stringify(await pill()) === JSON.stringify(['↶ Врати (3)', '↷ Повтори off']), JSON.stringify(await pill()));
    check('the button says which change it would take back', /Врати: .*Пре Предметна · вторник · 2\. час/.test(await page.getAttribute(undoBtn, 'title')));
    await page.click(undoBtn);
    await waitWrites(4);
    const u1 = writes[3] || {};
    check('„Врати" writes the period back as it was, through the same route',
        u1.teacher === PRED && u1.day === 'вторник' && u1.ordinal === 2 && u1.class === 'VI-б' && u1.subject === 'Англиски јазик', JSON.stringify(u1));
    check('against what the change left there', u1.expected && u1.expected.class === null, JSON.stringify(u1.expected));
    await page.waitForFunction((s) => (document.querySelector(s) || { dataset: {} }).dataset.class === 'VI-б', cell('вторник', 2), { timeout: 5000 }).catch(() => {});
    check('the sheet is read again and shows it', (await page.$eval(cell('вторник', 2), (td) => td.dataset.class)) === 'VI-б');
    check('and it is said', /^synced: .*Вратено: .*вторник · 2\. час/.test(await toastText()), await toastText());
    check('one step less to take back, one to repeat', JSON.stringify(await pill()) === JSON.stringify(['↶ Врати (2)', '↷ Повтори (1)']), JSON.stringify(await pill()));
    await page.click(redoBtn);
    await waitWrites(5);
    const r1 = writes[4] || {};
    check('„Повтори" makes the change again, against what „Врати" put back', r1.class === null && r1.expected && r1.expected.class === 'VI-б', JSON.stringify(r1));
    // While a step is being written both buttons are off; the key waits for it like a click does.
    await page.waitForFunction((s) => !document.querySelector(s).disabled, undoBtn, { timeout: 5000 });
    await page.locator(undoBtn).focus();
    await page.keyboard.press('Control+z');
    await waitWrites(6);
    await page.waitForFunction((s) => !document.querySelector(s).disabled, undoBtn, { timeout: 5000 });
    check('Ctrl+Z is the same „Врати"', (writes[5] || {}).class === 'VI-б' && JSON.stringify(await pill()) === JSON.stringify(['↶ Врати (2)', '↷ Повтори (1)']), JSON.stringify(writes[5]));
    // Somebody changed that period since: the server refuses, nothing is forced.
    refuseNext = { error: 'changed', code: 'stale' };
    await page.click(undoBtn);
    await waitWrites(7);
    await page.waitForFunction(() => (document.querySelector('.mtb-toast') || { dataset: {} }).dataset.kind === 'error', null, { timeout: 5000 }).catch(() => {});
    check('a period somebody changed since is not forced back: the refusal is said', /^error: .*Не е вратено — .*среда · 1\. час: Некој друг го смени/.test(await toastText()), await toastText());
    check('that step is dropped, the others stay', JSON.stringify(await pill()) === JSON.stringify(['↶ Врати (1)', '↷ Повтори (1)']), JSON.stringify(await pill()));
    check('ten steps are kept, the oldest forgotten', await page.evaluate(() => {
        const u = window.MTBAppNavigation.undo;
        for (let i = 0; i < 12; i++) u.record({ label: 'проба ' + i, undo: async () => {}, redo: async () => {} });
        const kept = u.depth();
        u.clear();
        return kept.undo === 10 && kept.redo === 0 && u.depth().undo === 0;
    }));
    check('with nothing to take back the control is out of the way', await page.$eval('.mtb-undo', (n) => n.hidden));

    console.log('\n🔒 заклучено пак');
    await page.click(sheet + ' thead th:first-child [data-p-lock]');
    await page.waitForFunction(() => !document.querySelector('#weekSheet .personal select'), null, { timeout: 5000 }).catch(() => {});
    check('the pickers are gone', (await page.$$(sheet + ' select')).length === 0);
    check('one mode for the suite, not a second one', await page.evaluate(() => localStorage.getItem('mtb_editing_v1') === null));

    console.log('\nНастава → 👤 Наставник · недела, од истата датотека');
    // What the sheet shows: the three buttons, as on the colleagues' page (owner, 1 Oct 2026).
    check('the sheet offers „Часови и кабинети", „Само предмети" and „Само кабинети"',
        (await page.$$eval('#weekSheet .personal [data-p-mode]', (bs) => bs.map((b) => b.textContent).join('|'))) === 'Часови и кабинети|Само предмети|Само кабинети'
        && await page.$eval('#weekSheet .personal', (n) => n.classList.contains('show-all')));
    await page.click('#weekSheet .personal [data-p-mode="subjects"]');
    check('„Само предмети" hides who leaves for a cabinet, without asking the server',
        await page.$eval('#weekSheet .personal', (n) => n.classList.contains('show-subjects') && !n.classList.contains('show-all'))
        && (await page.getAttribute('#weekSheet .personal [data-p-mode="subjects"]', 'aria-pressed')) === 'true'
        && await page.evaluate(() => localStorage.getItem('mtb_teacher_week_mode_v1') === 'subjects'));
    await page.click('#weekSheet .personal [data-p-mode="all"]');
    check('and „Часови и кабинети" puts both back, remembering nothing', await page.evaluate(() => localStorage.getItem('mtb_teacher_week_mode_v1') === null));
    await page.goto(`${ORIGIN}/Nastava.html?view=personal`);
    await page.waitForSelector('#grid .personal', { timeout: 8000 });
    await page.selectOption('#who', ODD);
    await page.waitForFunction(() => document.querySelectorAll('#grid .personal').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('the same sheet', /одделенски наставник · V-а/.test(await page.textContent('#grid .personal .p-head')));
    await page.click('#grid .personal thead th:first-child [data-p-lock]');
    await page.waitForSelector('#grid td.p-cell select.p-subj', { timeout: 5000 }).catch(() => {});
    check('and the same 🔓 opens its pickers', (await page.$$('#grid select.p-subj')).length > 0);
    check('the bar\'s ✏️ switch agrees', (await page.getAttribute('#personalEdit', 'aria-pressed')) === 'true');
    // A page that writes lessons must not call itself read-only in the shared bar.
    const said = await page.evaluate(() => window.__MTB_DATA_STATE__ || {});
    check('and the bar does not say „само читање"', said.state !== 'readonly' && !/само читање/i.test(said.text || ''), JSON.stringify(said));
    await page.click('#personalEdit');
} finally {
    check('no page errors', errors.length === 0, errors.join('\n       '));
    await browser.close();
}
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
