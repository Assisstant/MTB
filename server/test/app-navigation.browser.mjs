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
    ['RasporediFusion.html', 'Распоред'],
    ['Nastava.html', 'Настава'],
    ['NastavaUredi.html', 'Уреди настава'],
    ['Podatoci.html', 'Податоци'],
    ['AkciskiPlan.html', 'Евидентен лист']
];
const TOOLS = [
    ['Pregled-Baza.html', 'Проверка на базата'],
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
check('with no API the launcher offers only the local-first diary',
    JSON.stringify(await launcher.locator('#extra .apps a').evaluateAll((links) =>
        links.map((link) => new URL(link.href).pathname.split('/').pop()))) === JSON.stringify(['S-Dnevnik.html']));
check('the no-server path has no JavaScript error and never exposes the legacy schedule',
    launcherErrors.length === 0 && await launcher.locator('a[href*="Rasporedi.html"]').count() === 0,
    launcherErrors.join(' | '));
await launcherContext.close();

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
