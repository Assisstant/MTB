/**
 * „🔍 Барај" in the real workspace (owner, 14 Oct 2026), with invented apps in
 * its windows: a word opens the right window and view, Kolega opens at the
 * named report, Ctrl+K works from inside a window, and it fits a phone.
 *
 *     node test/workspace-search.browser.mjs     (npm run test:workspace-search)
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
await mkdir(resolve(root, 'backups/search-ui-test'), { recursive: true });
const files = new Set(['MTB-Workspace.html', 'workspace-admin.js', 'workspace-admin.css', 'app-navigation.js', 'mtb-theme.js', 'mtb-runtime.js', 'mtb-search.js', 'mtb-forms.js', 'mtb-layout.js']);
// Each app is a stand-in that keeps what the workspace told it; Кабинети uses the real `views` of app-navigation.js.
const fixture = (file) => file === 'RasporediFusion.html'
    ? '<script src="/app-navigation.js"></script><script>window.__got=[];addEventListener("message",e=>__got.push(e.data));'
        + 'MTBAppNavigation.views({keys:["panel","class"],show:v=>{window.__shown=v;}});</script><p>Кабинети</p>'
    : '<script>window.__got=[];addEventListener("message",e=>__got.push(e.data));</script><p>' + file + '</p>';
const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://local').pathname.slice(1);
    if (files.has(file)) {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
        return res.end(await readFile(resolve(root, file)));
    }
    if (file.endsWith('.html')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture(file)); }
    if (file.startsWith('api/')) { res.setHeader('Content-Type', 'application/json'); res.writeHead(file === 'api/health' ? 200 : 401); return res.end(file === 'api/health' ? '{"ok":true}' : '{"signed":null}'); }
    res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let fails = 0;
const check = (label, ok, detail = '') => { if (ok) console.log('  ok   ' + label); else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); } };
try {
    for (const width of [1500, 390]) {
        console.log(`\nwidth ${width}`);
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
        await context.addInitScript(() => { if (window.top === window) window.open = (url, name) => { (window.__opened ||= []).push([url, name]); return null; }; });
        const page = await context.newPage();
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/MTB-Workspace.html?app=S-Dnevnik.html');
        await page.waitForSelector('#openSearch');
        const ask = async (words) => {
            if (await page.locator('#mtbSearch').isHidden()) await page.click('#openSearch');
            await page.fill('#mtbSearchInput', words);
        };
        const frameOf = (file) => page.frameLocator(`#main iframe[data-app-file="${file}"]`);
        const got = (file) => page.waitForFunction((f) => {
            const frame = document.querySelector(`#main iframe[data-app-file="${f}"]`);
            return frame?.contentWindow?.__got?.filter((m) => m && m.type === 'mtb:open-view').at(-1) || null;
        }, file).then((h) => h.jsonValue());

        check('the button stands in the top bar', (await page.textContent('#openSearch')).includes('Барај'));
        await ask('лозинка');
        check('a word names the place and its path', (await page.textContent('#mtbSearchList')).includes('Списоци и пристап → 👥 Колеги'));
        check('the phone keeps it inside the screen', await page.evaluate(() => document.querySelector('#mtbSearch .box').getBoundingClientRect().right <= innerWidth + 1));
        await page.keyboard.press('Enter');
        check('Enter opens Списоци и пристап', (await page.getAttribute('#appTabs [data-app="Podatoci.html"]', 'aria-pressed')) === 'true');
        check('and tells it the tab', JSON.stringify(await got('Podatoci.html')) === JSON.stringify({ type: 'mtb:open-view', view: { tab: 'colleagues' } }));
        check('and closes', await page.locator('#mtbSearch').isHidden());

        await ask('ucenici po terapevt');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#main iframe[data-app-file="RasporediFusion.html"]')?.contentWindow?.__shown);
        const shown = await page.evaluate(() => document.querySelector('#main iframe[data-app-file="RasporediFusion.html"]').contentWindow.__shown);
        check('Latin finds Cyrillic, and Кабинети turns to its panel through app-navigation.js', shown.panel === 'roster', JSON.stringify(shown));

        await ask('аудиограм');
        await page.click('#mtbSearchList [data-pick="0"]');
        check('a click on the answer opens S-Дневник at the tab', JSON.stringify((await got('S-Dnevnik.html')).view) === '{"tab":"audiogramsApp"}');

        await ask('prevoz');
        await page.keyboard.press('Enter');
        check('the transport report opens Колега at that report', JSON.stringify(await page.evaluate(() => window.__opened?.at(-1)))
            === JSON.stringify(['Kolega.html#tab=attendance&report=transport', 'mtb-kolega']));

        await ask('превоз');await page.screenshot({ path: resolve(root, 'backups/search-ui-test/search-' + width + '.png') });
        await ask('нешто што го нема');
        check('nothing found says so', (await page.textContent('#mtbSearchList')).includes('Нема ништо'));
        await page.keyboard.press('Escape');
        check('Esc closes', await page.locator('#mtbSearch').isHidden());

        await frameOf('S-Dnevnik.html').locator('p').click();
        await page.keyboard.press('Control+k');
        check('Ctrl+K from inside a window opens it', await page.locator('#mtbSearch').isVisible());
        check('with the cursor in the field', await page.evaluate(() => document.activeElement?.id === 'mtbSearchInput'));
        await page.keyboard.press('ArrowDown');
        await ask('дежурство');
        check('↑ ↓ choose; the first stays chosen after typing', (await page.getAttribute('#mtbSearchList [data-pick="0"]', 'aria-selected')) === 'true');
        await page.keyboard.press('Escape');
        check('no page errors', errors.length === 0, errors.join(' | '));
        await context.close();
    }
} finally { await browser.close(); server.close(); }
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
