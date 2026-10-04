/**
 * The colleagues' door under the owner's control (migration 052), in a real
 * browser with every API call answered here from invented data. What the
 * server decides is asserted against a database in portal-security.test.ts.
 * What this proves:
 *
 *   1. Kolega.html takes the code from /kolegi/<code>, keeps it on the device
 *      and sends it with every call — also from the plain address afterwards.
 *   2. Maintenance is said politely before anybody types a password, with a
 *      way through for those who may pass; a signed-in colleague is stopped
 *      WITHOUT losing the sign-in.
 *   3. A replaced link and a locked account each say what happened, readable
 *      in both themes and inside a phone's width.
 *   4. Податоци → „🔐 Безбедност" shows what the server holds and each button
 *      sends exactly one change.
 *
 *   node test/door.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3991';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const CODE = 'abcd-2345', OLD = 'wxyz-6789';
const TOKEN = 'a'.repeat(64);

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

// The invented server: one door, changed by the test and by the page's own writes.
const door = { maintenance: false, message: '', code: CODE, locked: false, also: [] };
const state = {
    maintenance: { on: false, forced: false, message: '', defaultMessage: 'Системот моментално се одржува.', changedAt: null },
    link: { code: CODE, note: null, createdAt: '2026-10-01T08:00:00Z', retiredAt: null, refused: 0, lastRefusedAt: null },
    archive: [{ code: OLD, note: 'по забрана', createdAt: '2026-09-25T08:00:00Z', retiredAt: '2026-10-01T08:00:00Z', refused: 3, lastRefusedAt: '2026-10-01T09:00:00Z' }],
    accounts: [
        { employeeId: 1, name: 'Сопственик Измислен', teacher: false, therapist: true, readOnly: false, locked: false, lockedAt: null, tester: false, owner: true, lastLoginAt: '2026-10-01T07:00:00Z', sessions: 1 },
        { employeeId: 7, name: 'Ана Измислена', teacher: true, therapist: false, readOnly: false, locked: false, lockedAt: null, tester: false, owner: false, lastLoginAt: null, sessions: 2 },
        { employeeId: 8, name: 'Бојан Измислен', teacher: true, therapist: false, readOnly: false, locked: true, lockedAt: '2026-10-01T08:30:00Z', tester: false, owner: false, lastLoginAt: null, sessions: 0 }
    ],
    log: [{ at: '2026-10-01T08:30:00Z', action: 'lock', detail: null, actor: 'Администраторот', name: 'Бојан Измислен' }]
};
const subjects = [{ subject: 'Македонски / Албански јазик', lessons: 12, teachers: 3, offered: true },
    { subject: 'Математика', lessons: 20, teachers: 4, offered: true }, { subject: 'Изборен предмет', lessons: 0, teachers: 1, offered: false }];
// Lessons with no subject (4 Oct 2026): what the server's preview says, and what a fill leaves.
const fill = { year: YEAR, current: true, empty: 7, noTeacher: 0, several: [],
    filled: [{ teacherId: 31, teacher: 'Измислена Ликовна', subject: 'Ликовно', lessons: 3, lessonIds: [501, 502, 503] }],
    homeroom: [{ teacherId: 32, teacher: 'Измислен Одделенски', lessons: 2 }],
    unlisted: [{ teacherId: 33, teacher: 'Измислена Без Предмет', lessons: 2 }] };
let fillFails = 0;
let dismissNext = false;
const calls = [];
const writes = [];

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
async function context(options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', ...options });
    await ctx.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        const p = url.pathname, h = req.headers();
        if (p.startsWith('/api/portal/')) {
            calls.push({ path: p, key: h['x-mtb-portal-key'] || '', token: h['x-mtb-portal-token'] || '' });
            if (door.code && ![door.code, ...door.also].includes(h['x-mtb-portal-key'] || '')) return json(423, { door: 'link', error: 'Линкот за колегите е променет и овој повеќе не важи.' });
            if (p === '/api/portal/door') return json(200, door.maintenance ? { ok: true, maintenance: true, message: door.message } : { ok: true, maintenance: false });
            if (p === '/api/portal/login') {
                if (door.locked) return json(423, { door: 'locked', error: 'Пристапот со оваа сметка е привремено запрен.' });
                if (door.maintenance) return json(423, { door: 'maintenance', error: door.message });
                return json(200, { token: TOKEN, person: { employeeId: 7, name: 'Ана Измислена' }, usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, initialPassword: false });
            }
            if (h['x-mtb-portal-token'] !== TOKEN) return json(401, { error: 'no', signedOut: true });
            if (door.maintenance) return json(423, { door: 'maintenance', error: door.message });
            if (p === '/api/portal/me') return json(200, { person: { employeeId: 7, name: 'Ана Измислена' }, acting: false,
                usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, initialPassword: false, year: YEAR, roles: ['teacher'], teacher: { id: 3 }, therapist: null });
            return json(404, { error: 'not in this test' });
        }
        if (p.startsWith('/api/')) {
            if (req.method() !== 'GET') writes.push({ method: req.method(), path: p, body: req.postData() ? req.postDataJSON() : null });
            if (p === '/api/health') return json(200, { ok: true });
            if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
            if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
                candidates: { students: [], teachers: [], therapists: [], classes: [] } });
            if (p === '/api/categories') return json(200, { categories: [] });
            if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
            if (p === '/api/teaching/subject-names') return json(200, { year: YEAR, subjects });
            if (p === '/api/teaching/subject-fill' && req.method() === 'GET') return json(200, fill);
            if (p === '/api/teaching/subject-fill') {
                if (fillFails) { fillFails--; return json(500, { error: 'Серверот не можеше да запише.' }); }
                Object.assign(fill, { empty: 4, filled: [] });
                return json(200, { ok: true, year: YEAR, written: 3 });
            }
            if (p === '/api/teaching/subject-rename') {
                const body = req.postDataJSON();
                subjects.find((x) => x.subject === body.from).subject = body.to;
                return json(200, { ok: true, year: YEAR, from: body.from, to: body.to, lessons: 12, teachers: 3, offered: 9 });
            }
            if (p === '/api/staff-security' && req.method() === 'GET') return json(200, { year: YEAR, ...state });
            if (p === '/api/staff-security/maintenance') {
                const body = req.postDataJSON();
                state.maintenance.on = body.on; state.maintenance.message = body.message || '';
                return json(200, { ok: true });
            }
            if (p === '/api/staff-security/accounts/7') { Object.assign(state.accounts[1], req.postDataJSON()); return json(200, { ok: true }); }
            if (p === '/api/staff-security/links/' + OLD) {
                const old = state.archive.find((l) => l.code === OLD);
                old.allowed = req.postDataJSON().allowed; old.allowedAt = old.allowed ? '2026-10-01T11:00:00Z' : null;
                return json(200, { ok: true });
            }
            if (p === '/api/staff-security/unlock-all') { state.accounts.forEach((a) => { a.locked = false; }); return json(200, { ok: true, unlocked: 1 }); }
            if (p === '/api/staff-security/link' && req.method() === 'POST') {
                state.archive.unshift({ ...state.link, retiredAt: '2026-10-01T10:00:00Z' });
                state.link = { code: 'mnpq-2468', note: req.postDataJSON().note, createdAt: '2026-10-01T10:00:00Z', retiredAt: null, refused: 0, lastRefusedAt: null };
                return json(200, { ok: true, code: 'mnpq-2468', url: '/kolegi/mnpq-2468' });
            }
            return json(404, { error: 'not in this test' });
        }
        const file = /^\/kolegi(\/[a-z0-9-]+)?$/i.test(p) ? 'Kolega.html' : decodeURIComponent(p.replace(/^\//, ''));
        const path = join(ROOT, file);
        if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
    });
    return ctx;
}

/** WCAG contrast of an element's text against the popup's box. */
const contrast = (page, selector) => page.evaluate((sel) => {
    const rgb = (v) => (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; })
        .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const node = document.querySelector(sel);
    let holder = node, bg = 'rgba(0, 0, 0, 0)';
    while (holder && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg = getComputedStyle(holder).backgroundColor)) holder = holder.parentElement;
    const a = lum(rgb(getComputedStyle(node).color)), b = lum(rgb(bg));
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}, selector);

const errors = [];

console.log('Колега: the link and its code');
let ctx = await context();
let page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('Kolega: ' + e.message));
await page.goto(`${ORIGIN}/kolegi/${CODE.toUpperCase()}`);
await page.waitForSelector('#login:not([hidden])');
await page.waitForFunction(() => true);
check('the code is taken from the address and sent with the first call', calls.length > 0 && calls.every((c) => c.key === CODE), JSON.stringify(calls));
check('no popup while the door is open', !(await page.isVisible('#doorVeil')));
await page.fill('input[name="username"]', 'AnaIzmislena');
await page.fill('input[name="password"]', 'ResursenCentar');
await page.click('#loginForm button[type="submit"]');
await page.waitForSelector('#welcome:not([hidden])');
check('sign-in works through the link', calls.some((c) => c.path === '/api/portal/login' && c.key === CODE));
calls.length = 0;
await page.goto(`${ORIGIN}/kolegi`);
await page.waitForSelector('#welcome:not([hidden])');
check('the plain address keeps working on a device that has had the link', calls.length > 0 && calls.every((c) => c.key === CODE));

console.log('\nКолега: maintenance');
door.maintenance = true; door.message = 'Се враќаме во 14 часот.';
await page.reload();
await page.waitForSelector('#doorVeil:not([hidden])');
check('a signed-in colleague is told politely, in the owner\'s words', (await page.textContent('#doorTitle')) === 'Системот се одржува'
    && (await page.textContent('#doorText')) === 'Се враќаме во 14 часот.');
check('and the sign-in is kept for when it ends', await page.evaluate((t) => localStorage.getItem('mtb_portal_token_v1') === t, TOKEN));
check('no way round is offered to somebody already stopped', !(await page.isVisible('#doorPass')));
for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const title = await contrast(page, '#doorTitle'), text = await contrast(page, '#doorText');
    check(`the message is readable in the ${theme} theme`, title >= 4.5 && text >= 4.5, `title ${title.toFixed(1)}, text ${text.toFixed(1)}`);
}
await page.setViewportSize({ width: 360, height: 740 });
check('it fits a phone', await page.evaluate(() => {
    const r = document.querySelector('.door-box').getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
}));
await page.setViewportSize({ width: 1280, height: 900 });
door.maintenance = false;
await page.click('#doorRetry');
await page.waitForSelector('#welcome:not([hidden])');
check('„Обиди се повторно" carries on once maintenance ends', !(await page.isVisible('#doorVeil')));
await ctx.close();

ctx = await context();
page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('Kolega: ' + e.message));
door.maintenance = true;
await page.goto(`${ORIGIN}/kolegi/${CODE}`);
await page.waitForSelector('#doorVeil:not([hidden])');
check('before sign-in the popup offers a way through for those who may pass', await page.isVisible('#doorPass'));
await page.click('#doorPass');
check('which leads to the sign-in form', !(await page.isVisible('#doorVeil')) && await page.isVisible('#loginForm'));
await page.fill('input[name="username"]', 'AnaIzmislena');
await page.fill('input[name="password"]', 'ResursenCentar');
await page.click('#loginForm button[type="submit"]');
await page.waitForSelector('#doorVeil:not([hidden])');
check('a colleague who may not is told again, and stays signed out', (await page.textContent('#doorTitle')) === 'Системот се одржува'
    && await page.evaluate(() => localStorage.getItem('mtb_portal_token_v1') === null));

console.log('\nКолега: a locked account, a replaced link');
door.maintenance = false; door.locked = true;
await page.reload();
await page.waitForSelector('#login:not([hidden])');
await page.fill('input[name="username"]', 'AnaIzmislena');
await page.fill('input[name="password"]', 'ResursenCentar');
await page.click('#loginForm button[type="submit"]');
await page.waitForSelector('#doorVeil:not([hidden])');
check('a locked account says so and where to turn', (await page.textContent('#doorTitle')) === 'Пристапот е запрен'
    && /запрен/.test(await page.textContent('#doorText')));
door.locked = false; door.also = [OLD];
await page.goto(`${ORIGIN}/kolegi/${OLD}`);
await page.waitForSelector('#login:not([hidden])');
check('an old link the owner allowed again opens the sign-in', !(await page.isVisible('#doorVeil')));
door.also = [];
await page.goto(`${ORIGIN}/kolegi/${OLD}`);
await page.waitForSelector('#doorVeil:not([hidden])');
check('a replaced link says the link changed', (await page.textContent('#doorTitle')) === 'Линкот е променет' && !(await page.isVisible('#doorPass')));
await ctx.close();

console.log('\nПодатоци → Безбедност');
ctx = await context();
page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('Podatoci: ' + e.message));
page.on('dialog', (d) => {
    if (dismissNext) { dismissNext = false; return d.dismiss(); }
    return d.type() === 'prompt' ? d.accept('  Македонски   јазик ') : d.accept();
});
await page.goto(`${ORIGIN}/Podatoci.html?tab=security`);
await page.waitForSelector('#securityAccounts table', { timeout: 8000 });
check('the current link, with its code', (await page.textContent('#securityLink')) === `${ORIGIN}/kolegi/${CODE}`, await page.textContent('#securityLink'));
const archive = await page.textContent('#securityArchive');
check('the archive: the old link, why, and that it was still tried', archive.includes(ORIGIN + '/kolegi/' + OLD) && archive.includes('по забрана') && /3 · последен/.test(archive), archive);
const accounts = await page.textContent('#securityAccounts');
check('each account with its state', /моја сметка/.test(accounts) && /заклучена/.test(accounts) && /влегува/.test(accounts), accounts);
check('the owner\'s account cannot be locked from here', await page.locator('[data-security-account="1"] [data-security-set="locked"]').count() === 0);
check('the record of changes', /Заклучена сметка/.test(await page.textContent('#securityLog')) && /Бојан Измислен/.test(await page.textContent('#securityLog')));
check('maintenance reads as off', /исклучено/.test(await page.textContent('#securityState')) && await page.isDisabled('#securityOff'));

await page.click('[data-security-account="7"] [data-security-set="tester"]');
await page.waitForFunction(() => /тестер/.test(document.querySelector('[data-security-account="7"]').textContent));
check('„Тестер" is one change', JSON.stringify(writes.at(-1)) === JSON.stringify({ method: 'PUT', path: '/api/staff-security/accounts/7', body: { tester: true } }), JSON.stringify(writes.at(-1)));
await page.fill('#securityMessage', 'Се враќаме во 14 часот.');
await page.click('#securityOn');
await page.waitForFunction(() => /ВКЛУЧЕНО/.test(document.getElementById('securityState').textContent));
check('„Вклучи одржување" sends the switch and the message', JSON.stringify(writes.at(-1).body) === JSON.stringify({ on: true, message: 'Се враќаме во 14 часот.' }));
check('and says how many accounts are held', /запрени сметки: 1\./.test(await page.textContent('#securityState')), await page.textContent('#securityState'));
await page.click('[data-security-account="7"] [data-security-set="locked"]');
await page.waitForFunction(() => /заклучена/.test(document.querySelector('[data-security-account="7"]').textContent));
check('„Заклучи" asks, then is one change', JSON.stringify(writes.at(-1).body) === JSON.stringify({ locked: true }));
await page.fill('#securityLinkNote', 'споделен надвор');
await page.click('#securityNewLink');
await page.waitForFunction(() => document.getElementById('securityLink').textContent.endsWith('/kolegi/mnpq-2468'));
check('„Нов линк" sends the note, shows the new link and archives the old one', writes.at(-1).path === '/api/staff-security/link'
    && writes.at(-1).body.note === 'споделен надвор' && (await page.textContent('#securityArchive')).includes('/kolegi/' + CODE));
await page.evaluate(() => { document.querySelector('#securityArchive').closest('details').open = true; });
await page.click(`[data-old-link="${OLD}"] [data-old-link-allow="true"]`);
await page.waitForFunction((code) => /важи повторно/.test(document.querySelector(`[data-old-link="${code}"]`).textContent), OLD);
check('an archived link is put back in use by hand, as one change', JSON.stringify(writes.at(-1)) === JSON.stringify({ method: 'PUT', path: '/api/staff-security/links/' + OLD, body: { allowed: true } })
    && /повторно важат: 1/.test(await page.textContent('#securityArchiveCount')), JSON.stringify(writes.at(-1)));
check('while the link to hand out stays the current one', (await page.textContent('#securityLink')).endsWith('/kolegi/mnpq-2468'));
await page.click(`[data-old-link="${OLD}"] [data-old-link-allow="false"]`);
await page.waitForFunction((code) => /запрен/.test(document.querySelector(`[data-old-link="${code}"] td:nth-child(2)`).textContent), OLD);
check('and stopped again', writes.at(-1).body.allowed === false);
await page.click('#securityUnlockAll');
await page.waitForFunction(() => document.getElementById('securityUnlockAll').disabled);
check('„Отклучи ги сите"', writes.at(-1).path === '/api/staff-security/unlock-all');
for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.body.dataset.theme = t; }, theme);
    const ratio = await contrast(page, '#securityMessage');
    check(`the message box is readable in the ${theme} theme`, ratio >= 4.5, ratio.toFixed(1));
}
if (process.env.DOOR_SHOTS) for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.body.dataset.theme = t; }, theme);
    await page.screenshot({ path: join(process.env.DOOR_SHOTS, `security-${theme}.png`), fullPage: true });
}
await page.click('.tabs [data-tab="colleagues"]');
await page.waitForFunction((want) => document.getElementById('colleaguesLink').textContent === want, `${ORIGIN}/kolegi/mnpq-2468`, { timeout: 5000 }).catch(() => {});
check('„Колеги" hands out the same link', (await page.textContent('#colleaguesLink')) === `${ORIGIN}/kolegi/mnpq-2468`, await page.textContent('#colleaguesLink'));
console.log('\nПодатоци → Предмети');
await page.click('.tabs [data-tab="subjects"]');
await page.waitForSelector('#subjectsList table');
const subjectsText = await page.textContent('#subjectsList');
check('every name in use, with where it is used', subjectsText.includes('Македонски / Албански јазик') && subjectsText.includes('само внесен рачно'), subjectsText);
await page.click('#subjectsList tr[data-subject="Македонски / Албански јазик"] [data-subject-rename]');
await page.waitForSelector('#subjectsList tr[data-subject="Македонски јазик"]');
check('„Преименувај" asks for the name, confirms, and sends one rename for the year',
    JSON.stringify(writes.at(-1)) === JSON.stringify({ method: 'POST', path: '/api/teaching/subject-rename',
        body: { year: YEAR, from: 'Македонски / Албански јазик', to: 'Македонски јазик' } }), JSON.stringify(writes.at(-1)));
const fillText = await page.textContent('#subjectsFill');
check('lessons with no subject: how many, which can be filled, and why the rest cannot',
    fillText.includes(`Часови без предмет — ${YEAR}: 7`) && fillText.includes('Измислена Ликовна · 3 × „Ликовно“')
    && /без внесен предмет/.test(fillText) && /одделенска настава/.test(fillText), fillText);
if (process.env.DOOR_SHOTS) await page.locator('#tab-subjects').screenshot({ path: join(process.env.DOOR_SHOTS, 'subjects-before.png') });
const fillWrites = () => writes.filter((w) => w.path === '/api/teaching/subject-fill').length;
dismissNext = true;
await page.click('#subjectsFillGo');
await page.waitForTimeout(300);
check('„Откажи" on the question sends nothing', fillWrites() === 0 && await page.isEnabled('#subjectsFillGo'));
fillFails = 1;
await page.click('#subjectsFillGo');
await page.waitForFunction(() => /не можеше да запише/.test(document.getElementById('status').textContent), null, { timeout: 5000 }).catch(() => {});
check('a failed request says so, and the button is there to try again',
    fillWrites() === 1 && /не можеше да запише/.test(await page.textContent('#status')) && await page.isEnabled('#subjectsFillGo'),
    await page.textContent('#status'));
await page.click('#subjectsFillGo');
await page.waitForFunction(() => !document.getElementById('subjectsFillGo'));
const shownLessons = [501, 502, 503].map((id) => ({ id, subject: 'Ликовно' }));
check('the retry sends exactly the lessons it showed, each with its subject, for the year',
    JSON.stringify(writes.at(-1)) === JSON.stringify({ method: 'POST', path: '/api/teaching/subject-fill', body: { year: YEAR, lessons: shownLessons } }), JSON.stringify(writes.at(-1)));
check('and the box reads again', (await page.textContent('#subjectsFill')).includes(': 4'));
for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.body.dataset.theme = t; }, theme);
    const ratio = await contrast(page, '#subjectsFill p');
    check(`the box is readable in the ${theme} theme`, ratio >= 4.5, ratio.toFixed(1));
    if (process.env.DOOR_SHOTS) await page.locator('#tab-subjects').screenshot({ path: join(process.env.DOOR_SHOTS, `subjects-${theme}.png`) });
}
await page.click('#subjectsFill [data-goto-teacher="33"]');
check('a name opens „Наставници"', await page.isVisible('#tab-teachers'));
check('no page errors', errors.length === 0, errors.join('\n       '));

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
