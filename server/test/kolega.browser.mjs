/**
 * The colleagues' page (Kolega.html) in a real browser, with the portal API
 * answered here from invented data; what the server decides is asserted
 * against a real database in portal.e2e.ts. What this proves:
 *
 *   1. The page opens on the sign-in, and a wrong password says so.
 *   2. After a sign-in with the initial password a change is OFFERED, and
 *      keeping the initial one is a real choice (the owner's decision).
 *   3. Setting one sends the change; the page then shows the person, the
 *      roles and the username in both scripts.
 *   4. The sign-in is remembered by this browser, and „Одјави се" ends it.
 *   5. It loads nothing but itself — the cloud lets only this page through.
 *
 *   node test/kolega.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3990';
const TOKEN = 'a'.repeat(64);

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

let own = false;
let signedIn = false;
const calls = [];
const loaded = [];

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 400, height: 800 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    loaded.push(url.pathname);
    if (url.pathname === '/Kolega.html') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'Kolega.html')) });
    }
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const token = req.headers()['x-mtb-portal-token'] || '';
    calls.push({ method: req.method(), path: url.pathname, body, token });
    const me = { person: { employeeId: 7, name: 'Ана Измислена' }, usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' },
        initialPassword: !own, year: '2026/2027', roles: ['teacher', 'homeroom'], teacher: { id: 3, kind: 'odd', classes: [] }, therapist: null };
    if (url.pathname === '/api/portal/login') {
        const right = body.password === (own ? 'моја1' : 'ResursenCentar');
        if (!['AnaIzmislena', 'АнаИзмислена'].includes(body.username) || !right) return json(401, { error: 'Погрешно корисничко име или лозинка.' });
        signedIn = true;
        return json(200, { token: TOKEN, person: me.person, usernames: me.usernames, initialPassword: !own });
    }
    if (url.pathname === '/api/portal/me') return signedIn && token === TOKEN ? json(200, me) : json(401, { error: 'Најавата е истечена.', signedOut: true });
    if (url.pathname === '/api/portal/password') {
        if (token !== TOKEN) return json(401, {});
        if (!(body.current === 'ResursenCentar' && !own) && !(body.current === 'моја1' && own)) return json(403, { error: 'Сегашната лозинка не е точна.' });
        own = true;
        return json(200, { ok: true });
    }
    if (url.pathname === '/api/portal/logout') { signedIn = false; return json(200, { ok: true }); }
    return json(404, { error: 'not in this test' });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const visible = (id) => page.isVisible('#' + id);

console.log('the sign-in');
await page.goto(`${ORIGIN}/Kolega.html`);
await page.waitForSelector('#login:not([hidden])', { timeout: 8000 });
check('the page opens on the sign-in', await visible('login') && !(await visible('home')));
await page.fill('#loginForm [name=username]', 'AnaIzmislena');
await page.fill('#loginForm [name=password]', 'pogresno');
await page.click('#loginForm button');
const said = await page.waitForFunction(() => /Погрешно/.test(document.getElementById('loginMsg').textContent),
    null, { timeout: 6000 }).then(() => true, () => false);
check('a wrong password says so', said, await page.textContent('#loginMsg'));

console.log('\nthe initial password: a change is offered, keeping it is a choice');
await page.fill('#loginForm [name=username]', 'АнаИзмислена');
await page.fill('#loginForm [name=password]', 'ResursenCentar');
await page.click('#loginForm button');
await page.waitForSelector('#offer:not([hidden])', { timeout: 6000 });
check('the offer greets the person', /Ана Измислена/.test(await page.textContent('#offerHello')));
await page.click('#keepInitial');
await page.waitForSelector('#home:not([hidden])', { timeout: 6000 });
check('keeping it goes straight on', await visible('home'));
check('nothing was changed', !calls.some((c) => c.path === '/api/portal/password'));
check('the page names the person', (await page.textContent('#homeName')) === 'Ана Измислена');
check('and the roles', /наставник/.test(await page.textContent('#homeRoles')) && /раководител/.test(await page.textContent('#homeRoles')));
check('and the username in both scripts', /AnaIzmislena/.test(await page.textContent('#homeUser')) && /АнаИзмислена/.test(await page.textContent('#homeUser')));

console.log('\nremembered, until „Одјави се"');
await page.reload();
await page.waitForSelector('#home:not([hidden])', { timeout: 6000 });
check('a reload keeps the sign-in', await visible('home'));
await page.click('#logout');
await page.waitForSelector('#login:not([hidden])', { timeout: 6000 });
check('„Одјави се" returns to the sign-in', await visible('login'));
check('and forgets the token', await page.evaluate(() => localStorage.getItem('mtb_portal_token_v1')) === null);

console.log('\nsetting one\'s own password');
await page.fill('#loginForm [name=username]', 'AnaIzmislena');
await page.fill('#loginForm [name=password]', 'ResursenCentar');
await page.click('#loginForm button');
await page.waitForSelector('#offer:not([hidden])', { timeout: 6000 });
await page.fill('#offerForm [name=next]', 'аб');
await page.click('#offerForm button[type=submit]');
check('a password under 4 characters is not sent', /4 знаци/.test(await page.textContent('#offerMsg')) && !calls.some((c) => c.path === '/api/portal/password'));
await page.fill('#offerForm [name=next]', 'моја1');
await page.click('#offerForm button[type=submit]');
await page.waitForSelector('#home:not([hidden])', { timeout: 6000 });
check('a good one is set', own === true);
check('and the page no longer says „почетната"', !/почетната/.test(await page.textContent('#homeUser')));

console.log('\nits own file, and nothing else');
const others = [...new Set(loaded.filter((p) => !p.startsWith('/api/portal/') && p !== '/Kolega.html'))];
check('it loads no other file', others.length === 0, others.join(', '));
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
check('it fits a phone, with no sideways scrolling', fits);
check('no page errors', errors.length === 0, errors.join('\n       '));

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
