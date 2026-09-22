/**
 * „Синхронизација и резерви" — every state it can report, with invented data.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is intercepted, so no server and no database is needed and
 * nothing real can be read or written.
 *
 * What is asserted beyond the sentences themselves is the page's contract:
 * it sends nothing but GET, it writes nothing to the browser (localStorage is
 * compared byte for byte, and no IndexedDB database may appear — opening the
 * diary's by name would CREATE an empty one and break S-Dnevnik on that
 * origin), and it is readable in both themes at phone width.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://mtb.test';
const PAGES = 'https://assisstant.github.io/MTB';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };

const snapshot = (machine, createdAt, extra = {}) => ({
    snapshotId: `${machine}-2026-09-22-18-00-00-abcdef12`, machine, createdAt, database: 'therapy_probe',
    migrations: 38, latestMigration: '038_roster_order.sql', tables: 50, dumpBytes: 2_400_000, gitCommit: '0de2730', ...extra
});

const health = (extra = {}) => ({ ok: true, database: 'therapy_probe', server: { label: 'ПРОБНА · РАБОТА', role: 'work' }, instance: 'i-1', ...extra });

const status = (extra = {}) => ({
    server: { id: 'work', role: 'work', label: 'ПРОБНА · РАБОТА' },
    me: 'work', peer: 'home',
    migrations: { applied: 38, inCode: 38, latestApplied: '038_roster_order.sql', notApplied: [], unknownToCode: [] },
    documents: [{ app: 'sdnevnik', version: 15, updatedAt: '2026-09-22T06:24:00.000Z', updatedBy: 'Пробен Терапевт' }],
    transports: [
        { kind: 'git', configured: true, dir: 'C:\\probe\\MTB-data', available: true, problems: [],
          me: snapshot('work', '2026-09-21T16:00:00.000Z'), peer: snapshot('home', '2026-09-20T07:00:00.000Z') },
        { kind: 'pcloud', configured: false, dir: null, available: false, me: null, peer: null, problems: [] }
    ],
    backup: { file: 'therapy_probe-2026-09-20-10-00-00.dump', at: '2026-09-20T10:00:00.000Z', bytes: 2_300_000 },
    ...extra
});

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

/**
 * One scenario: what the API answers, what this browser holds, where the page
 * is opened from. Returns the page and the evidence collected about it.
 */
async function open({ api = {}, storage = {}, origin = SERVED, file = 'Sinhronizacija.html', cloud = false,
    viewport = { width: 1280, height: 900 }, scheme = 'light' } = {}) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: 'block' });
    const evidence = { writes: [], apiCalls: [], errors: [] };
    await context.addInitScript((values) => {
        if (sessionStorage.getItem('__seeded')) return;
        for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
        sessionStorage.setItem('__seeded', '1');
    }, storage);
    await context.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const own = url.origin === SERVED || url.href.startsWith(PAGES + '/');
        if (!own) return route.abort();
        if (url.pathname.startsWith('/api/')) {
            evidence.apiCalls.push(`${req.method()} ${url.pathname}`);
            if (req.method() !== 'GET') {
                evidence.writes.push(`${req.method()} ${url.pathname}`);
                return route.fulfill({ status: 405, body: '' });
            }
            const answer = api[url.pathname];
            if (typeof answer === 'number') return route.fulfill({ status: answer, contentType: 'application/json', body: '{}' });
            if (answer === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
        }
        const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
        if (name === 'mtb-runtime.js') {
            return route.fulfill({ status: 200, contentType: TYPES['.js'],
                body: `window.MTB_CLOUD_SAME_ORIGIN=${cloud};window.MTB_MIRROR_READONLY=false;` });
        }
        try {
            const body = await readFile(path.join(ROOT, name));
            return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body });
        } catch {
            return route.fulfill({ status: 404, body: '' });
        }
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => evidence.errors.push(String(e)));
    const target = origin === PAGES ? `${PAGES}/${file}` : `${SERVED}/${file}`;
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    return { context, page, evidence };
}

async function settle(page) {
    await page.waitForFunction(() => !/Се проверува/.test(document.getElementById('browserVerdict').textContent));
    await page.waitForFunction(() => !/Се проверува/.test(document.getElementById('machineVerdict').textContent));
}

const verdictOf = (page, id) => page.$eval(`#${id}`, (el) => ({ kind: el.className, text: el.textContent.trim() }));
const badgeOf = (page, id) => page.$eval(`#${id}`, (el) => ({ kind: el.className, text: el.textContent.trim() }));
const storageOf = (page) => page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));

const synced = { electronicDiary: '{"students":[]}', electronicDiary_lastSavedAt_v2: '2026-09-22T06:20:00.000Z', sdn_local_server_version_v1: '15' };

console.log('① this browser and S-Dnevnik');
{
    const { context, page, evidence } = await open({ api: { '/api/health': health(), '/api/sync/status': status() }, storage: synced });
    await settle(page);
    const before = await storageOf(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('договорената верзија = верзијата во базата → усогласено', /verdict ok/.test(v.kind) && /Усогласено/.test(v.text), JSON.stringify(v));
    check('картичката горе го кажува истото', /усогласено · в15/.test((await badgeOf(page, 'lvlBrowser')).text));
    check('базата е именувана со улогата, не со адресата', /ПРОБНА · РАБОТА · therapy_probe/.test(await page.textContent('#fServer')));
    check('авторот и времето на дневникот во базата се прикажани',
        /верзија 15 .* Пробен Терапевт/.test(await page.textContent('#fRemote')));
    const idb = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
    check('страницата не создава IndexedDB база', idb.length === 0, JSON.stringify(idb));
    await page.click('#refresh');
    await settle(page);
    check('„Провери пак“ не запишува ништо во прелистувачот', before === await storageOf(page));
    check('праќа само GET', evidence.writes.length === 0, evidence.writes.join(', '));
    check('нема JavaScript грешки', evidence.errors.length === 0, evidence.errors.join(' | '));
    await context.close();
}
{
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': status() },
        storage: { ...synced, sdn_local_server_pending_v1: '1' } });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('непратени измени → предупредување што кажува дека S-Dnevnik ги праќа сам',
        /warn/.test(v.kind) && /уште не стигнале/.test(v.text) && /сам/.test(v.text), JSON.stringify(v));
    await context.close();
}
{
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': status() },
        storage: { ...synced, sdn_local_server_pending_v1: '1', sdn_local_server_autosync_v1: '0' } });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('со исклучена автоматска → кажува да се притисне „Синхронизирај“', /притисни „Синхронизирај“/.test(v.text), v.text);
    await context.close();
}
{
    const newer = status({ documents: [{ app: 'sdnevnik', version: 17, updatedAt: '2026-09-22T08:00:00.000Z', updatedBy: null }] });
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': newer }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('понова верзија во базата → S-Dnevnik ќе ја вчита', /понова верзија \(17\)/.test(v.text) && /вчита сама/.test(v.text), v.text);
    await context.close();
}
{
    const replaced = status({ documents: [{ app: 'sdnevnik', version: 3, updatedAt: '2026-09-22T08:00:00.000Z', updatedBy: null }] });
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': replaced }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('помала верзија значи заменета база, никогаш „понова“',
        /warn/.test(v.kind) && /заменета/.test(v.text) && !/понова верзија/.test(v.text), v.text);
    await context.close();
}
{
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': status() } });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('без локален дневник → ќе се вчита при прво отворање', /нема локален дневник/.test(v.text) && /верзија 15/.test(v.text), v.text);
    await context.close();
}
{
    const { context, page } = await open({ api: { '/api/health': health() }, storage: synced });
    await settle(page);
    check('постар сервер без проверката → кажано, не погодено',
        /постар код/.test(await page.textContent('#fRemote')) && /постар код/.test(await page.textContent('#transports')));
    await context.close();
}
{
    const { context, page } = await open({ api: { '/api/health': 503 }, storage: { ...synced, sdn_local_server_pending_v1: '1' } });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('базата не одговара → измените се безбедни тука', /Базата не одговара/.test(v.text) && /безбедни/.test(v.text), v.text);
    await context.close();
}
{
    const { context, page, evidence } = await open({ origin: PAGES, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'browserVerdict');
    check('објавената копија без избрана база → само на овој уред', /само на овој уред/.test(v.text), v.text);
    check('и не прашува сопствен origin за API', evidence.apiCalls.length === 0, evidence.apiCalls.join(', '));
    await context.close();
}

console.log('\n② WORK ↔ HOME');
{
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': status() }, storage: synced });
    await settle(page);
    const rows = await page.$$eval('#transports tr', (trs) => trs.map((tr) => tr.textContent));
    check('двата преноса имаат свој ред', rows.length === 2, JSON.stringify(rows));
    check('GitHub редот ги носи и двете снимки', /work-2026/.test(rows[0]) && /home-2026/.test(rows[0]), rows[0]);
    check('pCloud што не е поставен е кажан како таков', /не е поставен/.test(rows[1]), rows[1]);
    check('Windows патеката е прикажана точно, со обратните црти', rows[0].includes('C:\\probe\\MTB-data'), rows[0]);
    const v = await verdictOf(page, 'machineVerdict');
    check('последниот извоз од оваа машина е во пресудата', /Последен извоз од оваа машина/.test(v.text), v.text);
    check('командата за Push е точната', (await page.textContent('#cmdPush')) ===
        'powershell -ExecutionPolicy Bypass -File scripts\\git-sync.ps1 -Mode Push');
    const commands = await page.$$eval('.cmd code', (codes) => codes.map((c) => c.textContent));
    check('ниедна команда за копирање не заменува база', commands.every((c) => !/-Apply/.test(c)), JSON.stringify(commands));
    await context.close();
}
{
    const gap = status({ migrations: { applied: 32, inCode: 38, latestApplied: '032_x.sql',
        notApplied: ['033_a.sql', '038_roster_order.sql'], unknownToCode: [] } });
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': gap }, storage: synced });
    await settle(page);
    const text = await page.textContent('#mMigrations');
    check('миграциите што ги нема се опишани, не се нудат за примена',
        /кодот носи 2/.test(text) && /намерно/.test(text) && /не се применуваат од тука/.test(text), text);
    await context.close();
}
{
    // This database moved ahead of the other machine's newest snapshot: the
    // transfer refuses both ways until the migration lists match again.
    const ahead = status();
    ahead.transports[0].peer = snapshot('home', '2026-09-20T07:00:00.000Z', { migrations: 32, latestMigration: '032_x.sql' });
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': ahead }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'machineVerdict');
    check('друг број миграции кај другата машина → предупредување во пресудата',
        /warn/.test(v.kind) && /оваа база 38, другата машина 32/.test(v.text) && /нема да се прифати таму/.test(v.text), v.text);
    check('и кажува како се изедначува, без -Apply', /setup-home-postgres\.ps1/.test(v.text) && !/-Apply/.test(v.text), v.text);
    check('картичката горе го кажува истото', /миграциите се разликуваат/.test((await badgeOf(page, 'lvlMachines')).text));
    await context.close();
}
{
    const bad = status();
    bad.transports[0].problems = ['home: манифестот именува друга машина'];
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': bad }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'machineVerdict');
    check('манифест што скриптата би го одбила е црвен', /bad/.test(v.kind) && /друга машина/.test(v.text), v.text);
    await context.close();
}
{
    const none = status({ me: null, peer: null });
    const { context, page } = await open({ api: { '/api/health': health(), '/api/sync/status': none }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'machineVerdict');
    check('без SYNC_NAME → не учествува, ништо не се погодува', /не учествува/.test(v.text), v.text);
    await context.close();
}

console.log('\n③ the cloud');
{
    const cloudHealth = health({ server: { label: 'ОБЛАК · Render' }, cloudAuth: 'google' });
    const { context, page } = await open({ cloud: true, api: { '/api/health': cloudHealth, '/api/sync/status': status({ me: null, peer: null }) }, storage: synced });
    await settle(page);
    const v = await verdictOf(page, 'cloudVerdict');
    check('отворено во облакот → јасно речено дека е посебна база', /Сега си во облакот/.test(v.text) && /не стигнува/.test(v.text), v.text);
    check('и горе е истакнато', /сега си тука/.test((await badgeOf(page, 'lvlCloud')).text));
    await context.close();
}

console.log('\nreadability — both themes, phone width');
for (const scheme of ['light', 'dark']) {
    const { context, page, evidence } = await open({ scheme, viewport: { width: 390, height: 844 },
        api: { '/api/health': health(), '/api/sync/status': status() }, storage: { ...synced, sdn_local_server_pending_v1: '1' } });
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${scheme}: нема хоризонтално лизгање на 390px`, overflow <= 0, `вишок ${overflow}px`);
    const worst = await page.evaluate(() => {
        const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => {
            const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const bgOf = (el) => {
            for (let n = el; n; n = n.parentElement) {
                const c = getComputedStyle(n).backgroundColor;
                if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
            }
            return getComputedStyle(document.body).backgroundColor;
        };
        const ratio = (el) => {
            const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bgOf(el)));
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const nodes = [...document.querySelectorAll('.badge, .verdict, .verdict b, .btn-link, .muted, dt, .cmd code, button')];
        return nodes.map((n) => ({ what: n.className || n.tagName, text: n.textContent.trim().slice(0, 30), r: ratio(n) }))
            .sort((x, y) => x.r - y.r)[0];
    });
    check(`${scheme}: најслабиот текст е барем 4.5:1`, worst.r >= 4.5, JSON.stringify(worst));
    check(`${scheme}: нема JavaScript грешки`, evidence.errors.length === 0, evidence.errors.join(' | '));
    await context.close();
}

console.log('\nreachable — the launcher, the shared bar and S-Dnevnik');
{
    // A hosted origin probes only itself, which is the one address this
    // test answers; every other candidate is aborted.
    const { context, page } = await open({ file: 'start.html', cloud: true, api: { '/api/health': health() } });
    await page.waitForSelector('#toolApps a', { state: 'attached' });
    const tools = await page.$$eval('#toolApps a', (as) => as.map((a) => new URL(a.href).pathname.split('/').pop()));
    check('start.html ја нуди меѓу алатките', tools.includes('Sinhronizacija.html'), JSON.stringify(tools));
    await context.close();
}
{
    // Nothing answers: the page still has something true to say about this
    // browser's own diary, so it is offered beside S-Dnevnik.
    const { context, page } = await open({ file: 'start.html' });
    await page.waitForSelector('#extra a', { timeout: 15000 });
    const offline = await page.$$eval('#extra a', (as) => as.map((a) => new URL(a.href).pathname.split('/').pop()));
    check('и кога ниту еден сервер не одговара', offline.includes('Sinhronizacija.html') && offline.includes('S-Dnevnik.html'),
        JSON.stringify(offline));
    await context.close();
}
{
    const { context, page } = await open({ file: 'Nastava.html', api: { '/api/health': health() } });
    await page.waitForSelector('.mtb-app-nav__status--server');
    await page.click('.mtb-app-nav__status--server');
    const link = await page.$eval('.mtb-app-nav__menu a', (a) => ({ text: a.textContent, href: new URL(a.href).pathname }));
    check('чипот БАЗА води до неа од секој екран', /Синхронизација и резерви/.test(link.text) && link.href.endsWith('/Sinhronizacija.html'),
        JSON.stringify(link));
    await context.close();
}
{
    const { context, page } = await open({ file: 'Sinhronizacija.html', api: { '/api/health': health(), '/api/sync/status': status() } });
    await page.waitForSelector('.mtb-app-nav__status--data');
    await page.waitForFunction(() => document.querySelector('.mtb-app-nav__status--data')?.dataset.state === 'readonly');
    check('лентата ја означува страницата како само за читање', true);
    await page.click('.mtb-app-nav__status--server');
    check('и во своето мени не се повикува самата себе', (await page.$$('.mtb-app-nav__menu a')).length === 0);
    await context.close();
}
{
    // S-Dnevnik counts only localhost, a tailnet name or the hosted cloud as
    // "served by a server"; the hosted flag is the one this test can set.
    const { context, page, evidence } = await open({ file: 'S-Dnevnik.html', cloud: true, api: { '/api/health': health() },
        storage: { sdn_local_server_autosync_v1: '0' } });
    await page.waitForFunction(() => document.getElementById('sdnLocalSrvWho'));
    await page.waitForFunction(() => /ПРОБНА · РАБОТА/.test(document.getElementById('sdnLocalSrvWho').textContent));
    const panel = await page.$eval('#sdnLocalSrvPanel', (p) => ({
        title: p.querySelector('h3').textContent,
        who: document.getElementById('sdnLocalSrvWho').textContent,
        link: p.querySelector('a[href="Sinhronizacija.html"]') !== null
    }));
    check('панелот во S-Dnevnik не тврди „локален“ за секој сервер', !/Локален/.test(panel.title), panel.title);
    check('и ја именува базата со која се синхронизира', /ПРОБНА · РАБОТА · http:\/\/mtb\.test/.test(panel.who), panel.who);
    check('и води до страницата', panel.link);
    check('S-Dnevnik: нема JavaScript грешки', evidence.errors.length === 0, evidence.errors.join(' | '));
    await context.close();
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
assert.equal(fails, 0);
