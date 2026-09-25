/**
 * A class reads the same in every picker — in a real browser, with every API
 * call answered here from invented data. Nothing is written anywhere.
 *
 * The owner, 25 Sep 2026: at the school a class is known by its TEACHER and by
 * the words of their own table („Комбинирана II, III, IV", „ученици со
 * аутизам"), not by the label we derived from the timetable — „каде учи тоа
 * дете? — кај наставничката". And on hover, the whole row: teacher, class, how many
 * children and who. What this proves:
 *
 *   1. Every class picker — Податоци (a pupil's row, a suggestion), the ✏️
 *      form, „Администрација" (the pupil and the filter), the shared-data
 *      panel and Уреди настава — writes the same line:
 *      label · homeroom · the year's description.
 *   2. Hovering a class, open or closed, shows the teacher, the description,
 *      the count with its generations, and the children.
 *   3. The value saved is still the label.
 *
 *   node test/class-cards.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3993';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

// ── the invented school ─────────────────────────────────────────────────
// II-б's homeroom comes only from the teachers' list, and in capitals, as a
// workbook import writes it: the line must still read as a name.
const classes = [
    { id: 1, label: 'I-а', description: 'ученици со аутизам', homeroom: 'Наставничка Прва' },
    { id: 2, label: 'II-б', description: 'Комбинирана II, III, IV', homeroom: null },
    { id: 3, label: 'подготвителна', description: null, homeroom: null }
];
const teachers = [
    { id: 1, name: 'Наставничка Прва', kind: 'odd', subject: null, homeroom: 'I-а', classes: [{ label: 'I-а', role: 'homeroom' }] },
    { id: 2, name: 'НАСТАВНИЧКА ВТОРА', kind: 'odd', subject: null, homeroom: 'II-б', classes: [{ label: 'II-б', role: 'homeroom' }] }
];
const students = [
    { public_id: 'p1', name: 'Ученик Прв', grade: 'I-а', oddelenie: 'I', kind: 'internal', active: true, therapists: [] },
    { public_id: 'p2', name: 'Ученичка Втора', grade: 'II-б', oddelenie: 'III', kind: 'internal', active: true, therapists: [] },
    { public_id: 'p3', name: 'Ученик Трет', grade: 'II-б', oddelenie: 'II', kind: 'internal', active: true, therapists: [] },
    { public_id: 'p4', name: 'Ученичка Четврта', grade: 'II-б', oddelenie: 'II', kind: 'internal', active: true, therapists: [] }
];
const LINE = 'II-б · Наставничка Втора · Комбинирана II, III, IV';
const HOVER = ['II-б — Комбинирана II, III, IV', 'Раководител: Наставничка Втора',
    '3 ученици · одд. II (2), III (1)', '• Ученик Трет — II', '• Ученичка Втора — III', '• Ученичка Четврта — II'];

const pupil = (s) => ({
    public_id: s.public_id, name: s.name, grade: s.grade, oddelenie: s.oddelenie,
    enrollment_type: 'internal', boarding: false, programme: 'unknown', placement: 'unknown',
    globally_active: true, annual_active: true, enrolled: true, therapists: [], expected: 'e'.repeat(64)
});

async function serve(context) {
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        const p = url.pathname;
        if (p.startsWith('/api/')) {
            if (req.method() !== 'GET') return json(405, { error: 'nothing is written in this test' });
            if (p === '/api/health') return json(200, { ok: true, server: { label: 'Пробна база' } });
            if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
            if (p === '/api/roster') return json(200, {
                year: YEAR, isCurrentYear: true, students, teachers, therapists: [],
                classes: classes.map((c) => ({ ...c, lessons: 0, lessons_without_subject: 0, unlinked_teachers: [] })),
                candidates: { students: [], teachers: [], therapists: [], classes: [] }
            });
            if (p === '/api/categories') return json(200, { categories: [] });
            if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
            if (p === '/api/teaching/subjects') return json(200, { subjects: [] });
            if (p === '/api/teaching/timetable') return json(200, {
                year: YEAR, lessons: [], teachers, clashes: [],
                classes: classes.map((c) => ({ id: c.id, label: c.label, description: c.description })),
                bells: { 'nastava-am': [{ ordinal: 1, label: '1', startsAt: '08:00' }], kabinet: [] }
            });
            // As the server sends it: the homeroom is read with the class.
            if (p === '/api/workspace') return json(200, {
                year: YEAR, pupils: students.map(pupil), employees: [],
                classes: classes.map((c) => ({ ...c, homeroom: c.homeroom
                    || (teachers.find((t) => t.classes.some((x) => x.label === c.label && x.role === 'homeroom')) || {}).name || null })),
                staffProfessions: { unknown: 'Непотврдено' }, staffDuties: { teaching: 'Настава' }
            });
            return json(404, { error: 'not in this test' });
        }
        const file = decodeURIComponent(p.replace(/^\//, ''));
        const path = join(ROOT, file);
        if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
    });
}

/** The option for II-б in a picker, and the picker's own hover once pointed at. */
async function picker(scope, selector, label = 'II-б') {
    await scope.locator(selector).first().waitFor({ state: 'attached', timeout: 8000 });
    return scope.locator(selector).first().evaluate((select, want) => {
        const option = [...select.options].find((o) => o.value === want);
        return {
            marked: select.hasAttribute('data-class-picker'),
            text: option ? option.textContent : null,
            title: option ? option.title : '',
            value: select.value
        };
    }, label);
}
const hoverHas = (title) => HOVER.every((line) => title.split('\n').includes(line));

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const errors = [];

{
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript(() => { try { localStorage.setItem('mtb_editing_v1', '1'); } catch (_) { /* the form is then not tested */ } });
    await serve(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    console.log('Податоци — a pupil\'s class');
    await page.goto(`${ORIGIN}/Podatoci.html?tab=students`);
    const row = await picker(page, '#students tr[data-student="p2"] .s-grade');
    check('the line is label · homeroom · description', row.text === LINE, row.text);
    check('the value is still the label', row.value === 'II-б', row.value);
    check('hovering the line shows the whole row', hoverHas(row.title), row.title);
    check('the picker is marked for its closed face', row.marked);
    await page.hover('#students tr[data-student="p2"] .s-grade');
    const closed = await page.$eval('#students tr[data-student="p2"] .s-grade', (s) => s.title);
    check('and the closed picker hovers the same', hoverHas(closed), closed);
    const plain = await picker(page, '#students tr[data-student="p2"] .s-grade', 'подготвителна');
    check('a class with no teacher and no words is just its label', plain.text === 'подготвителна', plain.text);
    const first = await picker(page, '#students tr[data-student="p1"] .s-grade', 'I-а');
    check('a homeroom that comes with the class reads the same', first.text === 'I-а · Наставничка Прва · ученици со аутизам', first.text);

    console.log('\nПодатоци — the class in its own list');
    await page.click('[data-tab="classes"], #tabClasses, button:has-text("Одделенија")').catch(() => {});
    const classHover = await page.locator('#classes .class-label', { hasText: 'II-б' }).first().getAttribute('title').catch(() => '');
    check('hovering the label shows the whole row', hoverHas(classHover || ''), classHover);

    console.log('\nthe ✏️ form');
    await page.goto(`${ORIGIN}/Podatoci.html?tab=students`);
    await page.waitForSelector('#students tr[data-student="p2"] [data-mtb-door="pupil"]', { timeout: 8000 });
    await page.click('#students tr[data-student="p2"] [data-mtb-door="pupil"]');
    const form = await picker(page, 'dialog.mtb-form select[name="grade"]');
    check('the same line', form.text === LINE, form.text);
    check('the same hover', hoverHas(form.title), form.title);
    check('the pupil\'s class is chosen', form.value === 'II-б', form.value);
    await context.close();
}

{
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await serve(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    console.log('\n„Администрација"');
    await page.goto(`${ORIGIN}/MTB-Workspace.html`);
    await page.waitForSelector('#maList [data-ma-id="p2"]', { timeout: 10000 });
    const filter = await picker(page, '#maClass');
    check('the class filter says the same line', filter.text === LINE, filter.text);
    check('with the same hover', hoverHas(filter.title), filter.title);
    await page.click('#maList [data-ma-id="p2"]');
    const admin = await picker(page, '#maForm select[name="grade"]');
    check('the pupil\'s class says the same line', admin.text === LINE, admin.text);
    check('with the same hover', hoverHas(admin.title), admin.title);
    check('and the pupil\'s class is chosen', admin.value === 'II-б', admin.value);

    console.log('\n„Заеднички податоци"');
    await page.click('#maClose');
    // The section that is already open folds the panel away, so it is
    // pressed only when the panel is not showing.
    if (!(await page.isVisible('#content'))) await page.click('#dirTabs [data-dir="students"]');
    await page.waitForSelector('#content [data-pick="p2"]', { timeout: 8000 });
    await page.click('#content [data-pick="p2"]');
    const panel = await picker(page, '#sGrade');
    check('the pupil\'s class says the same line', panel.text === LINE, panel.text);
    check('with the same hover', hoverHas(panel.title), panel.title);
    await page.click('#dirTabs [data-dir="classes"]');
    await page.waitForSelector('#content .master [data-pick="2"]', { timeout: 8000 });
    const listed = await page.$eval('#content .master [data-pick="2"]', (b) => ({ text: b.querySelector('.name').textContent, title: b.title }));
    check('a class in the list says the same line', listed.text === LINE, listed.text);
    check('and hovers the whole row', hoverHas(listed.title), listed.title);
    await page.fill('#search', 'Втора');
    const found = await page.$$eval('#content .master [data-pick]', (bs) => bs.map((b) => b.dataset.pick));
    check('a class is found by its teacher', found.length === 1 && found[0] === '2', found.join(', '));
    await page.fill('#search', 'аутизам');
    const byWords = await page.$$eval('#content .master [data-pick]', (bs) => bs.map((b) => b.dataset.pick));
    check('and by its words', byWords.length === 1 && byWords[0] === '1', byWords.join(', '));
    await context.close();
}

{
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await serve(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    console.log('\nУреди настава');
    await page.goto(`${ORIGIN}/NastavaUredi.html`);
    const lead = await picker(page, '#teachers tr[data-teacher="2"] .t-home');
    check('„which class a teacher leads" says the same line', lead.text === LINE, lead.text);
    check('with the same hover, children included', hoverHas(lead.title), lead.title);
    check('and the class is chosen', lead.value === 'II-б', lead.value);
    const rowHead = await page.locator('#grid button.cls-link[data-week="II-б"]').getAttribute('title').catch(() => '');
    check('the day grid\'s row hovers the whole row too', hoverHas(rowHead || ''), rowHead);
    await context.close();
}

console.log('');
check('no page errors', errors.length === 0, errors.join('\n       '));
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
