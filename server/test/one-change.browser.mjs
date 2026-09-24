/**
 * One change, every window — in a real browser, with every API call answered
 * here from invented data (like forms-queue.browser.mjs). Nothing is written
 * to any database.
 *
 * The owner, 24 Sep 2026: „ако нешто се промени на едно место, треба да биде
 * истото и во паѓачкото мени и на другите места каде се појавува податокот".
 * It was not: every screen read the lists once, when it opened, and only the
 * ✏️ form told the others. What this proves:
 *
 *   1. A class added in one tab of Податоци is in the pupils' class dropdown
 *      of another tab, without that tab being reloaded — and Уреди настава
 *      reads its timetable again too.
 *   2. A tab with an unsaved row does NOT redraw under it: the row keeps what
 *      was chosen, the tab says why it waits, and it catches up after the save.
 *   3. A pupil whose class is not on the year's list shows that class, marked
 *      „неактивна", instead of „— без одделение —".
 *   4. In the workspace, a class added in the Податоци window reaches
 *      „Администрација" and „Заеднички податоци" in the shell, and a pupil
 *      saved in „Администрација" reaches the Податоци window without
 *      „Администрација" redrawing over its own „Зачувано". This part runs
 *      with BroadcastChannel removed, so the only way through is the shell
 *      passing the change on — which is what a frame from another origin
 *      (the workspace opened from GitHub Pages) depends on.
 *
 *   node test/one-change.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3994';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

// ── the invented database ───────────────────────────────────────────────
const db = {
    classes: [{ id: 1, label: 'I-а' }, { id: 2, label: 'II-б' }],
    students: [
        { public_id: 'p-ana', name: 'Ана Измислена', grade: 'II-б', oddelenie: 'II', kind: 'internal', active: true, therapists: [] },
        // Her class was taken off this year's list; she still carries it.
        { public_id: 'p-boj', name: 'Бојан Измислен', grade: 'III-стара', oddelenie: 'III', kind: 'internal', active: true, therapists: [] }
    ]
};
let nextClassId = 3;
const roster = () => ({
    year: YEAR, isCurrentYear: true,
    students: db.students, teachers: [], therapists: [],
    classes: db.classes.map((c) => ({ ...c, description: null, lessons: 0, lessons_without_subject: 0, unlinked_teachers: [] })),
    candidates: { students: [], teachers: [], therapists: [], classes: [] }
});
const pupil = (s) => ({
    public_id: s.public_id, name: s.name, grade: s.grade, oddelenie: s.oddelenie,
    enrollment_type: 'internal', boarding: false, programme: 'unknown', placement: 'unknown',
    globally_active: true, annual_active: true, enrolled: true, therapists: [], expected: 'e'.repeat(64)
});

/** Every GET of an API path: which tab, and which document in it, asked. */
const reads = [];
function watch(page, tag) {
    page.on('request', (r) => {
        const u = new URL(r.url());
        if (r.method() !== 'GET' || !u.pathname.startsWith('/api/')) return;
        let doc = '';
        try { doc = new URL(r.frame().url()).pathname.split('/').pop(); } catch (_) { /* a worker */ }
        reads.push({ tag, doc, path: u.pathname });
    });
}
const countReads = (tag, path, doc) =>
    reads.filter((r) => r.tag === tag && r.path === path && (!doc || r.doc === doc)).length;

async function serve(context) {
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        const p = url.pathname;
        if (p.startsWith('/api/')) {
            const method = req.method();
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            if (p === '/api/health') return json(200, { ok: true, server: { label: 'Пробна база' } });
            if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
            if (p === '/api/roster') return json(200, roster());
            if (p === '/api/categories') return json(200, { categories: [] });
            if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
            if (p === '/api/teaching/subjects') return json(200, { subjects: [] });
            if (p === '/api/teaching/timetable') return json(200, {
                year: YEAR, lessons: [], teachers: [],
                classes: db.classes.map((c) => ({ ...c, description: null })),
                bells: { 'nastava-am': [{ ordinal: 1, label: '1', startsAt: '08:00' }], kabinet: [] }
            });
            if (p === '/api/workspace') return json(200, {
                year: YEAR, pupils: db.students.map(pupil), employees: [], classes: db.classes,
                staffProfessions: { unknown: 'Непотврдено' }, staffDuties: { teaching: 'Настава' }
            });
            if (p === '/api/teaching/class' && method === 'POST') {
                const made = { id: nextClassId++, label: body.label };
                db.classes.push(made);
                return json(201, { ...made, created: true });
            }
            const pupilPut = /^\/api\/workspace\/pupils\/([^/]+)$/.exec(p);
            if (pupilPut && method === 'PUT') {
                const s = db.students.find((x) => x.public_id === decodeURIComponent(pupilPut[1]));
                Object.assign(s, { name: body.name, grade: body.grade, oddelenie: body.oddelenie });
                return json(200, { pupil: pupil(s) });
            }
            const student = /^\/api\/students\/([^/]+)$/.exec(p);
            if (student && method === 'PATCH') {
                const s = db.students.find((x) => x.public_id === decodeURIComponent(student[1]));
                Object.assign(s, { name: body.name, kind: body.kind, grade: body.grade, oddelenie: body.oddelenie });
                return json(200, { ok: true, student: s, enrolled: true });
            }
            return json(404, { error: 'not in this test' });
        }
        const file = decodeURIComponent(p.replace(/^\//, ''));
        const path = join(ROOT, file);
        if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
    });
}

const optionsOf = (page, id) => page.$$eval(`#students tr[data-student="${id}"] .s-grade option`,
    (os) => os.map((o) => ({ value: o.value, text: o.textContent, selected: o.selected })));
const offers = (page, id, label) => page.waitForFunction(([who, want]) =>
    [...document.querySelectorAll(`#students tr[data-student="${who}"] .s-grade option`)].some((o) => o.value === want),
    [id, label], { timeout: 6000 }).then(() => true, () => false);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

// ── two tabs of Податоци, and Уреди настава ─────────────────────────────
{
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
    await serve(context);
    const errors = [];
    const a = await context.newPage();
    const b = await context.newPage();
    const c = await context.newPage();
    for (const page of [a, b, c]) page.on('pageerror', (e) => errors.push(e.message));
    watch(a, 'a'); watch(b, 'b'); watch(c, 'c');

    await a.goto(`${ORIGIN}/Podatoci.html?tab=students`);
    await a.waitForSelector('#students tr[data-student="p-ana"] .s-grade option', { state: 'attached', timeout: 8000 });

    console.log('a class that is not on the year\'s list');
    const shown = (await optionsOf(a, 'p-boj')).find((o) => o.selected) || {};
    check('stays the pupil\'s class, instead of „— без одделение —"', shown.value === 'III-стара', JSON.stringify(shown));
    check('and says it is not on the list', /неактивна/.test(shown.text || ''), shown.text);

    await b.goto(`${ORIGIN}/Podatoci.html?tab=classes`);
    await b.waitForSelector('#classes table', { timeout: 8000 });
    await c.goto(`${ORIGIN}/NastavaUredi.html`);
    await c.waitForSelector('#classes table', { state: 'attached', timeout: 8000 });
    await a.waitForTimeout(300);
    await a.evaluate(() => { window.__stayed = true; });

    console.log('\na class added in one tab');
    const aBefore = countReads('a', '/api/roster');
    const cBefore = countReads('c', '/api/teaching/timetable');
    await b.fill('#newClass', 'IV-в');
    await b.click('#addClass');
    check('is in the pupils\' class dropdown of the other tab', await offers(a, 'p-ana', 'IV-в'));
    check('which read the list again', countReads('a', '/api/roster') > aBefore,
        `roster reads by that tab: ${aBefore} → ${countReads('a', '/api/roster')}`);
    check('without the page being reloaded', await a.evaluate(() => window.__stayed === true));
    check('and the pupil kept her class', (await optionsOf(a, 'p-ana')).find((o) => o.selected)?.value === 'II-б');
    await c.waitForTimeout(400);
    check('Уреди настава read its timetable again too', countReads('c', '/api/teaching/timetable') > cBefore);

    console.log('\na tab with an unsaved row waits');
    await a.selectOption('#students tr[data-student="p-ana"] .s-kind', 'boarding');
    // Out of the select: what holds the redraw back here is the unsaved ROW.
    await a.evaluate(() => document.activeElement && document.activeElement.blur());
    const waitBefore = countReads('a', '/api/roster');
    await b.fill('#newClass', 'V-г');
    await b.click('#addClass');
    await a.waitForTimeout(2600);
    check('it does not redraw under the row', countReads('a', '/api/roster') === waitBefore,
        `roster reads: ${waitBefore} → ${countReads('a', '/api/roster')}`);
    check('the row keeps what was chosen', await a.$eval('#students tr[data-student="p-ana"] .s-kind', (s) => s.value) === 'boarding');
    const toast = await a.$eval('.mtb-toast', (n) => n.textContent).catch(() => '');
    check('and says why it waits', /друг прозорец/.test(toast), toast);
    await a.click('[data-save-student="p-ana"]');
    check('after the save it has the new class as well', await offers(a, 'p-ana', 'V-г'));
    check('and what was saved is what was chosen', db.students[0].kind === 'boarding');

    console.log('\nwhile a list is being searched');
    await a.fill('#studentSearch', 'Ана');
    const typingBefore = countReads('a', '/api/roster');
    await b.fill('#newClass', 'VII-е');
    await b.click('#addClass');
    await a.waitForTimeout(2600);
    check('nothing is redrawn under the typing', countReads('a', '/api/roster') === typingBefore);
    await a.evaluate(() => document.activeElement && document.activeElement.blur());
    check('and it catches up once the typing stops', await offers(a, 'p-ana', 'VII-е'));

    check('no page errors', errors.length === 0, errors.join('\n       '));
    await context.close();
}

// ── the workspace: a window and the shell, through the shell only ──────
{
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    // Without the channel, the only way between the shell and its frames is
    // the shell passing the change on — as for a frame of another origin.
    await context.addInitScript(() => { try { delete window.BroadcastChannel; } catch (_) { window.BroadcastChannel = undefined; } });
    await serve(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    watch(page, 'shell');
    await page.goto(`${ORIGIN}/MTB-Workspace.html`);
    await page.waitForSelector('#maList [data-ma-id="p-ana"]', { timeout: 10000 });

    console.log('\nthe workspace, with the channel taken away');
    check('the channel really is gone', await page.evaluate(() => !window.BroadcastChannel));
    console.log('a class added in the Податоци window');
    await page.click('#appTabs [data-app="Podatoci.html"]');
    const frame = page.frameLocator('#app-Podatoci iframe');
    await frame.locator('#classes table').waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    const adminBefore = countReads('shell', '/api/workspace', 'MTB-Workspace.html');
    const dirBefore = countReads('shell', '/api/roster', 'MTB-Workspace.html');
    await frame.locator('#newClass').fill('VI-д');
    await frame.locator('#addClass').click();
    await page.waitForTimeout(1600);
    check('„Администрација" read its list again', countReads('shell', '/api/workspace', 'MTB-Workspace.html') > adminBefore);
    check('„Заеднички податоци" read its list again too', countReads('shell', '/api/roster', 'MTB-Workspace.html') > dirBefore);
    await page.click('#openMasterAdmin');
    const filter = await page.$$eval('#maClass option', (os) => os.map((o) => o.value));
    check('„Администрација" offers the class in its filter', filter.includes('VI-д'), filter.join(', '));
    await page.click('#maList [data-ma-id="p-ana"]');
    const pick = await page.$$eval('#maForm select[name="grade"] option', (os) => os.map((o) => o.value));
    check('and in the pupil\'s „Паралелка / група"', pick.includes('VI-д'), pick.join(', '));

    console.log('\na pupil saved in „Администрација"');
    const frameBefore = countReads('shell', '/api/roster', 'Podatoci.html');
    // A class that was there from the start, so this part stands on its own.
    await page.selectOption('#maForm select[name="grade"]', 'I-а');
    await page.click('#maForm button[type=submit]');
    await page.getByText('Зачувано и потврдено од PostgreSQL.', { exact: true }).waitFor({ timeout: 6000 });
    check('is saved', db.students[0].grade === 'I-а');
    await page.waitForTimeout(1600);
    check('and the Податоци window read the list again', countReads('shell', '/api/roster', 'Podatoci.html') > frameBefore,
        `roster reads by the frame: ${frameBefore} → ${countReads('shell', '/api/roster', 'Podatoci.html')}`);
    check('„Администрација" did not redraw over its own „Зачувано"',
        /потврдено/.test(await page.$eval('#maStatus', (n) => n.textContent)));
    check('no page errors in the shell', errors.length === 0, errors.join('\n       '));
    await context.close();
}

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
