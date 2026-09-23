/**
 * In the workspace, a tab always shows its own app.
 *
 * The owner met this: „Настава" clicked inside the Распоред window turned
 * that window into Nastava.html, and the highlighted Распоред tab then did
 * nothing. Now a link to another app opens that app's tab, and a window that
 * wandered anyway is sent home when its tab is pressed.
 *
 * Self-contained: the workspace and app-navigation.js come from disk on a fake
 * localhost origin; the child apps are tiny stand-ins that load the REAL
 * app-navigation.js (the half being tested); every API call is answered here.
 * CHROME can select an installed browser.
 *
 *   node test/workspace-links.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3995';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const STUBS = ['RasporediFusion.html', 'Nastava.html', 'NastavaUredi.html', 'Podatoci.html', 'AkciskiPlan.html', 'S-Dnevnik.html', 'Pregled-Baza.html'];
const REAL = new Set(['MTB-Workspace.html', 'app-navigation.js', 'workspace-admin.js', 'workspace-admin.css', 'mtb-runtime.js', 'home-button.js']);

const stub = (file) => `<!doctype html><html><meta charset="utf-8"><title>${file}</title><body data-app="${file}">
  <p id="who">${file}</p>
  <a id="toNastava" href="Nastava.html?year=2026%2F2027">Настава</a>
  <a id="toPodatoci" href="/Podatoci.html">Податоци</a>
  <a id="toOther" href="Sinhronizacija.html">not a workspace tab</a>
  <script src="app-navigation.js"></script></body></html>`;

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
const errors = [];
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const file = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') return json(405, { error: 'read-only fixture' });
        if (url.pathname === '/api/health') return json(200, { ok: true, server: { label: 'Пробна база' } });
        if (url.pathname === '/api/years') return json(200, [{ id: 1, label: '2026/2027', is_current: true }]);
        if (url.pathname === '/api/roster') return json(200, { year: '2026/2027', students: [], therapists: [], teachers: [], classes: [] });
        return json(404, {});
    }
    if (STUBS.includes(file)) return route.fulfill({ status: 200, contentType: TYPES['.html'], body: stub(file) });
    if (REAL.has(file) && existsSync(join(ROOT, file))) {
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'text/plain', body: await readFile(join(ROOT, file)) });
    }
    if (file === 'Sinhronizacija.html') return route.fulfill({ status: 200, contentType: TYPES['.html'], body: '<p id="who">Sinhronizacija.html</p>' });
    return route.fulfill({ status: 404, body: '' });
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(ORIGIN + '/MTB-Workspace.html?view=windows');

const scheduleFrame = () => page.frameLocator('#appFrame');
const pathOf = (selector) => page.$eval(selector, (f) => {
    try { return decodeURIComponent(f.contentWindow.location.pathname.split('/').pop()); } catch (_) { return '?'; }
});
const visible = (id) => page.$eval('#' + id, (el) => !el.hidden && getComputedStyle(el).display !== 'none').catch(() => false);
await scheduleFrame().locator('#who').waitFor();

try {
    console.log('\na link to another app, clicked inside Распоред');
    await scheduleFrame().locator('#toNastava').click();
    await page.locator('#app-Nastava iframe').waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    check('the Настава tab opens its own window', await visible('app-Nastava'));
    check('that window shows Nastava', await pathOf('#app-Nastava iframe') === 'Nastava.html', await pathOf('#app-Nastava iframe').catch(() => '?'));
    check('the Распоред window is still Fusion', await pathOf('#appFrame') === 'RasporediFusion.html', await pathOf('#appFrame'));

    console.log('\nan absolute link and a non-tab link');
    await page.click('#appTabs [data-app="RasporediFusion.html"]');
    await scheduleFrame().locator('#toPodatoci').click();
    await page.locator('#app-Podatoci iframe').waitFor({ timeout: 5000 }).catch(() => {});
    check('„/Podatoci.html" also opens its tab', await visible('app-Podatoci'));
    check('…and Распоред is still Fusion', await pathOf('#appFrame') === 'RasporediFusion.html');
    await page.click('#appTabs [data-app="RasporediFusion.html"]');
    await scheduleFrame().locator('#toOther').click();
    await page.waitForTimeout(600);
    check('a page with no tab is left to the browser, as before', await pathOf('#appFrame') === 'Sinhronizacija.html', await pathOf('#appFrame'));

    console.log('\na window that wandered anyway');
    await page.click('#appTabs [data-app="RasporediFusion.html"]');
    await page.waitForTimeout(800);
    check('pressing its tab brings it home', await pathOf('#appFrame') === 'RasporediFusion.html', await pathOf('#appFrame'));
    check('…still as the embedded copy', await page.$eval('#appFrame', (f) => f.contentWindow.location.search.includes('embed')));

    console.log('\na message from outside the windows');
    const before = await page.$$eval('#main section.app-window', (s) => s.map((x) => x.id).sort().join(','));
    await page.evaluate(() => window.postMessage({ type: 'mtb:open-app', file: 'AkciskiPlan.html' }, '*'));
    await page.waitForTimeout(400);
    const after = await page.$$eval('#main section.app-window', (s) => s.map((x) => x.id).sort().join(','));
    check('is ignored — only the shell\'s own frames may ask', before === after, `${before} -> ${after}`);

    check('no page errors', errors.length === 0, errors.join('\n'));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
