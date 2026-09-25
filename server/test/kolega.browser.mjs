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
check('under a neutral title that names no system', (await page.title()) === 'Најава' && !/МТБ|MTB/i.test(await page.title()), await page.title());
check('and a preview for messaging apps that says the same',
    await page.evaluate(() => document.querySelector('meta[property="og:title"]').content === 'Распоред'
        && document.querySelector('meta[name="robots"]').content.includes('noindex')));
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
check('and the tab reads „Мој распоред"', (await page.title()) === 'Мој распоред', await page.title());
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
// One question outside /api/portal/ is on purpose: `/api/duty` asks whether
// this is the administrator. Behind the cloud's Google gate only the owner's
// own sign-in gets an answer; anybody else gets the gate's 401.
const others = [...new Set(loaded.filter((p) => !p.startsWith('/api/portal/') && p !== '/Kolega.html' && p !== '/api/duty'))];
check('it loads no other file', others.length === 0, others.join(', '));
const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
check('it fits a phone, with no sideways scrolling', fits);
check('no page errors', errors.length === 0, errors.join('\n       '));

// ── the week: a clash said before saving, „сепак", notices, a homeroom's class ──
{
    console.log('\nthe week');
    const DAYS = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
    const lessons = [
        { id: 1, day: 'понеделник', ordinal: 2, classId: 1, class: 'II-б', subject: 'Физичко', teacherId: 9, teacher: 'Колега Бе' },
        { id: 2, day: 'понеделник', ordinal: 3, classId: 1, class: 'II-б', subject: 'Математика', teacherId: 9, teacher: 'Колега Бе' },
        { id: 3, day: 'понеделник', ordinal: 3, classId: 1, class: 'II-б', subject: 'Музичко', teacherId: 8, teacher: 'Колега Це' }
    ];
    const notices = [{ id: 11, createdAt: '2026-09-25T08:00:00Z', author: 'Колега Бе', kind: 'lesson', day: 'понеделник', slot: '3',
        about: 'class:II-б', sentence: 'Колега Бе запиша „Математика" во вашата паралелка II-б.', seen: false, open: true }];
    const writes = [];
    let nextId = 100;
    const ctx = await browser.newContext({ viewport: { width: 400, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mtb_portal_token_v1', t); } catch (_) { /* test */ } }, TOKEN);
    await ctx.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        if (url.pathname === '/Kolega.html') {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'Kolega.html')) });
        }
        const body = req.postData() ? JSON.parse(req.postData()) : null;
        if (body) writes.push({ path: url.pathname, body });
        if (url.pathname === '/api/portal/me') return json(200, { person: { employeeId: 7, name: 'Ана Измислена' },
            usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, initialPassword: false, year: '2026/2027',
            roles: ['teacher', 'homeroom'], teacher: { id: 3 }, therapist: null });
        if (url.pathname === '/api/portal/week') return json(200, {
            year: '2026/2027', days: DAYS,
            periods: [1, 2, 3, 4].map((n) => ({ ordinal: n, label: String(n), startsAt: `0${7 + n}:00` })),
            me: { teacherId: 3, therapistId: null, homeroom: ['II-б'], subject: 'Математика' },
            classes: [{ label: 'I-а', description: 'опис', homeroom: 'Колега Це' }, { label: 'II-б', description: 'Комбинирана', homeroom: 'Ана Измислена' }],
            teachers: [{ id: 3, name: 'Ана Измислена' }, { id: 8, name: 'Колега Це' }, { id: 9, name: 'Колега Бе' }],
            lessons, clashes: [], notices,
            classPupils: { 'II-б': [{ name: 'ДЕТЕ ИЗМИСЛЕНО ПРВО', oddelenie: 'II' }, { name: 'Дете Измислено Второ', oddelenie: 'III' }] }
        });
        if (url.pathname === '/api/portal/subjects') return json(200, { subjects: ['Математика', 'Физичко', 'Музичко'] });
        if (url.pathname === '/api/portal/my-lesson') {
            if (body.class === 'II-б' && body.ordinal === 2 && body.subject !== 'Физичко' && !body.force) {
                return json(409, { clash: true, error: 'понеделник, 2. час: Во тој час II-б веќе има „Физичко" кај Колега Бе.', clashes: [] });
            }
            lessons.push({ id: nextId++, day: body.day, ordinal: body.ordinal, classId: 1, class: body.class, subject: body.subject, teacherId: 3, teacher: 'Ана Измислена' });
            return json(200, { ok: true, action: 'inserted', notified: body.force ? 2 : 0 });
        }
        if (url.pathname === '/api/portal/notices/seen') { notices.forEach((n) => { if (body.ids.includes(n.id)) n.seen = true; }); return json(200, { ok: true }); }
        if (url.pathname === '/api/portal/class-lesson/remove') {
            if (!body.force) return json(409, { clash: true, error: 'Во тој час II-б има „Математика" кај Колега Бе — ќе се смени.' });
            lessons.splice(lessons.findIndex((l) => l.id === body.lessonId), 1);
            return json(200, { ok: true, notified: 1 });
        }
        return json(404, { error: 'not in this test' });
    });
    const p = await ctx.newPage();
    const weekErrors = [];
    p.on('pageerror', (e) => weekErrors.push(e.message));
    p.on('dialog', (d) => d.accept());
    await p.goto(`${ORIGIN}/Kolega.html`);
    await p.waitForSelector('#days [data-day="понеделник"]', { timeout: 8000 });
    await p.click('#days [data-day="понеделник"]');
    check('the week opens on the person\'s own lessons, a day at a time', await p.isVisible('#periods [data-ordinal="2"]'));
    check('with the class tab beside it', /Паралелка II-б/.test(await p.textContent('#tabs')));
    await p.click('#periods [data-ordinal="2"] [data-edit]');
    await p.waitForSelector('#periods form.editor select[name=klass]');
    await p.selectOption('#periods form.editor select[name=klass]', 'II-б');
    await p.waitForTimeout(150);
    await p.selectOption('#periods form.editor select[name=subject]', 'Математика');
    const warned = await p.textContent('#periods form.editor .preview');
    check('before saving it already says whose lesson is there', /Физичко/.test(warned) && /Колега Бе/.test(warned), warned);
    check('and the class reads with its teacher and words', /II-б · Ана Измислена · Комбинирана/.test(await p.textContent('#periods form.editor select[name=klass]')));
    await p.click('#periods form.editor button[type=submit]');
    await p.waitForSelector('#periods form.editor .ask:not([hidden])', { timeout: 5000 });
    check('saving asks: „Сепак запиши" or another period', /Сепак запиши/.test(await p.textContent('#periods form.editor .ask')));
    check('and nothing was saved yet', lessons.length === 3);
    await p.click('#periods form.editor [data-act="force"]');
    await p.waitForFunction(() => /Известени колеги: 2/.test(document.getElementById('weekMsg').textContent), null, { timeout: 5000 });
    check('„Сепак" saves it and says who was told', writes.some((w) => w.path === '/api/portal/my-lesson' && w.body.force === true));
    check('the period now shows the clash', /Физичко/.test(await p.textContent('#periods [data-ordinal="2"]'))
        && await p.getAttribute('#periods [data-ordinal="2"]', 'class') === 'period clash');

    console.log('\nthe class, as the school knows it');
    const chip = '#periods [data-ordinal="2"] .klass[data-klass="II-б"]';
    await p.hover(chip);
    await p.waitForSelector('#classCard:not([hidden])', { timeout: 3000 });
    const shown = await p.textContent('#classCard');
    check('resting the mouse on the class shows its card', /II-б — Комбинирана/.test(shown) && /Раководител: Ана Измислена/.test(shown), shown);
    check('with who teaches it what', /Колега Бе \(/.test(shown) && /Физичко/.test(shown), shown);
    check('and the children, with their generation, a name in capitals read as a name',
        /2 ученици · одд\. II \(1\), III \(1\)/.test(shown) && /Дете Измислено Прво — II/.test(shown) && /Дете Измислено Второ — III/.test(shown), shown);
    await p.mouse.move(5, 5);
    await p.waitForTimeout(150);
    check('moving away hides it', await p.isHidden('#classCard'));
    await p.evaluate((sel) => {
        document.querySelector(sel).dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    }, chip);
    await p.waitForTimeout(600);
    check('a finger held on it shows it too', await p.isVisible('#classCard'));
    await p.evaluate((sel) => {
        document.querySelector(sel).dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    }, chip);
    await p.keyboard.press('Escape');
    check('and Esc hides it', await p.isHidden('#classCard'));
    await p.focus(chip);
    await p.keyboard.press('Enter');
    check('the keyboard reaches it: Enter on the class shows it', await p.isVisible('#classCard'));
    await p.keyboard.press('Escape');

    console.log('\nnotices, and a homeroom teacher\'s class');
    check('an unseen notice is counted', (await p.textContent('#unseenCount')).trim() === '1');
    await p.click('#openNotices');
    await p.waitForTimeout(200);
    check('opening them shows the sentence', /вашата паралелка II-б/.test(await p.textContent('#noticesList')));
    check('and marks them seen', writes.some((w) => w.path === '/api/portal/notices/seen' && w.body.ids.includes(11)));
    await p.click('#tabs [data-tab="class:II-б"]');
    await p.click('#days [data-day="понеделник"]');
    const cell = await p.textContent('#periods [data-ordinal="3"]');
    check('the class shows the period with two lessons as a clash', /Математика/.test(cell) && /Музичко/.test(cell) && /⚠/.test(cell), cell);
    await p.click('#periods [data-ordinal="3"] [data-remove="2"]');
    await p.waitForFunction(() => /тргнат/.test(document.getElementById('weekMsg').textContent), null, { timeout: 5000 });
    check('taking one out asks, then does it and tells that teacher', writes.filter((w) => w.path === '/api/portal/class-lesson/remove').length === 2
        && !lessons.some((l) => l.id === 2));
    check('the week fits a phone', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check('no page errors in the week', weekErrors.length === 0, weekErrors.join('\n       '));
    await ctx.close();
}

// ── the cabinet: a pupil with another therapist is said before saving ──────
{
    console.log('\nthe cabinet');
    const terms = [];
    const writes = [];
    const ctx = await browser.newContext({ viewport: { width: 400, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mtb_portal_token_v1', t); } catch (_) { /* test */ } }, TOKEN);
    await ctx.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        if (url.pathname === '/Kolega.html') {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'Kolega.html')) });
        }
        const body = req.postData() ? JSON.parse(req.postData()) : null;
        if (body) writes.push({ path: url.pathname, body });
        if (url.pathname === '/api/portal/me') return json(200, { person: { employeeId: 8, name: 'Терапевтка Измислена' },
            usernames: { latin: 'TerapevtkaIzmislena', cyrillic: 'ТерапевткаИзмислена' }, initialPassword: false, year: '2026/2027',
            roles: ['therapist'], teacher: null, therapist: { id: 5 } });
        if (url.pathname === '/api/portal/week') return json(200, {
            year: '2026/2027', days: ['понеделник', 'вторник', 'среда', 'четврток', 'петок'], periods: [],
            me: { teacherId: null, therapistId: 5, homeroom: [], subject: null }, classes: [], teachers: [], lessons: [], clashes: [], notices: [],
            cabinet: {
                bells: [{ ordinal: 1, label: '1', time: '08:00-08:40' }, { ordinal: 2, label: '2', time: '08:45-09:25' }],
                pupils: [{ publicId: 'p1', name: 'Ученик Измислен', class: 'II-б' }, { publicId: 'p2', name: 'Ученичка Измислена', class: 'I-а' }],
                terms, names: {},
                elsewhere: [{ publicId: 'p1', day: 'понеделник', time: '08:00-08:40', therapist: 'Колега Ди' }]
            }
        });
        if (url.pathname === '/api/portal/term') {
            if (body.pupils.includes('p1') && body.time === '08:00-08:40' && !body.force) {
                return json(409, { clash: true, error: 'понеделник, 08:00-08:40: „Ученик Измислен" тогаш е кај Колега Ди (08:00-08:40).' });
            }
            const i = terms.findIndex((t) => t.day === body.day && t.time === body.time);
            if (i >= 0) terms.splice(i, 1);
            if (body.pupils.length) terms.push({ day: body.day, time: body.time, pupils: body.pupils, overlap: false });
            return json(200, { ok: true, notified: body.force ? 1 : 0 });
        }
        return json(404, { error: 'not in this test' });
    });
    const p = await ctx.newPage();
    const cabErrors = [];
    p.on('pageerror', (e) => cabErrors.push(e.message));
    await p.goto(`${ORIGIN}/Kolega.html`);
    await p.waitForSelector('#days [data-day="понеделник"]', { timeout: 8000 });
    await p.click('#days [data-day="понеделник"]');
    check('a therapist opens on their cabinet, the 40-minute terms', await p.isVisible('#periods [data-time="08:00-08:40"]'));
    await p.click('#periods [data-time="08:00-08:40"] [data-edit-term]');
    await p.selectOption('#periods form.editor select[name=first]', 'p1');
    const warned = await p.textContent('#periods form.editor .preview');
    check('choosing a pupil who is with another therapist then says so before saving', /Колега Ди/.test(warned), warned);
    await p.click('#periods form.editor button[type=submit]');
    await p.waitForSelector('#periods form.editor .ask:not([hidden])', { timeout: 5000 });
    await p.click('#periods form.editor [data-act="force"]');
    await p.waitForFunction(() => /Известени колеги: 1/.test(document.getElementById('weekMsg').textContent), null, { timeout: 5000 });
    check('„Сепак" books them and says who was told', writes.some((w) => w.path === '/api/portal/term' && w.body.force === true));
    const booked = await p.textContent('#periods [data-time="08:00-08:40"]');
    check('the term shows the pupil for 40 minutes, and the clash', /Ученик Измислен/.test(booked) && /40 мин/.test(booked) && /Колега Ди/.test(booked), booked);
    check('and the clash is listed on its own', /Колега Ди/.test(await p.textContent('#clashesList')));
    await p.click('#periods [data-time="08:45-09:25"] [data-edit-term]');
    await p.selectOption('#periods form.editor select[name=first]', 'p1');
    await p.selectOption('#periods form.editor select[name=second]', 'p2');
    await p.click('#periods form.editor button[type=submit]');
    await p.waitForFunction(() => /втори 20/.test((document.querySelector('#periods [data-time="08:45-09:25"]') || {}).textContent || ''),
        null, { timeout: 5000 }).catch(() => {});
    const halves = await p.textContent('#periods [data-time="08:45-09:25"]');
    check('two pupils share a term in halves', /први 20/.test(halves) && /втори 20/.test(halves), halves);
    check('no page errors in the cabinet', cabErrors.length === 0, cabErrors.join('\n       '));
    await ctx.close();
}

// ── дежурства: the month, one's own „не сум тука", and the owner's controls ──
{
    console.log('\nдежурства — a colleague on the list');
    const people = { 7: 'Ана Измислена', 8: 'Вера Измислена', 9: 'Горан Измислен' };
    const day = (date, weekday, id, extra = {}) => ({ date, weekday, closed: false, note: '', how: 'rotation',
        employeeId: id, name: id ? people[id] : null, number: id ? [7, 8, 9].indexOf(id) + 1 : null, covers: [], absent: [], ...extra });
    const month = () => ({
        month: '2026-10', startsOn: '2026-09-01', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: [7, 8, 9].map((id, i) => ({ employeeId: id, name: people[id], position: i + 1, joinedOn: null, leftOn: null })),
        days: [day('2026-10-01', 4, 7), day('2026-10-02', 5, 8, { how: 'cover', note: 'боледување',
                covers: [{ employeeId: 9, name: people[9] }], absent: [{ employeeId: 9, name: people[9] }] }),
            day('2026-10-05', 1, 9), day('2026-10-06', 2, 7),
            day('2026-10-07', 3, null, { closed: true, note: 'излет', how: 'closed' })]
    });
    const CANDIDATES = [
        { employeeId: 7, name: people[7], cabinet: true }, { employeeId: 8, name: people[8], cabinet: true },
        { employeeId: 9, name: people[9], cabinet: true }, { employeeId: 11, name: 'Дана Измислена', cabinet: true },
        { employeeId: 10, name: 'Нова Измислена', cabinet: false }, { employeeId: 12, name: 'Ана Измислена', cabinet: false }
    ];
    const run = async (owner, fresh = false) => {
        const writes = [];
        const ownerWrites = [];
        const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, serviceWorkers: 'block' });
        await ctx.addInitScript((t) => localStorage.setItem('mtb_portal_token_v1', t), TOKEN);
        await ctx.route('**/*', async (route) => {
            const req = route.request(), url = new URL(req.url());
            const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
            if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
            if (url.pathname === '/Kolega.html') {
                return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'Kolega.html')) });
            }
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            if (url.pathname === '/api/portal/me') return json(200, { person: { employeeId: 7, name: people[7] },
                usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, initialPassword: false, year: '2026/2027',
                roles: ['therapist'], teacher: null, therapist: { id: 4 }, duty: true });
            if (url.pathname === '/api/portal/week') return json(200, { year: '2026/2027', days: ['понеделник', 'вторник', 'среда', 'четврток', 'петок'],
                periods: [], me: { teacherId: null, therapistId: 4, homeroom: [] }, classes: [], teachers: [], lessons: [], classPupils: {},
                clashes: [], cabinet: { bells: [], terms: [], pupils: [] }, notices: [] });
            if (url.pathname === '/api/portal/duty') return json(200, { year: '2026/2027', me: 7, today: '2026-10-02', ...month() });
            if (url.pathname === '/api/portal/duty/absence') { writes.push(body); return json(200, { ok: true }); }
            if (url.pathname === '/api/duty') {
                if (!owner) return json(401, { error: 'Authentication required' });
                return json(200, { year: '2026/2027', ...month(), ...(fresh ? { members: [] } : {}), candidates: CANDIDATES });
            }
            if (url.pathname.startsWith('/api/duty/')) { ownerWrites.push({ path: url.pathname, body }); return json(200, { ok: true }); }
            return json(404, { error: 'not in this test' });
        });
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(String(e)));
        await p.goto(`${ORIGIN}/Kolega.html`);
        await p.waitForSelector('#tabs [data-tab="duty"]', { timeout: 6000 }).catch(() => {});
        return { ctx, p, errs, writes, ownerWrites };
    };

    const c = await run(false);
    check('the duty tab is there for somebody on the list', await c.p.isVisible('#tabs [data-tab="duty"]'));
    await c.p.click('#tabs [data-tab="duty"]');
    await c.p.waitForSelector('#duty table.duty-table', { timeout: 6000 });
    check('the days gone by are folded away', await c.p.isHidden('#duty tr[data-date="2026-10-01"]')
        && await c.p.isVisible('#duty tr[data-date="2026-10-02"]'));
    await c.p.click('#duty [data-duty-past]');
    check('and open when asked', await c.p.isVisible('#duty tr[data-date="2026-10-01"]'));
    const rows = await c.p.$$eval('#duty tbody tr[data-date]', (trs) => trs.map((tr) => ({ cls: tr.className,
        text: tr.innerText.replace(/\s+/g, ' ').trim(), away: Boolean(tr.querySelector('[data-duty-away]')) })));
    check('the month reads number, person, day', /^1 Ана Измислена чт 01\.10\.2026/.test(rows[0].text), rows[0].text);
    check('their own days are marked', rows[0].cls.includes('mine') && rows[3].cls.includes('mine'), JSON.stringify(rows.map((r) => r.cls)));
    check('a closed day says why', /без дежурство: излет/.test(rows[4].text), rows[4].text);
    check('a skipped day says whom it was instead of, and why — and not twice',
        /наместо Горан Измислен — боледување/.test(rows[1].text) && !/отсутни/.test(rows[1].text), rows[1].text);
    check('a day gone by offers nothing to mark', rows[0].away === false);
    check('today and later offer „Не сум тука"', rows[1].away && rows[2].away);
    check('there are no owner\'s controls', !(await c.p.$('#duty .duty-admin')) && !(await c.p.$('#duty [data-duty-open]')));
    await c.p.click('#duty tr[data-date="2026-10-05"] [data-duty-away]');
    await c.p.waitForTimeout(400);
    check('„Не сум тука" sends only the day and the mark — never whose',
        JSON.stringify(c.writes) === JSON.stringify([{ date: '2026-10-05', absent: true }]), JSON.stringify(c.writes));
    check('it fits a phone', await c.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await c.p.emulateMedia({ media: 'print' });
    await c.p.evaluate(() => document.body.classList.add('printing-duty'));
    const printed = await c.p.evaluate(() => ({
        duty: getComputedStyle(document.getElementById('duty')).display !== 'none',
        header: getComputedStyle(document.querySelector('header.top')).display === 'none',
        buttons: [...document.querySelectorAll('#duty .no-print')].every((n) => getComputedStyle(n).display === 'none')
    }));
    check('printed: only the month, without the buttons', printed.duty && printed.header && printed.buttons, JSON.stringify(printed));
    check('no page errors on the duty tab', c.errs.length === 0, c.errs.join('\n       '));
    await c.ctx.close();

    console.log('\nдежурства — the administrator');
    const o = await run(true);
    await o.p.click('#tabs [data-tab="duty"]');
    await o.p.waitForSelector('#duty .duty-admin', { timeout: 6000 });
    check('the owner gets the list and every day\'s controls', await o.p.$$eval('#duty [data-duty-open]', (b) => b.length) === 5);
    await o.p.click('#duty tr[data-date="2026-10-06"] [data-duty-open]');
    await o.p.check('#duty form[data-duty-day="2026-10-06"] input[name="closed"]');
    await o.p.fill('#duty form[data-duty-day="2026-10-06"] input[name="note"]', 'празник');
    await o.p.check('#duty form[data-duty-day="2026-10-06"] input[name="away"][value="8"]');
    await o.p.click('#duty form[data-duty-day="2026-10-06"] button[type="submit"]');
    await o.p.waitForTimeout(500);
    const dayWrite = o.ownerWrites.find((w) => w.path === '/api/duty/day');
    check('a day is closed with its reason', dayWrite && dayWrite.body.closed === true && dayWrite.body.note === 'празник', JSON.stringify(dayWrite));
    check('and somebody marked away on it', o.ownerWrites.some((w) => w.path === '/api/duty/absence'
        && w.body.employeeId === 8 && w.body.absent === true), JSON.stringify(o.ownerWrites));
    await o.p.evaluate(() => { document.querySelector('#duty .duty-admin').open = true; });
    check('the cabinets are ticked on their own line, the rest folded away',
        await o.p.isChecked('#duty [data-duty-tick="7"]') && !(await o.p.isChecked('#duty [data-duty-tick="11"]'))
        && !(await o.p.isVisible('#duty [data-duty-tick="10"]')));
    await o.p.click('#duty .duty-others summary');
    await o.p.check('#duty [data-duty-tick="10"]');
    await o.p.uncheck('#duty [data-duty-tick="8"]');
    check('somebody unticked no longer figures in the list',
        JSON.stringify(await o.p.$$eval('#dutyList .nm', (n) => n.map((x) => x.firstChild.textContent.trim())))
        === JSON.stringify(['Ана Измислена', 'Горан Измислен', 'Нова Измислена']));
    check('nor in the text of the order', !/Вера/.test(await o.p.inputValue('#dutyPaste')));
    await o.p.focus('#duty [data-duty-grip="3"]');
    await o.p.keyboard.press('ArrowUp');
    check('an arrow on ⠿ moves the row, and keeps the focus there',
        await o.p.evaluate(() => document.activeElement && document.activeElement.dataset.dutyGrip === '3'));
    await o.p.click('#dutySave');
    await o.p.waitForTimeout(500);
    const setup = o.ownerWrites.find((w) => w.path === '/api/duty/setup');
    check('the list is saved in its new order',
        setup && JSON.stringify(setup.body.members.map((m) => m.employeeId)) === JSON.stringify([7, 8, 10, 9]), JSON.stringify(setup && setup.body));
    check('and somebody added to a running rotation joins from today, not from the start',
        setup && setup.body.members.find((m) => m.employeeId === 10).joinedOn !== null);
    check('and the one unticked leaves from today, keeping the months before',
        setup && setup.body.members.find((m) => m.employeeId === 8).leftOn !== null);
    check('the list folds away once saved', !(await o.p.$eval('#duty .duty-admin', (d) => d.open)));
    check('no page errors for the owner', o.errs.length === 0, o.errs.join('\n       '));
    await o.ctx.close();

    console.log('\nдежурства — a list never saved, and one pasted from paper');
    const f = await run(true, true);
    await f.p.click('#tabs [data-tab="duty"]');
    await f.p.waitForSelector('#duty .duty-admin[open]', { timeout: 6000 });
    const ticked = await f.p.$$eval('#duty [data-duty-tick]', (n) => n.filter((x) => x.checked).map((x) => Number(x.dataset.dutyTick)));
    check('it opens with exactly the cabinets ticked, and says it is only a proposal',
        JSON.stringify(ticked) === JSON.stringify([7, 8, 9, 11]) && /Предлог/.test(await f.p.textContent('#duty .duty-admin')), JSON.stringify(ticked));
    await f.p.uncheck('#duty [data-duty-tick="9"]');
    check('unticking takes somebody off', await f.p.$$eval('#dutyList li', (li) => li.length) === 3);
    await f.p.click('#duty .duty-paste summary');
    await f.p.fill('#dutyPaste', 'Стручен соработник\tДен\nДана Измислена\t21.09.2026\nизмислена вера  22.09.2026\nПсихолог 23.09.2026\nАна Измислена 24.09.2026\nГоран   Измислен 25.09.2026');
    await f.p.click('#dutyPasteBtn');
    const said = await f.p.textContent('#weekMsg');
    check('„Ана Измислена" is two people here, so it is reported, not picked', /Ана Измислена" може да е повеќе луѓе/.test(said), said);
    check('and a line that is nobody is reported', /Психолог" не е меѓу вработените/.test(said) && /Стручен соработник/.test(said), said);
    check('the start is the paper\'s first day', await f.p.inputValue('#dutyStart') === '2026-09-21');
    const lastGrip = (await f.p.$$('#dutyList [data-duty-grip]')).pop();
    const firstRow = await f.p.$('#dutyList li');
    const g = await lastGrip.boundingBox(), top = await firstRow.boundingBox();
    await f.p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await f.p.mouse.down();
    await f.p.mouse.move(g.x + g.width / 2, top.y + 4, { steps: 8 });
    await f.p.mouse.up();
    check('dragging ⠿ moves a row to where it is let go',
        JSON.stringify(await f.p.$$eval('#dutyList .nm', (n) => n.map((x) => x.textContent.trim())))
        === JSON.stringify(['Горан Измислен', 'Дана Измислена', 'Вера Измислена']));
    await f.p.click('#dutySave');
    await f.p.waitForTimeout(500);
    const pasted = f.ownerWrites.find((w) => w.path === '/api/duty/setup');
    check('saved in the order, surname first or not, from the paper\'s first day',
        pasted && JSON.stringify(pasted.body.members.map((m) => m.employeeId)) === JSON.stringify([9, 11, 8]) && pasted.body.startsOn === '2026-09-21'
        && pasted.body.members.every((m) => m.joinedOn === null), JSON.stringify(pasted && pasted.body));
    check('no page errors on a fresh list', f.errs.length === 0, f.errs.join('\n       '));
    await f.ctx.close();
}

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
