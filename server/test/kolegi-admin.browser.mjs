/**
 * Податоци → „👥 Колеги", and the administrator's look at a colleague's form,
 * in a real browser with every API call answered here from invented data.
 * What the server decides is asserted against a real database in
 * portal-week.e2e.ts. What this proves:
 *
 *   1. The tab shows the link to hand out, the clashes standing now, the
 *      notices with their state, and every account with its username.
 *   2. „Врати почетна лозинка" asks first, then resets.
 *   3. „Отвори го формуларот" opens that colleague's form in a new tab, as the
 *      administrator's look: the banner says so, the password and sign-out are
 *      not offered, and the look is taken out of the address at once.
 *
 *   node test/kolegi-admin.browser.mjs
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
const LOOK = 'b'.repeat(64);

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const writes = [];
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') writes.push({ method: req.method(), path: p, token: req.headers()['x-mtb-portal-token'] || '' });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/categories') return json(200, { categories: [] });
        if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
        if (p === '/api/staff-accounts') return json(200, { year: YEAR, accounts: [
            { employeeId: 7, name: 'Ана Измислена', usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, teacher: true, therapist: false,
              ownPassword: true, lastLoginAt: '2026-09-25T07:00:00Z', ambiguous: false },
            { employeeId: 8, name: 'Двојно Име', usernames: { latin: 'DvojnoIme', cyrillic: 'ДвојноИме' }, teacher: false, therapist: true,
              ownPassword: false, lastLoginAt: null, ambiguous: true }
        ] });
        if (p === '/api/staff-notices') return json(200, { year: YEAR,
            notices: [{ id: 1, createdAt: '2026-09-25T08:00:00Z', recipient: 'Ана Измислена', author: 'Колега Бе', kind: 'lesson', day: 'понеделник',
                slot: '2', about: 'class:II-б', sentence: 'Колега Бе запиша „Физичко" во II-б, понеделник, 2. час.', seen: false, open: true }],
            teaching: [{ day: 'понеделник', ordinal: 2, class: 'II-б', who: ['Ана Измислена („Математика")', 'Колега Бе („Физичко")'] }],
            cabinet: [] });
        if (p === '/api/staff-accounts/7/reset') return json(200, { ok: true });
        if (p === '/api/staff-accounts/7/open') return json(200, { url: '/Kolega.html#as=' + LOOK, name: 'Ана Измислена', hours: 2 });
        if (p === '/api/portal/me') return req.headers()['x-mtb-portal-token'] === LOOK
            ? json(200, { person: { employeeId: 7, name: 'Ана Измислена' }, acting: true, usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' },
                initialPassword: false, year: YEAR, roles: ['teacher'], teacher: { id: 3 }, therapist: null })
            : json(401, { error: 'no' });
        if (p === '/api/portal/week') return json(200, { year: YEAR, days: ['понеделник'], periods: [{ ordinal: 1, label: '1', startsAt: '08:00' }],
            me: { teacherId: 3, therapistId: null, homeroom: [], subject: null }, classes: [], teachers: [], lessons: [], clashes: [], notices: [], cabinet: null });
        return json(404, { error: 'not in this test' });
    }
    const file = decodeURIComponent(p.replace(/^\//, ''));
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('Podatoci: ' + e.message));
page.on('dialog', (d) => d.accept());

console.log('Податоци → Колеги');
await page.goto(`${ORIGIN}/Podatoci.html?tab=colleagues`);
await page.waitForSelector('#colleaguesAccounts table', { timeout: 8000 });
check('the link to hand out', (await page.textContent('#colleaguesLink')) === `${ORIGIN}/kolegi`, await page.textContent('#colleaguesLink'));
check('the clashes standing now', /Колега Бе/.test(await page.textContent('#colleaguesClashes')));
const noticesText = await page.textContent('#colleaguesNotices');
check('the notices, to whom and whether still open', /Ана Измислена/.test(noticesText) && /отворено/.test(noticesText), noticesText);
const accountsText = await page.textContent('#colleaguesAccounts');
check('every account with its username in both scripts', /AnaIzmislena/.test(accountsText) && /АнаИзмислена/.test(accountsText));
check('and which still use the initial password', /почетна/.test(accountsText) && /своја/.test(accountsText));
check('a name two people share is marked', /исто име/.test(accountsText));
await page.click('[data-reset-colleague="7"]');
await page.waitForTimeout(300);
check('„Врати почетна лозинка" asks, then resets', writes.some((w) => w.path === '/api/staff-accounts/7/reset'));

console.log('\nthe administrator\'s look');
const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('[data-open-colleague="7"]')
]);
popup.on('pageerror', (e) => errors.push('Kolega: ' + e.message));
await popup.waitForSelector('#home:not([hidden])', { timeout: 8000 });
check('it opens that colleague\'s form in a new tab', (await popup.textContent('#homeName')) === 'Ана Измислена');
check('the banner says it is the administrator\'s look', await popup.isVisible('#actingBanner'));
check('no password change and no sign-out are offered', !(await popup.isVisible('#openPassword')) && !(await popup.isVisible('#logout')));
check('the look is taken out of the address at once', !popup.url().includes(LOOK), popup.url());
check('and stays in that tab only', await popup.evaluate((t) => sessionStorage.getItem('mtb_portal_acting_v1') === t
    && localStorage.getItem('mtb_portal_token_v1') === null, LOOK));
check('no page errors', errors.length === 0, errors.join('\n       '));

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
