/**
 * „Назад" and „напред" walk the views of the application instead of leaving
 * it — in a real browser, with every API call answered here from invented
 * data. Nothing is written anywhere.
 *
 * The owner, 25 Sep 2026: „на back излегувам од апликацијата, нема меморија
 * што отварав". Tabs, views and windows changed without leaving a trace in
 * the browser's history. What this proves:
 *
 *   1. Податоци: each tab chosen is a step; Back and Forward walk them, on
 *      the same page (nothing reloads), and the tab is in the address.
 *   2. Уреди настава and Настава ↔ терапии: the same for their views.
 *   3. Кабинети: the same for its panels.
 *   4. The workspace: opening a window is a step, a tab inside that window is
 *      a step of its own, and Back walks them in the order they happened —
 *      back into „Администрација" at the start, not out of the workspace.
 *   5. A reload keeps the view that is in the address.
 *
 *   node test/back-forward.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3992';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const classes = [{ id: 1, label: 'I-а', description: 'измислен опис', homeroom: null }];
const students = [{ public_id: 'p1', name: 'Ученик Измислен', grade: 'I-а', oddelenie: 'I', kind: 'internal', active: true, therapists: [] }];

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
                year: YEAR, isCurrentYear: true, students, teachers: [], therapists: [],
                classes: classes.map((c) => ({ ...c, lessons: 0, lessons_without_subject: 0, unlinked_teachers: [] })),
                candidates: { students: [], teachers: [], therapists: [], classes: [] }
            });
            if (p === '/api/categories') return json(200, { categories: [] });
            if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
            if (p === '/api/teaching/subjects') return json(200, { subjects: [] });
            if (p === '/api/teaching/timetable') return json(200, {
                year: YEAR, lessons: [], teachers: [], clashes: [], classes,
                bells: { 'nastava-am': [{ ordinal: 1, label: '1', startsAt: '08:00' }], kabinet: [] }
            });
            if (p === '/api/teaching/crossing') return json(200, {
                year: YEAR, isCurrentYear: true, cells: [], teachers: [], unplaced: [], external: [],
                bells: { teaching: [{ ordinal: 1, label: '1', startsAt: '08:00' }] },
                summary: { placed: 0, sessions: 0, unplaced: 0, external: 0, lessonsDisrupted: 0 }
            });
            if (p === '/api/schedule/sessions') return json(200, { sessions: [] });
            if (p === '/api/workspace') return json(200, {
                year: YEAR, pupils: [], employees: [], classes,
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

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
await serve(context);
const settle = (page) => page.waitForTimeout(250);
const param = (page, key) => page.evaluate((k) => new URLSearchParams(location.search).get(k), key);

// ── Податоци ────────────────────────────────────────────────────────────
{
    console.log('Податоци');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('Podatoci: ' + e.message));
    await page.goto(`${ORIGIN}/Podatoci.html?tab=students`);
    await page.waitForSelector('#students tr[data-student="p1"]', { timeout: 8000 });
    await page.evaluate(() => { window.__same = true; });
    const onTab = () => page.evaluate(() => (document.querySelector('.tab.on') || {}).id);
    await page.click('.tabs .btn[data-tab="teachers"]');
    await page.click('.tabs .btn[data-tab="classes"]');
    check('the tab is in the address', await param(page, 'tab') === 'classes');
    await page.goBack(); await settle(page);
    check('Back returns to the tab before', await onTab() === 'tab-teachers', await onTab());
    await page.goBack(); await settle(page);
    check('and to the one before that', await onTab() === 'tab-students', await onTab());
    await page.goForward(); await settle(page);
    check('Forward goes on again', await onTab() === 'tab-teachers', await onTab());
    check('all on the same page — nothing was reloaded', await page.evaluate(() => window.__same === true));
    await page.reload();
    await page.waitForSelector('.tab.on', { timeout: 8000 });
    check('a reload keeps the tab in the address', await onTab() === 'tab-teachers', await onTab());
    await page.close();
}

// ── Уреди настава ────────────────────────────────────────────────────────
{
    console.log('\nУреди настава');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('NastavaUredi: ' + e.message));
    await page.goto(`${ORIGIN}/NastavaUredi.html`);
    await page.waitForSelector('#views [data-view="teacher"]', { timeout: 8000 });
    await page.waitForTimeout(400);
    const pressed = () => page.evaluate(() => (document.querySelector('#views [aria-pressed="true"]') || {}).dataset?.view);
    await page.click('#views [data-view="teacher"]');
    await page.click('#views [data-view="assign"]');
    check('the view is in the address', await param(page, 'view') === 'assign');
    await page.goBack(); await settle(page);
    check('Back returns to the view before', await pressed() === 'teacher', await pressed());
    await page.goBack(); await settle(page);
    check('and to the first one', await pressed() === 'class', await pressed());
    await page.close();
}

// ── Настава ↔ терапии ────────────────────────────────────────────────────
{
    console.log('\nНастава ↔ терапии');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('Nastava: ' + e.message));
    await page.goto(`${ORIGIN}/Nastava.html`);
    await page.waitForSelector('#viewWeek', { timeout: 8000 });
    await page.waitForTimeout(400);
    const pressed = () => page.evaluate(() => [...document.querySelectorAll('[id^="view"][aria-pressed="true"]')].map((b) => b.id).join(','));
    await page.click('#viewWeek');
    await page.click('#viewNotice');
    await page.goBack(); await settle(page);
    check('Back returns to the week', await pressed() === 'viewWeek', await pressed());
    await page.goBack(); await settle(page);
    check('and to the class view', await pressed() === 'viewClass', await pressed());
    await page.reload();
    await page.waitForTimeout(600);
    await page.goForward(); await settle(page);
    check('Forward after a reload still knows the way', await pressed() === 'viewWeek', await pressed());
    await page.close();
}

// ── Кабинети ────────────────────────────────────────────────────────────
{
    console.log('\nКабинети');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('Fusion: ' + e.message));
    await page.goto(`${ORIGIN}/RasporediFusion.html`);
    await page.waitForSelector('.view-tab[data-panel="roster"]', { timeout: 8000 });
    await page.waitForTimeout(600);
    const panel = () => page.evaluate(() => document.body.dataset.panel);
    await page.click('.view-tab[data-panel="roster"]');
    await page.click('.view-tab[data-panel="lists"]');
    check('the panel is in the address', await param(page, 'panel') === 'lists');
    await page.goBack(); await settle(page);
    check('Back returns to the panel before', await panel() === 'roster', await panel());
    await page.goBack(); await settle(page);
    check('and to the schedule', await panel() === 'schedule', await panel());
    await page.close();
}

// ── the workspace ────────────────────────────────────────────────────────
{
    console.log('\nthe workspace');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('Workspace: ' + e.message));
    await page.goto(`${ORIGIN}/MTB-Workspace.html`);
    await page.waitForSelector('#masterAdmin:not([hidden])', { timeout: 10000 });
    const adminOpen = () => page.evaluate(() => !document.getElementById('masterAdmin').hidden);
    const podatociOpen = () => page.evaluate(() => {
        const win = document.getElementById('app-Podatoci');
        return Boolean(win && !win.hidden);
    });
    await page.click('#appTabs [data-app="Podatoci.html"]');
    const frame = page.frameLocator('#app-Podatoci iframe');
    await frame.locator('.tabs .btn[data-tab="teachers"]').waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    check('opening a window puts it in the address', await param(page, 'app') === 'Podatoci.html');
    // By path: the workspace's own address now says `app=Podatoci.html` too.
    const podatoci = () => page.frames().find((f) => new URL(f.url()).pathname.endsWith('/Podatoci.html'));
    const frameTab = () => podatoci().evaluate(() => (document.querySelector('.tab.on') || {}).id);
    check('the window opens on its own tab', await frameTab() === 'tab-classes', await frameTab());
    await frame.locator('.tabs .btn[data-tab="teachers"]').click();
    await page.waitForTimeout(200);
    check('a tab inside the window', await frameTab() === 'tab-teachers', await frameTab());
    // The browser's Back button, which walks the history of the whole window,
    // frames included. Playwright's goBack only waits for the top page.
    const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(500); };
    const forward = async () => { await page.evaluate(() => history.forward()); await page.waitForTimeout(500); };
    await back();
    check('Back first undoes the tab inside the window', await frameTab() === 'tab-classes', await frameTab());
    check('and the window stays open', await podatociOpen());
    await back();
    check('Back again returns to „Администрација", not out of the workspace',
        await adminOpen() && page.url().includes('MTB-Workspace.html'), page.url());
    await forward();
    check('Forward opens the window again', !(await adminOpen()) && await podatociOpen());
    await page.reload();
    await page.waitForTimeout(1200);
    check('a reload with the window in the address opens that window', await podatociOpen() && !(await adminOpen()));
    await page.close();
}

console.log('');
check('no page errors', errors.length === 0, errors.join('\n       '));
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
