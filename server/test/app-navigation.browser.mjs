/** Shared application navigation, in every work screen and at phone width. */
import { chromium } from 'playwright';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const APPS = [
    ['S-Dnevnik.html', 'S-Дневник'],
    ['RasporediFusion.html', 'Распоред'],
    ['Nastava.html', 'Настава'],
    ['Podatoci.html', 'Податоци'],
    ['AkciskiPlan.html', 'Евидентен лист']
];
const TOOLS = [
    ['NastavaUredi.html', 'Уреди настава'],
    ['Pregled-Baza.html', 'Проверка на базата'],
    ['Rasporedi.html', 'Стар распоред']
];
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
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
