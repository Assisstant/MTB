/**
 * Списоци и пристап → Одделенија: the column „Кабинети", the ranking under the
 * table and the report — in a real browser, with every API call answered here
 * from invented data (rule 1). Owner, 8 Oct 2026: „кое дете од одделението од
 * кој кабинет е земано и колку вкупно кабинети го земаат … да може да се
 * испечати како извештај … кој наставник најповеќе деца му се земаат — ранг
 * листа". The page only READS: two endpoints that exist, nothing stored.
 *
 *   1. The column: per class, each child with the cabinets that take them and
 *      the terms a week. Two halves that touch are ONE term; a child is matched
 *      by id, so two children with one name are not folded together.
 *   2. The ranking: whose lessons the cabinets take the most different
 *      children from, then by exits a week; what it cannot see is said.
 *   3. The report is that same table and ranking, on paper and as a Word file,
 *      with whoever has a term and no class listed apart.
 *   4. A server that cannot answer leaves the rest of the page as it was.
 *
 *   node test/class-cabinets.browser.mjs        SHOT=<folder> for pictures
 */
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3986';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const ODD = 'Ода Одделенска';
const PRED = 'Пре Предметна';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const classes = [
    { id: 1, label: 'V-а', alias: 'V-а – проба', description: null, lessons: 4, lessons_without_subject: 0, unlinked_teachers: [] },
    { id: 2, label: 'VI-б', alias: null, description: null, lessons: 1, lessons_without_subject: 0, unlinked_teachers: [] }
];
const teachers = [
    { id: 11, name: ODD, kind: 'odd', subject: null, homeroom: 'V-а', classes: [{ label: 'V-а', role: 'homeroom' }] },
    { id: 12, name: PRED, kind: 'pred', subject: 'Англиски јазик', homeroom: null, classes: [{ label: 'V-а', role: 'subject' }, { label: 'VI-б', role: 'subject' }] }
];
// Two children share a name on purpose (rule 2): RS-2 and RS-3.
const students = [
    { public_id: 'RS-1', name: 'Измислено Дете', grade: 'V-а', oddelenie: 'V', kind: 'internal', active: true, therapists: [] },
    { public_id: 'RS-2', name: 'Исто Име', grade: 'V-а', oddelenie: 'V', kind: 'internal', active: true, therapists: [] },
    { public_id: 'RS-3', name: 'Исто Име', grade: 'V-а', oddelenie: 'V', kind: 'internal', active: true, therapists: [] },
    { public_id: 'RS-4', name: 'Друго Дете', grade: 'VI-б', oddelenie: 'VI', kind: 'internal', active: true, therapists: [] },
    { public_id: 'RS-5', name: 'Надворешно Дете', grade: null, oddelenie: null, kind: 'external', active: true, therapists: [] }
];
const therapists = [{ id: 21, name: 'Терапевт Први', active: true, students: [] }, { id: 22, name: 'ТЕРАПЕВТ ВТОР', active: true, students: [] }];
const term = (day, time, therapist, pupil) => {
    const t = therapists.find((x) => x.id === therapist), s = students.find((x) => x.public_id === pupil);
    return { day, day_order: 1, time, therapist_id: therapist, therapist_name: t.name, student_public_id: pupil || null, student_name: s ? s.name : null };
};
const sessions = [
    term('понеделник', '08:00-08:20', 21, 'RS-1'), term('понеделник', '08:20-08:40', 21, 'RS-1'),   // two halves: one term
    term('среда', '09:40-10:20', 21, 'RS-1'),                                                       // a second term
    term('вторник', '08:45-09:25', 22, 'RS-1'),                                                     // and another cabinet
    term('понеделник', '08:45-09:05', 21, 'RS-2'),
    term('четврток', '10:25-11:05', 22, 'RS-5'),                                                    // no class here
    term('петок', '08:00-08:40', 22, null)                                                          // a free term
];
const away = (pupil, therapist) => {
    const s = students.find((x) => x.public_id === pupil);
    return { student: s.name, studentPublicId: pupil, therapist, slots: [], minutes: 40 };
};
const lesson = (teacher, day, ordinal, cls, list) => ({ day, ordinal, teacher, teacherOnStaff: true, class: cls, subject: 'Предмет', away: list, awayCount: list.length });
const crossing = () => ({
    year: YEAR, isCurrentYear: true,
    bells: { teaching: [{ ordinal: 1, startsAt: '08:00' }, { ordinal: 2, startsAt: '08:45' }, { ordinal: 3, startsAt: '09:40' }] },
    teachers: teachers.map((t) => ({ id: t.id, name: t.name, kind: t.kind, homeroom: t.homeroom, classes: t.classes.map((c) => c.label), subject: '' })),
    classes: classes.map((c) => ({ label: c.label })),
    cells: [
        lesson(ODD, 'понеделник', 1, 'V-а', [away('RS-1', 'Терапевт Први')]),
        lesson(ODD, 'понеделник', 2, 'V-а', [away('RS-2', 'Терапевт Први')]),
        lesson(ODD, 'среда', 3, 'V-а', [away('RS-1', 'Терапевт Први')]),
        lesson(ODD, 'петок', 1, 'V-а', []),
        lesson(PRED, 'вторник', 2, 'V-а', [away('RS-1', 'ТЕРАПЕВТ ВТОР')]),
        lesson(PRED, 'четврток', 1, 'VI-б', [])
    ],
    unplaced: [], external: [{}],
    summary: { sessions: 5, placed: 4, unplaced: 0, external: 1, offStaffLessons: 0, lessonsDisrupted: 4 }
});

let weekDown = false;
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') return json(405, { error: 'this page only reads here' });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students, teachers, therapists, classes,
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/categories') return json(200, { categories: [{ id: 5, name: 'Логопед' }] });
        if (p === '/api/categories/holders') return json(200, { therapists: [{ personId: 21, categoryId: 5 }], teachers: [] });
        if (p === '/api/schedule/sessions') return weekDown ? json(500, { error: 'the week cannot be read' }) : json(200, { year: YEAR, sessions });
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
page.on('dialog', (d) => d.dismiss());
const shot = async (name) => {
    if (!process.env.SHOT) return;
    await mkdir(process.env.SHOT, { recursive: true });
    await page.screenshot({ path: join(process.env.SHOT, name + '.png'), fullPage: true });
};
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cellOf = (id) => `#classes tr[data-class="${id}"] td.class-cabinets`;

try {
    console.log('Одделенија → колоната „Кабинети"');
    await page.goto(`${ORIGIN}/Podatoci.html?tab=classes`);
    await page.waitForSelector(cellOf(1) + ' .cab-sum', { timeout: 8000 });
    const a = squash(await page.textContent(cellOf(1)));
    check('the class says how many of its children go, and to how many cabinets', a.startsWith('2 од 3 деца · 2 кабинети'), a);
    // A grid in the class's own row: the children down, the cabinets across.
    const grid = cellOf(1) + ' table.cab-grid';
    const cellsOf = (sel) => page.$$eval(sel, (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim())));
    const order = await page.$$eval('#classes > table > thead th, #classes table.list > thead th', (ths) => ths.map((t) => t.textContent.trim()));
    check('the column stands after „Предметни наставници", where the room is',
        order.indexOf('Кабинети') === order.indexOf('Предметни наставници') + 1 && order.indexOf('Кабинети') > 0, JSON.stringify(order));
    const head = (await cellsOf(grid + ' thead tr'))[0];
    check('across: the cabinets of this class, the one that takes the most children first; the profile over the name',
        JSON.stringify(head) === JSON.stringify(['Ученик', 'ЛогопедТерапевт Први', 'Терапевт Втор', 'Вк.']), JSON.stringify(head));
    const rows = await cellsOf(grid + ' tbody tr');
    check('a child with two cabinets: the terms a week under each, and their number',
        JSON.stringify(rows[0]) === JSON.stringify(['Измислено Дете', '2×', '1×', '2']), JSON.stringify(rows[0]));
    check('two halves that touch are one term, a third on another day is the second', rows[0][1] === '2×');
    check('two children with one name stay two rows: one goes, the other does not',
        JSON.stringify(rows.slice(1)) === JSON.stringify([['Исто Име', '1×', '·', '1'], ['Исто Име', '·', '·', '0']]), JSON.stringify(rows.slice(1)));
    const tips = await page.evaluate((g) => ({
        column: document.querySelector(g + ' thead th:nth-child(2)').title,
        cell: document.querySelector(g + ' tbody tr td').title,
        cut: getComputedStyle(document.querySelector(g + ' thead th:nth-child(2) span')).textOverflow,
        nameCut: getComputedStyle(document.querySelector(g + ' tbody th.who span')).textOverflow
    }), grid);
    check('a long text is cut with … and read whole on hover', tips.cut === 'ellipsis' && tips.nameCut === 'ellipsis'
        && tips.column === 'Терапевт Први · Логопед — зема 2 деца од паралелката'
        && tips.cell === 'Измислено Дете — Терапевт Први · Логопед: 2 термини неделно, 80 мин.', JSON.stringify(tips));
    check('the grid is its own: no pin, no fold, no sticky header from the list around it', await page.evaluate((g) =>
        !document.querySelector(g + ' .mtb-hpin, ' + g + ' .mtb-hfold') && getComputedStyle(document.querySelector(g + ' thead th')).position === 'static', grid));
    const b = squash(await page.textContent(cellOf(2)));
    check('a class nobody is taken from says so, without an empty grid', b === '0 од 1 дете · 0 кабинети' && !(await page.$(cellOf(2) + ' table')), b);
    // Readable is a measurement, in both themes (the button that did not inherit its colour).
    for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => {
            document.documentElement.dataset.theme = t;
            document.body.classList.toggle('dark-mode', t === 'dark');
            document.body.classList.toggle('dark', t === 'dark');
        }, theme);
        await page.waitForTimeout(150);
        const worst = await page.evaluate((g) => {
            const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
            const lum = ([r, gr, bl]) => [r, gr, bl].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const under = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 3 || c[3] > 0) return c; } return [255, 255, 255]; };
            let low = { ratio: 99 };
            for (const el of document.querySelectorAll(g + ' th, ' + g + ' td:not(.no), ' + g + ' .by, .class-cabinets .cab-sum')) {
                const a = lum(rgb(getComputedStyle(el).color)), bg = lum(under(el));
                const ratio = (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05);
                if (ratio < low.ratio) low = { ratio: Math.round(ratio * 10) / 10, what: el.className || el.tagName, text: el.textContent.slice(0, 20) };
            }
            return low;
        }, grid);
        check(`${theme} theme: every word of the grid is readable (4.5:1 or more)`, worst.ratio >= 4.5, JSON.stringify(worst));
        await shot('class-cabinets-' + theme);
    }
    await page.evaluate(() => { delete document.documentElement.dataset.theme; document.body.classList.remove('dark-mode', 'dark'); });

    console.log('\nранг-листата под табелата');
    const rank = await page.$$eval('#cabinetStats table tbody tr', (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent.trim())));
    check('the teacher with the most different children is first',
        JSON.stringify(rank[0]) === JSON.stringify(['1.', ODD, 'V-а', '2', '3', '3 од 4']), JSON.stringify(rank[0]));
    check('then the next, with the short names of the classes',
        JSON.stringify(rank[1]) === JSON.stringify(['2.', PRED, 'V-а, VI-б', '1', '1', '1 од 2']), JSON.stringify(rank[1]));
    const note = squash(await page.textContent('#cabinetStats .hint'));
    check('what the ranking cannot see is said beside it', /Од 5 термини неделно во кабинетите, 4 паѓаат во час/.test(note) && /1 се на екстерни ученици/.test(note), note);
    await shot('class-cabinets');

    console.log('\nизвештајот');
    await page.evaluate(() => {
        window.__printed = null;
        window.print = () => {
            const box = document.getElementById('printReport');
            window.__printed = { title: document.title, only: document.body.classList.contains('printing-report'),
                shown: getComputedStyle(box).display, text: box.innerText, html: box.innerHTML,
                style: [...document.querySelectorAll('style[media="print"]')].map((s) => s.textContent).join('') };
            window.dispatchEvent(new Event('afterprint'));
        };
    });
    const titleBefore = await page.title();
    await page.click('#printCabinetReport');
    const printed = await page.evaluate(() => window.__printed);
    check('„Печати извештај" hands the browser the report alone, under its own name',
        Boolean(printed) && printed.only && printed.title === 'Кабинети по одделение — ' + YEAR, JSON.stringify(printed && { title: printed.title, only: printed.only }));
    const text = squash(printed && printed.text);
    check('each class with its homeroom teacher and its sum', text.includes('V-а – проба — раководител: ' + ODD) && text.includes('2 од 3 деца одат во кабинет · 2 кабинети'), text.slice(0, 400));
    check('each child, the cabinets and their number', /1\.\s*Измислено Дете\s*Терапевт Први · Логопед \(2×\); Терапевт Втор \(1×\)\s*2/.test(text), text.slice(0, 600));
    check('whoever has a term and no class is listed apart', /Без паралелка \(екстерни и невнесени\).*Надворешно Дете\s*Терапевт Втор \(1×\)\s*1/.test(text), text);
    check('and the ranking, with the total above', text.includes('Вкупно: 2 од 4 деца во паралелките одат во кабинет.') && /Ранг-листа.*1\.\s*Ода Одделенска/.test(text));
    check('in the documents\' own letters, on A4', /Times New Roman/.test(printed.style) && /@page\{size:A4/.test(printed.style));
    check('no table of the report is given the screen\'s pin and fold', !/mtb-hpin|mtb-hfold/.test(printed.html) && /<table data-mtb-plain/.test(printed.html));
    check('after printing the page is as it was', (await page.title()) === titleBefore
        && await page.evaluate(() => !document.body.classList.contains('printing-report') && !document.getElementById('printReport').innerHTML));

    if (process.env.SHOT) {
        // the report as the paper sees it
        await page.evaluate(() => { window.__keep = window.print; window.print = () => {}; });
        await page.click('#printCabinetReport');
        await page.pdf({ path: join(process.env.SHOT, 'class-cabinets-report.pdf'), format: 'A4', margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } });
        await page.emulateMedia({ media: 'print' });
        await page.setViewportSize({ width: 794, height: 1123 });
        await shot('class-cabinets-report');
        await page.emulateMedia({ media: 'screen' });
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')); window.print = window.__keep; });
    }

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#wordCabinetReport')]);
    const word = await readFile(await download.path(), 'utf8');
    check('„Word" saves the same report as a file named for the year', download.suggestedFilename() === 'Kabineti-po-oddelenie-2026-2027.doc', download.suggestedFilename());
    check('with the same tables in it', word.includes('Измислено Дете') && word.includes('Ранг-листа') && word.includes('Без паралелка') && !/undefined|NaN/.test(word));

    console.log('\nсервер што не може да го прочита распоредот на кабинетите');
    weekDown = true;
    await page.reload();
    await page.waitForFunction((sel) => /не може да се прочита/.test((document.querySelector(sel) || {}).textContent || ''), cellOf(1), { timeout: 8000 });
    check('the column says so, the rest of the table stands', (await page.$$('#classes tr[data-class]')).length === 2
        && squash(await page.textContent('#classes tr[data-class="1"] .class-pupils')).startsWith('3'));
    check('and there is no ranking and no report to print', squash(await page.textContent('#cabinetStats')) === '');
} finally {
    check('no page errors', errors.length === 0, errors.join('\n       '));
    await browser.close();
}
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
