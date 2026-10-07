/**
 * Настава → „🏫 Паралелка · недела" and the teacher's sheet: one fixed cell
 * (mtb-teacher-week.js `readCellHtml`), in a real browser, every API call
 * answered here from invented data (rule 1). Owner, 3 Oct 2026:
 *
 *   1. Every cell of a sheet is one height, whatever it holds.
 *   2. The children leaving a lesson sit side by side in equal columns under
 *      it, never stacked; past three, a „+N" says how many more.
 *   3. Text is cut to its column and said whole on hover.
 *   4. „Само предмети" hides them to a strip, one segment per therapy in its
 *      therapist's colour — the same therapist the same colour everywhere.
 *   5. The class sheet has the teacher sheet's own switch, and the choice is
 *      remembered in this browser.
 *
 *   node test/class-sheet.browser.mjs        SHOT=<folder> for pictures
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3988';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const T = 'Наставничка Измислена';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const away = (n, therapist, slot) => ({ student: 'Измислено Дете ' + n, studentPublicId: 'RS-' + n, therapist, slots: [slot], minutes: 40 });
const lesson = (day, ordinal, subject, aways = []) => ({ day, ordinal, teacher: T, teacherOnStaff: true, class: 'V-а', subject, awayCount: aways.length, away: aways });
const cells = [
    lesson('понеделник', 1, 'Македонски јазик', [away(1, 'Терапевт Прв', '08:00-08:40')]),
    lesson('понеделник', 2, 'Математика'),
    lesson('понеделник', 4, 'Физичко и здравствено образование со многу долго име', [
        away(2, 'Терапевт Прв', '10:25-11:05'), away(3, 'Терапевт Втор', '10:25-11:05'), away(4, 'Терапевт Трет', '10:25-11:05')]),
    lesson('вторник', 5, 'Природни науки', [
        away(5, 'Терапевт Прв', '11:10-11:50'), away(6, 'Терапевт Втор', '11:10-11:50'),
        away(7, 'Терапевт Трет', '11:10-11:50'), away(8, 'Терапевт Четврт', '11:10-11:50')]),
    lesson('среда', 3, 'Ликовно образование')
];
const crossing = () => ({
    year: YEAR, isCurrentYear: true,
    bells: { teaching: [1, 2, 3, 4, 5, 6].map((o, i) => ({ ordinal: o, startsAt: ['08:00', '08:45', '09:40', '10:25', '11:10', '11:55'][i] })) },
    teachers: [{ id: 11, name: T, kind: 'odd', homeroom: 'V-а', classes: ['V-а'], subject: '' }],
    classes: [{ label: 'V-а' }],
    cells: cells.map((c) => ({ ...c })),
    unplaced: [], external: [],
    summary: { placed: 8, sessions: 8, external: 0, offStaffLessons: 0, lessonsDisrupted: 3 }
});

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
const writes = [];
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') { writes.push(req.method() + ' ' + p); return json(405, { error: 'not in this test' }); }
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/teaching/crossing') return json(200, crossing());
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

const sheet = '#grid .personal[data-class="V-а"]';
/** The td of a day and a lesson number in the class sheet. */
const td = (day, ordinal) => page.evaluate(([s, d, o]) => {
    const table = document.querySelector(s + ' .p-grid');
    const dayIndex = Array.from(table.querySelectorAll('thead th')).findIndex((th) => th.textContent.trim().toLowerCase() === d);
    const row = Array.from(table.querySelectorAll('tbody tr')).find((tr) => tr.querySelector('th b').textContent.startsWith(o + '.'));
    const cell = row.children[dayIndex];
    const visible = (el) => el && getComputedStyle(el).display !== 'none';
    const aways = Array.from(cell.querySelectorAll('.p-aways .p-away'));
    const strip = cell.querySelector('.p-strip');
    return {
        aways: aways.filter(visible).length,
        tops: [...new Set(aways.filter(visible).map((a) => Math.round(a.getBoundingClientRect().top)))].length,
        widths: [...new Set(aways.filter(visible).map((a) => Math.round(a.getBoundingClientRect().width)))].length,
        more: cell.querySelector('.p-more') ? cell.querySelector('.p-more').textContent : '',
        moreTitle: cell.querySelector('.p-more') ? cell.querySelector('.p-more').title : '',
        firstTitle: aways[0] ? aways[0].title : '',
        lessonCut: (() => { const b = cell.querySelector('.p-lesson b'); if (!b) return null; const s = getComputedStyle(b);
            return s.whiteSpace === 'nowrap' && s.textOverflow === 'ellipsis' && s.overflow === 'hidden'; })(),
        lessonShown: visible(cell.querySelector('.p-lesson')),
        strip: visible(strip) ? Array.from(strip.children).map((i) => getComputedStyle(i).backgroundColor) : null
    };
}, [sheet, day, ordinal]);
const heights = (selector) => page.$$eval(selector + ' .p-grid tbody td', (tds) =>
    [...new Set(tds.map((t) => Math.round(t.getBoundingClientRect().height)))]);

try {
    console.log('\nНастава → Паралелка · недела: една ќелија, иста големина');
    await page.goto(`${ORIGIN}/Nastava.html?view=classweek`);
    await page.locator(sheet + ' .p-grid').waitFor();

    checkEq('every cell of the class sheet has one height', (await heights(sheet)).length, 1);
    check('the class sheet has the teacher sheet\'s switch', await page.locator(sheet + ' .p-modes [data-p-mode]').count() === 3);

    let c = await td('понеделник', 4);
    checkEq('three therapies: three columns, side by side, equal', [c.aways, c.tops, c.widths], [3, 1, 1]);
    check('a long subject is cut to its column', c.lessonCut === true);
    checkEq('hover says it whole: the child, the therapist, the time', c.firstTitle, 'Измислено Дете 2 — Терапевт Прв · 10:25–11:05');

    c = await td('вторник', 5);
    checkEq('four therapies: three shown and „+1"', [c.aways, c.more], [3, '+1']);
    check('the „+1" says who on hover', /Измислено Дете 8 — Терапевт Четврт/.test(c.moreTitle), c.moreTitle);

    if (process.env.SHOT) await page.locator(sheet).screenshot({ path: join(process.env.SHOT, 'class-sheet-all.png') });

    await page.click(sheet + ' [data-p-mode="subjects"]');
    checkEq('„Само предмети": still one height', (await heights(sheet)).length, 1);
    const mon4 = await td('понеделник', 4), tue5 = await td('вторник', 5), mon1 = await td('понеделник', 1);
    checkEq('„Само предмети": the therapies are hidden', [mon4.aways, tue5.aways], [0, 0]);
    checkEq('and a strip says how many, one segment each', [mon4.strip && mon4.strip.length, tue5.strip && tue5.strip.length], [3, 4]);
    checkEq('the same therapist, the same colour in every cell', [mon1.strip[0], mon4.strip[0]].every((x) => x === tue5.strip[0]), true);
    checkEq('three therapists, three colours here', new Set(mon4.strip).size, 3);
    checkEq('four therapists, four colours there', new Set(tue5.strip).size, 4);
    checkEq('a lesson nobody leaves has no strip', (await td('понеделник', 2)).strip, null);

    if (process.env.SHOT) await page.locator(sheet).screenshot({ path: join(process.env.SHOT, 'class-sheet-subjects.png') });

    await page.reload();
    await page.locator(sheet + ' .p-grid').waitFor();
    checkEq('the switch is remembered in this browser', await page.locator(sheet + ' [data-p-mode="subjects"]').getAttribute('aria-pressed'), 'true');

    await page.click(sheet + ' [data-p-mode="cabinets"]');
    c = await td('понеделник', 4);
    checkEq('„Само кабинети": the therapies, no lesson', [c.aways, c.lessonShown], [3, false]);
    await page.click(sheet + ' [data-p-mode="all"]');

    console.log('\nНастава → Наставник · недела: истата ќелија');
    await page.goto(`${ORIGIN}/Nastava.html?view=personal`);
    await page.locator('#grid .personal .p-grid').waitFor();
    checkEq('every cell of the teacher sheet has one height', (await heights('#grid .personal')).length, 1);

    // 7 Oct 2026: the two sheets as a picture and a Word file, in the view chosen on
    // the sheet, for any teacher; and ⎙ always prints the read sheet.
    console.log('\nСлика, Word и печатење на листовите');
    checkEq('„Слика“ and „Word“ are at the top in the sheet views', [await page.isVisible('#pngBtn'), await page.isVisible('#wordBtn')], [true, true]);
    await page.click('#pngBtn');
    check('a picture is one sheet: with „Сите наставници“ it asks for a choice', /изберете наставник/i.test(await page.textContent('#status')), await page.textContent('#status'));
    const wordOf = async () => {
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#wordBtn')]);
        return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') };
    };
    await page.click('#grid .personal [data-p-mode="all"]');
    let doc = await wordOf();
    check('Word for everybody on the screen, named for the year', /^Rasporedi_nastavnici_2026-2027\.doc$/.test(doc.name) && doc.text.includes('Неделен распоред — ' + T), doc.name);
    check('the table is fixed in points and the page is landscape, as Word needs',
        /mso-table-layout-alt:fixed/.test(doc.text) && !/width:\s*100%/.test(doc.text) && /mso-page-orientation:landscape/.test(doc.text));
    check('„Часови и кабинети“: the lesson and who leaves it', /class="lesson"/.test(doc.text) && doc.text.includes('Измислено Дете 1'));
    await page.selectOption('#who', T);
    await page.locator('#grid .personal .p-grid').waitFor();
    await page.click('#grid .personal [data-p-mode="subjects"]');
    doc = await wordOf();
    check('„Само предмети“: the lessons and no therapy, and the sheet says which view it is',
        /class="lesson"/.test(doc.text) && !doc.text.includes('Измислено Дете') && /само предмети/.test(doc.text) && doc.name.startsWith('Raspored_'), doc.name);
    await page.click('#grid .personal [data-p-mode="cabinets"]');
    doc = await wordOf();
    check('„Само кабинети“: the therapies and no lesson', !/class="lesson"/.test(doc.text) && doc.text.includes('Измислено Дете 1'));
    const [png] = await Promise.all([page.waitForEvent('download'), page.click('#pngBtn')]);
    check('a picture of the chosen teacher\'s sheet', /^Licen-raspored-.*\.png$/.test(png.suggestedFilename()), png.suggestedFilename());
    await page.click('#grid .personal [data-p-mode="all"]');

    const printed = await page.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const state = () => ({ title: document.title, pickers: document.querySelectorAll('#grid .p-edit').length,
            cells: new Set([...document.querySelectorAll('#grid .p-grid tbody td')].map((c) => c.offsetHeight)).size });
        const before = document.title;
        let during = null;
        window.print = () => { during = state(); };
        window.MTBForms.setEditing(true);
        await wait(400);
        const open = state();
        document.getElementById('printBtn').click();
        window.dispatchEvent(new Event('afterprint'));
        await wait(200);
        const after = state();
        window.MTBForms.setEditing(false);
        await wait(200);
        return { before, open, during, after };
    });
    check('while the week is open for typing, the sheet has pickers', printed.open.pickers > 0, JSON.stringify(printed.open));
    check('⎙ prints the read sheet: no pickers, one cell height, the sheet\'s name as the title',
        printed.during && printed.during.pickers === 0 && printed.during.cells === 1 && printed.during.title === 'Неделен распоред — ' + T, JSON.stringify(printed.during));
    check('and afterwards the page is as it was: pickers back, its own title', printed.after.pickers > 0 && printed.after.title === printed.before, JSON.stringify(printed.after));

    await page.goto(`${ORIGIN}/Nastava.html?view=classweek`);
    await page.locator(sheet + ' .p-grid').waitFor();
    await page.selectOption('#klass', 'V-а');
    doc = await wordOf();
    check('the class sheet the same way', /^Paralelka_V-а_2026-2027\.doc$/.test(doc.name) && doc.text.includes('Паралелка') && doc.text.includes('Измислено Дете 1'), doc.name);

    checkEq('nothing was written', writes, []);
    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
