/** Shared application navigation, in every work screen and at phone width. */
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
// The bar's own list, in its order. `NastavaUredi.html` moved up here the day
// it became a tab; leaving it under TOOLS made ten assertions fail for a
// change that was deliberate, which is the shape of a stale expectation rather
// than a fault — and a suite that is red for a reason nobody acts on stops
// being read at all.
const APPS = [
    ['S-Dnevnik.html', 'S-Дневник'],
    ['RasporediFusion.html', 'Кабинети'],
    ['Nastava.html', 'Настава ↔ терапии'],
    ['NastavaUredi.html', 'Уреди настава'],
    ['Podatoci.html', 'Списоци и пристап'],
    ['AkciskiPlan.html', 'Евидентен лист']
];
const TOOLS = [
    ['Pregled-Baza.html', 'Преглед на базата'],
    ['Sinhronizacija.html', 'Синхронизација'],
    ['Rasporedi.html', 'Стар распоред']
];
// `start.html` keeps its OWN split and deliberately files „Уреди настава"
// under its tools rather than its cards, so the launcher shows one card fewer
// than the bar shows tabs. One constant was standing for both lists, which is
// why making NastavaUredi a tab turned a launcher assertion red for a reason
// that had nothing to do with the launcher.
const LAUNCHER_CARDS = APPS.filter(([file]) => file !== 'NastavaUredi.html').length;
const LABELS = ['Сите', ...APPS.map(([, label]) => label)];

let fails = 0;
const check = (label, condition, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else {
        fails++;
        console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
    }
};

const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
});

console.log('shared navigation — the four everyday work screens\n');
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
for (const [file, label] of APPS) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${BASE}/${file}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mtbAppNav');
    await page.waitForFunction(() => {
        const state = document.querySelector('.mtb-app-nav__status--server');
        return state && state.dataset.state !== 'checking';
    });

    const nav = await page.$eval('#mtbAppNav', (node) => ({
        labels: Array.from(node.querySelectorAll('a')).map((link) => link.textContent.trim()),
        current: Array.from(node.querySelectorAll('[aria-current="page"]')).map((link) => link.textContent.trim()),
        destinations: Array.from(node.querySelectorAll('a')).map((link) => new URL(link.href).pathname.split('/').pop()),
        top: Math.round(node.getBoundingClientRect().top),
        server: node.querySelector('.mtb-app-nav__status--server .mtb-app-nav__value')?.textContent.trim(),
        serverState: node.querySelector('.mtb-app-nav__status--server')?.dataset.state,
        data: node.querySelector('.mtb-app-nav__status--data .mtb-app-nav__value')?.textContent.trim()
    }));
    check(`${label}: сите дестинации се присутни`, JSON.stringify(nav.labels) === JSON.stringify(LABELS), JSON.stringify(nav.labels));
    check(`${label}: тековната страница е означена`, JSON.stringify(nav.current) === JSON.stringify([label]), JSON.stringify(nav.current));
    check(`${label}: линковите водат до петте страници`,
        JSON.stringify(nav.destinations) === JSON.stringify(['start.html', ...APPS.map(([name]) => name)]),
        JSON.stringify(nav.destinations));
    check(`${label}: лентата е прва на страницата`, nav.top === 0, `top=${nav.top}`);
    check(`${label}: активната база е постојано именувана`, Boolean(nav.server), JSON.stringify(nav));
    check(`${label}: серверот е потврден преку health`, ['online', 'warning'].includes(nav.serverState), JSON.stringify(nav));
    check(`${label}: состојбата на податоците е видлива`, Boolean(nav.data), JSON.stringify(nav));
    check(`${label}: нема JavaScript грешки`, errors.length === 0, errors.join(' | '));
    if (file === 'S-Dnevnik.html') {
        await page.waitForTimeout(350);
        const clearOfDock = await page.evaluate(() => {
            const navRect = document.getElementById('mtbAppNav').getBoundingClientRect();
            const dockRect = document.getElementById('homeDock').getBoundingClientRect();
            return navRect.bottom <= dockRect.top;
        });
        check('S-Дневник: подвижното Home копче не ја покрива навигацијата', clearOfDock);

        const scrollStayedPut = await page.evaluate(() => {
            document.body.style.minHeight = '2400px';
            window.scrollTo(0, 700);
            const before = window.scrollY;
            window.MTBAppNavigation.reportDataState({ state: 'synced', text: 'Зачувано во базата' });
            return { before, after: window.scrollY };
        });
        check('S-Дневник: освежување на статусот не ја поместува страницата',
            scrollStayedPut.before === scrollStayedPut.after && scrollStayedPut.before > 0,
            JSON.stringify(scrollStayedPut));
    }
    await page.close();
}
await context.close();

console.log('\nshared identity — setup and diagnostic screens');
const toolContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
for (const [file, label] of TOOLS) {
    const page = await toolContext.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${BASE}/${file}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mtbAppNav');
    await page.waitForFunction(() => {
        const state = document.querySelector('.mtb-app-nav__status--server');
        return state && state.dataset.state !== 'checking';
    });
    const state = await page.$eval('#mtbAppNav', (node) => ({
        server: node.querySelector('.mtb-app-nav__status--server .mtb-app-nav__value')?.textContent.trim(),
        serverState: node.querySelector('.mtb-app-nav__status--server')?.dataset.state,
        data: node.querySelector('.mtb-app-nav__status--data .mtb-app-nav__value')?.textContent.trim()
    }));
    check(`${label}: активната база е именувана`, Boolean(state.server), JSON.stringify(state));
    check(`${label}: health ја потврдува базата`, ['online', 'warning'].includes(state.serverState), JSON.stringify(state));
    check(`${label}: состојбата на податоците е видлива`, Boolean(state.data), JSON.stringify(state));
    check(`${label}: нема JavaScript грешки`, errors.length === 0, errors.join(' | '));
    await page.close();
}
await toolContext.close();

console.log('\nread-only mirror — visible source and refused diary save');
const mirrorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await mirrorContext.addInitScript(() => localStorage.setItem('sdn_local_server_autosync_v1', '0'));
await mirrorContext.route('**/api/health', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
        ok: true,
        database: 'therapy_mirror',
        server: { label: 'ПРОБНА КОПИЈА' },
        mirror: {
            mode: 'readonly',
            source: 'Supabase test',
            dataAt: '2026-09-21T08:15:00.000Z',
            appliedAt: '2026-09-21T08:16:00.000Z',
            pending: false
        }
    })
}));
const mirrorDiary = await mirrorContext.newPage();
const mirrorErrors = [];
mirrorDiary.on('pageerror', (error) => mirrorErrors.push(String(error)));
await mirrorDiary.goto(`${BASE}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
await mirrorDiary.waitForFunction(() => window.SdnV3 && window.MTB_MIRROR_READONLY === true);
const mirrorState = await mirrorDiary.evaluate(async () => {
    const serverChip = document.querySelector('.mtb-app-nav__status--server');
    let refusal = '';
    try {
        await window.SdnV3.saveFullPayload(window.SdnV3.currentPayload('mirror_browser_test'), 'mirror_browser_test');
    } catch (error) {
        refusal = String(error && error.message || error);
    }
    return {
        serverState: serverChip?.dataset.state,
        serverText: serverChip?.querySelector('.mtb-app-nav__value')?.textContent.trim(),
        serverTitle: serverChip?.title,
        refusal,
        dataState: document.querySelector('.mtb-app-nav__status--data')?.dataset.state
    };
});
check('mirror: server chip is visibly read-only',
    mirrorState.serverState === 'readonly' && mirrorState.serverText.includes('КОПИЈА'),
    JSON.stringify(mirrorState));
check('mirror: chip identifies the authoritative source and data time',
    mirrorState.serverTitle.includes('Supabase test') && mirrorState.serverText.includes('2026-09-21 08:15'),
    JSON.stringify(mirrorState));
check('mirror: S-Dnevnik refuses a local save',
    mirrorState.refusal.includes('само за читање') && mirrorState.dataState === 'error',
    JSON.stringify(mirrorState));
check('mirror: refusal is handled without a JavaScript page error',
    mirrorErrors.length === 0, mirrorErrors.join(' | '));
await mirrorContext.close();

console.log('\nlocal-first status — pending survives a reload and the page origin owns the server');
const localFirst = await browser.newContext({ viewport: { width: 1200, height: 800 } });
await localFirst.addInitScript(() => {
    localStorage.setItem('sdn_local_server_pending_v1', '1');
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
    localStorage.setItem('sdn_local_server_url_v1', 'https://wrong-machine.example');
});
const diary = await localFirst.newPage();
await diary.goto(`${BASE}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
await diary.waitForSelector('#mtbAppNav');
await diary.waitForFunction(() => window.SdnLocalSrv && document.getElementById('sdnLocalSrvUrl'));
const localFirstState = await diary.evaluate(() => ({
    state: document.querySelector('.mtb-app-nav__status--data')?.dataset.state,
    text: document.querySelector('.mtb-app-nav__status--data .mtb-app-nav__value')?.textContent.trim(),
    url: window.SdnLocalSrv.getUrl(),
    origin: window.location.origin,
    addressLocked: document.getElementById('sdnLocalSrvUrl').disabled
}));
check('неиспратената состојба останува видлива по отворање',
    localFirstState.state === 'pending' && /чека сервер/.test(localFirstState.text), JSON.stringify(localFirstState));
check('дневникот на серверска адреса не може да пишува на другата машина',
    localFirstState.url === localFirstState.origin && localFirstState.addressLocked, JSON.stringify(localFirstState));
await localFirst.close();

console.log('\nshared sign-in — server identity shape, authenticated writes, and logout revocation');
const authContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await authContext.addInitScript(() => {
    // Seed only the first document.  Logout deliberately reloads the page; an
    // unconditional init script would put the token back during that reload
    // and make a successful logout look as though it failed.
    if (sessionStorage.getItem('navigation_auth_seeded') !== '1') {
        localStorage.setItem('evidence_token_v1', 'invented-browser-token');
        sessionStorage.setItem('navigation_auth_seeded', '1');
    }
});
const authPage = await authContext.newPage();
let probeToken = '';
let logoutToken = '';
await authPage.route('**/api/evidence/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
        person: { kind: 'therapist', id: 24601, name: 'Пробен Најавен Терапевт' },
        permissions: { enforced: true, admin: false }
    })
}));
await authPage.route('**/api/test-auth-probe', (route) => {
    probeToken = route.request().headers()['x-mtb-evidence-token'] || '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await authPage.route('**/api/evidence/logout', (route) => {
    logoutToken = route.request().headers()['x-mtb-evidence-token'] || '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await authPage.goto(`${BASE}/Nastava.html`, { waitUntil: 'domcontentloaded' });
await authPage.waitForFunction(() =>
    document.querySelector('.mtb-app-nav__status--user .mtb-app-nav__value')?.textContent.includes('Пробен Најавен'));
check('`/me` person shape is shown as the signed-in user',
    /Пробен Најавен Терапевт/.test(await authPage.textContent('.mtb-app-nav__status--user')));
await authPage.evaluate(() => fetch('/api/test-auth-probe', { method: 'POST' }).then((response) => response.json()));
check('shared fetch sends the session only to the active MTB API', probeToken === 'invented-browser-token');
await authPage.click('.mtb-app-nav__logout');
await authPage.waitForFunction(() => localStorage.getItem('evidence_token_v1') === null);
check('logout revokes the server session before forgetting the browser token', logoutToken === 'invented-browser-token');
await authContext.close();

console.log('\nphone width — the row fits or scrolls without widening the page');
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const phonePage = await mobile.newPage();
await phonePage.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await phonePage.waitForSelector('#mtbAppNav');
const phone = await phonePage.$eval('#mtbAppNav', (nav) => {
    const active = nav.querySelector('[aria-current="page"]');
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const stateRect = nav.querySelector('.mtb-app-nav__state').getBoundingClientRect();
    return {
        scrollable: nav.scrollWidth > nav.clientWidth,
        navInside: navRect.left >= 0 && navRect.right <= window.innerWidth + 1,
        activeInside: activeRect.left >= navRect.left && activeRect.right <= navRect.right + 1,
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        stateInside: stateRect.left >= 0 && stateRect.right <= window.innerWidth + 1,
        serverVisible: Boolean(nav.querySelector('.mtb-app-nav__status--server .mtb-app-nav__value')?.textContent.trim()),
        dataVisible: Boolean(nav.querySelector('.mtb-app-nav__status--data .mtb-app-nav__value')?.textContent.trim())
    };
});
check('лентата е употреблива без разлика дали собира или се лизга',
    phone.scrollable || phone.pageWidth <= phone.viewport + 1, JSON.stringify(phone));
check('лентата не излегува од екранот', phone.navInside, JSON.stringify(phone));
check('тековната апликација е видлива', phone.activeInside, JSON.stringify(phone));
check('страницата не е хоризонтално раширена', phone.pageWidth <= phone.viewport + 1, JSON.stringify(phone));
check('состојбата останува во ширината на телефонот', phone.stateInside, JSON.stringify(phone));
check('и базата и податоците се видливи на телефон', phone.serverVisible && phone.dataVisible, JSON.stringify(phone));

await mobile.close();

console.log('\nlauncher — local database without Internet, explicit peer choice, and no-server recovery');
const launcherContext = await browser.newContext();
const alias = 'https://home-alias.fixture.ts.net';
const peer = 'https://work.fixture.ts.net';
await launcherContext.addInitScript(({ alias, peer }) => {
    if (!localStorage.getItem('mtb_servers_v1')) {
        localStorage.setItem('mtb_servers_v1', JSON.stringify([alias, peer]));
    }
}, { alias, peer });
const launcher = await launcherContext.newPage();
const launcherErrors = [];
launcher.on('pageerror', (error) => launcherErrors.push(String(error)));
let healthMode = 'local';
let localProbes = 0;
await launcher.route('**/api/health', (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === new URL(BASE).origin) localProbes++;
    if (healthMode === 'none' || (healthMode === 'local' && origin !== new URL(BASE).origin)) {
        return route.abort('internetdisconnected');
    }
    return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            ok: true,
            instance: origin === peer ? 'invented-work-instance' : 'invented-home-instance',
            server: { label: origin === peer ? 'ПРОБНА РАБОТА' : 'ПРОБНА ДОМА' }
        })
    });
});
await launcher.goto(`${BASE}/start.html`);
await launcher.waitForSelector('#apps:not(.hide)');
check('local start finds its own API when every configured tailnet address is unreachable',
    await launcher.locator('#apps a').count() === LAUNCHER_CARDS && localProbes === 1);
check('offline Internet access keeps app links on the local server',
    (await launcher.locator('#apps a').evaluateAll((links) => links.map((link) => link.origin)))
        .every((origin) => origin === new URL(BASE).origin));

await launcher.evaluate(({ base, alias, peer }) => {
    localStorage.setItem('mtb_servers_v1', JSON.stringify([base + '/', base, alias, peer]));
    localStorage.removeItem('mtb_podatoci_server_v1');
}, { base: BASE, alias, peer });
healthMode = 'both';
localProbes = 0;
await launcher.reload();
await launcher.waitForSelector('#extra a.app');
check('local URL duplicates and a tailnet alias do not create an extra machine choice',
    localProbes === 1 && await launcher.locator('#extra a.app').count() === 2);
check('two independent databases require a choice before opening any application',
    await launcher.locator('#apps').evaluate((box) => box.classList.contains('hide')) &&
    await launcher.evaluate(() => localStorage.getItem('mtb_podatoci_server_v1')) === null);
await launcher.getByRole('link', { name: /ПРОБНА РАБОТА/ }).click();
check('an explicit peer choice is used by the app links',
    await launcher.evaluate(() => localStorage.getItem('mtb_podatoci_server_v1')) === peer &&
    (await launcher.locator('#apps a').evaluateAll((links) => links.map((link) => link.origin)))
        .every((origin) => origin === peer));

healthMode = 'none';
await launcher.reload();
await launcher.waitForSelector('#extra .apps a');
// The sync page reads this browser's own diary copy, so it still has an answer
// when no server does; every other screen needs the API.
check('with no API the launcher offers only the local-first diary and the sync page',
    JSON.stringify(await launcher.locator('#extra .apps a').evaluateAll((links) =>
        links.map((link) => new URL(link.href).pathname.split('/').pop()))) ===
        JSON.stringify(['S-Dnevnik.html', 'Sinhronizacija.html']));
check('the no-server path has no JavaScript error and never exposes the legacy schedule',
    launcherErrors.length === 0 && await launcher.locator('a[href*="Rasporedi.html"]').count() === 0,
    launcherErrors.join(' | '));
await launcherContext.close();

console.log('\n„изработил …" — from the server, once per window');
// Owner, 25 Sep 2026: the author's credit on every screen. The name is the
// server's (`MTB_AUTHOR`), never the code's: check:names refuses real names in
// this public repository, so the fixture is an invented one.
let author = 'Измислен Автор';
let look = null;
let healthDown = false;
const creditContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await creditContext.route('**/api/health', async (route) => {
    if (healthDown) return route.abort();
    const response = await route.fetch();
    const json = await response.json();
    if (author) json.author = author; else delete json.author;
    if (look) json.authorLook = look; else delete json.authorLook;
    await route.fulfill({ json });
});
const credited = await creditContext.newPage();
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbCredit', { timeout: 6000 }).catch(() => {});
check('a screen carries the credit the server names',
    (await credited.locator('#mtbCredit').textContent().catch(() => '')) === 'изработил Измислен Автор');
check('and it never stands in the way of a click',
    await credited.$eval('#mtbCredit', (n) => getComputedStyle(n).pointerEvents).catch(() => '') === 'none');
// Owner, 27 Sep 2026: S-Dnevnik's watermark, everywhere — bottom right. The
// bottom left is S-Dnevnik's status strip, which a credit drawn there sat on.
check('a watermark in the bottom-right corner, where S-Dnevnik kept its own',
    await credited.$eval('#mtbCredit', (n) => {
        const box = n.getBoundingClientRect();
        return box.right > innerWidth - 40 && box.bottom > innerHeight - 40;
    }).catch(() => false));
// 046: the administrator's look reaches every screen through /api/health.
look = { size: '14px', lightText: 'rgba(170, 0, 17, 0.8)', lightHalo: 'rgba(255, 255, 255, 0.2)',
    darkText: 'rgba(255, 255, 255, 0.9)', darkHalo: 'rgba(10, 12, 30, 0.5)' };
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbAppNav');
await credited.waitForTimeout(1500);
check('the look the administrator set is the look every screen draws',
    await credited.$eval('#mtbCredit', (n) => {
        const s = getComputedStyle(n);
        return s.fontSize === '14px' && s.color === 'rgba(170, 0, 17, 0.8)';
    }).catch(() => false));
look = { ...look, size: '14px; background: red' };
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbAppNav');
await credited.waitForTimeout(1500);
check('and a look that is not plain CSS values is ignored, not applied',
    await credited.$eval('#mtbCredit', (n) => getComputedStyle(n).fontSize === '11px' && !n.style.cssText.includes('red'))
        .catch(() => false));
look = null;
await credited.emulateMedia({ media: 'print' });
check('and it is on the printed page too',
    await credited.$eval('#mtbCredit', (n) => getComputedStyle(n).display !== 'none').catch(() => false));
await credited.emulateMedia({ media: 'screen' });
await credited.goto(`${BASE}/Podatoci.html?embed=1`, { waitUntil: 'domcontentloaded' });
await credited.waitForTimeout(1500);
check('a window inside the Workspace leaves it to the shell', await credited.locator('#mtbCredit').count() === 0);
// Ever present: a credit that waits for the server vanishes exactly when the
// server cannot be asked — a published copy, a machine that is switched off.
healthDown = true;
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbAppNav');
await credited.waitForTimeout(1500);
check('with the server unreachable, the browser still shows the name it was given',
    (await credited.locator('#mtbCredit').textContent().catch(() => '')) === 'изработил Измислен Автор');
healthDown = false;
author = '';
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbAppNav');
await credited.waitForTimeout(1500);
check('a server that names nobody shows nothing, not a placeholder', await credited.locator('#mtbCredit').count() === 0);
healthDown = true;
await credited.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await credited.waitForSelector('#mtbAppNav');
await credited.waitForTimeout(1500);
check('and the server’s „nobody“ is remembered too: nothing comes back offline',
    await credited.locator('#mtbCredit').count() === 0);
healthDown = false;
await creditContext.close();

console.log('\n„🎨 Изглед" — the administrator sets the watermark for everybody');
// Every call the tab makes is invented: nothing here reaches the database.
const DEFAULT_LOOK = { size: 11, light: { color: '#4f5bd5', text: 50, halo: 68 }, dark: { color: '#a5b4fc', text: 48, halo: 68 } };
let lookSignedIn = false;
const lookPuts = [];
const lookContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await lookContext.route('**/api/credit-look', async (route) => {
    if (route.request().method() === 'GET') {
        return route.fulfill({ json: { author: 'Измислен Автор', look: DEFAULT_LOOK, defaults: DEFAULT_LOOK } });
    }
    if (!lookSignedIn) {
        return route.fulfill({ status: 403, json: { error: 'Изгледот на водениот жиг го менува само администраторот.', needsAdmin: true } });
    }
    const body = route.request().postDataJSON();
    lookPuts.push(body);
    return route.fulfill({ json: { ok: true, look: body, css: { size: '15px', lightText: 'rgba(170, 0, 17, 0.8)',
        lightHalo: 'rgba(255, 255, 255, 0.68)', darkText: 'rgba(165, 180, 252, 0.48)', darkHalo: 'rgba(10, 12, 30, 0.68)' } } });
});
await lookContext.route('**/api/evidence/people', (route) =>
    route.fulfill({ json: { people: [{ kind: 'therapist', id: 9, name: 'Измислен Автор' }] } }));
await lookContext.route('**/api/evidence/login', (route) => {
    lookSignedIn = true;
    return route.fulfill({ json: { token: 'invented-admin-token', person: { name: 'Измислен Автор' } } });
});
const lookPage = await lookContext.newPage();
await lookPage.goto(`${BASE}/Podatoci.html?tab=look`, { waitUntil: 'domcontentloaded' });
await lookPage.waitForFunction(() => document.getElementById('lookLightText').value === '50', null, { timeout: 8000 }).catch(() => {});
check('the tab opens on the saved look, both themes previewed',
    await lookPage.isVisible('#tab-look') && await lookPage.inputValue('#lookLightText') === '50'
        && (await lookPage.textContent('#lookSampleDark')) === 'изработил Измислен Автор');
await lookPage.$eval('#lookLightText', (n) => { n.value = '80'; n.dispatchEvent(new Event('input', { bubbles: true })); });
await lookPage.$eval('#lookSize', (n) => { n.value = '15'; n.dispatchEvent(new Event('input', { bubbles: true })); });
check('a slider changes the preview at once',
    await lookPage.$eval('#lookSampleLight', (n) => n.style.color === 'rgba(79, 91, 213, 0.8)' && n.style.fontSize === '15px'));
check('and nothing is saved by moving it', lookPuts.length === 0);
await lookPage.click('#lookSave');
await lookPage.waitForSelector('#lookPin', { timeout: 5000 }).catch(() => {});
check('saving without the administrator asks for the sign-in, and says why',
    await lookPage.isVisible('#lookPin') && /само администраторот/.test(await lookPage.textContent('#lookGate')));
await lookPage.fill('#lookPin', '0000');
await lookPage.click('#lookSignIn');
await lookPage.waitForFunction(() => !document.getElementById('lookPin'), null, { timeout: 5000 }).catch(() => {});
check('signed in, the same look is saved — the one on the sliders',
    lookPuts.length === 1 && lookPuts[0].light.text === 80 && lookPuts[0].size === 15 && lookPuts[0].dark.text === 48);
check('and this window\'s own watermark takes it at once',
    await lookPage.$eval('#mtbCredit', (n) => getComputedStyle(n).fontSize === '15px').catch(() => false));
await lookPage.click('#lookReset');
check('„Почетен изглед" puts the defaults back in the preview, unsaved',
    await lookPage.inputValue('#lookLightText') === '50' && lookPuts.length === 1);
await lookContext.close();

console.log('\n⚠ an installation that is behind says so before anyone works on it');
// Owner, 28 Sep 2026. The server only reports; the fix is the desktop shortcut.
let behind = { pendingMigrations: 2, behind: 3 };
const updateContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await updateContext.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (behind) json.update = behind; else delete json.update;
    await route.fulfill({ json });
});
const upd = await updateContext.newPage();
await upd.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await upd.waitForSelector('#mtbUpdateNotice', { timeout: 6000 }).catch(() => {});
const notice = await upd.textContent('#mtbUpdateNotice').catch(() => '');
check('a window covers the screen and says what waits', /2 промени на базата/.test(notice) && /3 нови промени/.test(notice), notice.slice(0, 120));
check('and exactly what to do: the shortcut on that computer', notice.includes('MTB - Azuriraj'));
check('it is in front of the work: a click on the page reaches the window, not the page',
    await upd.evaluate(() => document.elementFromPoint(innerWidth / 2, 30)?.closest('#mtbUpdateNotice') != null));
await upd.click('#mtbUpdateNotice button');
check('„Разбрав" lets the person in', await upd.locator('#mtbUpdateNotice').count() === 0);
await upd.goto(`${BASE}/Nastava.html`, { waitUntil: 'domcontentloaded' });
await upd.waitForSelector('#mtbAppNav');
await upd.waitForTimeout(1500);
check('moving to another screen in the same session does not ask again', await upd.locator('#mtbUpdateNotice').count() === 0);
behind = { pendingMigrations: 3, behind: 3 };
await upd.reload({ waitUntil: 'domcontentloaded' });
await upd.waitForSelector('#mtbUpdateNotice', { timeout: 6000 }).catch(() => {});
check('but something new waiting asks again', await upd.locator('#mtbUpdateNotice').count() === 1);
await upd.goto(`${BASE}/Podatoci.html?embed=1`, { waitUntil: 'domcontentloaded' });
await upd.waitForTimeout(1500);
check('a window inside the Workspace leaves it to the shell', await upd.locator('#mtbUpdateNotice').count() === 0);
behind = null;
await upd.goto(`${BASE}/Podatoci.html`, { waitUntil: 'domcontentloaded' });
await upd.waitForSelector('#mtbAppNav');
await upd.waitForTimeout(1500);
check('an installation that is up to date shows nothing', await upd.locator('#mtbUpdateNotice').count() === 0);
await updateContext.close();

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
