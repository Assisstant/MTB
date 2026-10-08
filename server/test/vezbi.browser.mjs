/**
 * Вежби за изговор (vezbi/index.html) in a real browser, served through the
 * server's own list of published files (lib/public-static.ts).
 *
 *     npm run test:vezbi            SHOT=<folder> for pictures, CHROME=<path> for an installed browser
 *
 * Self-contained: a server of its own on a spare port that publishes files and
 * nothing else — no database, no API — and every address outside it is
 * refused, so what passes here passes without the Internet. The page keeps no
 * records and the words are the exercise's own.
 *
 * The page came from a repository of its own (8 Oct 2026), where it opened by
 * double-click with copies of ComuniBoard.html and WBACC.html beside it. Here
 * there is one copy of each, in the folder above, and the server publishes a
 * folder file by file. What this holds it to:
 *
 *   1. the page asks the server for nothing the list does not have — a sound
 *      added to the page and forgotten in the list is a blank page in the
 *      cloud while GitHub Pages still shows it;
 *   2. the start is three tiles with their pictures, and all 26 sounds load;
 *   3. the two tools open in their frames from the folder above;
 *   4. „➜ Во таблата" puts a card on ComuniBoard's board, and ComuniBoard takes
 *      a picture from the page it is opened inside only — never an address;
 *   5. Back returns to the tiles, and the start fits a phone.
 */
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installPublicStatic } from '../src/lib/public-static.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
    if (!ok) failed++;
};

const server = Fastify({ logger: false });
installPublicStatic(server, ROOT);
await server.listen({ host: '127.0.0.1', port: 0 });
const ORIGIN = `http://127.0.0.1:${server.server.address().port}`;

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const refused = [];
    const errors = [];
    await context.route((url) => url.origin !== ORIGIN, (route) => route.abort());
    const page = await context.newPage();
    // Files only: the two tools ask a server how it is (/api/health), and this one has no API.
    page.on('response', (r) => {
        const path = r.url().startsWith(ORIGIN) ? r.url().slice(ORIGIN.length) : '';
        if (path && !path.startsWith('/api/') && r.status() >= 400) refused.push(`${r.status()} ${path}`);
    });
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name) => {
        if (!process.env.SHOT) return;
        await mkdir(process.env.SHOT, { recursive: true });
        await page.screenshot({ path: join(process.env.SHOT, name + '.png') });
    };

    console.log('the start: three tiles');
    await page.goto(`${ORIGIN}/vezbi/`);
    await page.waitForSelector('#tiles .app');
    check('the folder address opens the page', /вежби за изговор$/.test(await page.title()), await page.title());
    check('all 26 sounds are loaded', (await page.evaluate('GLASOVI.length')) === 26, String(await page.evaluate('GLASOVI.length')));
    const tiles = await page.$$eval('#tiles .app', (els) => els.map((el) => ({
        name: el.querySelector('.app-name')?.textContent, picture: el.querySelector('img')?.naturalWidth || 0
    })));
    check('three tiles, each with its picture', tiles.length === 3 && tiles.every((t) => t.name && t.picture > 0), JSON.stringify(tiles));
    await shot('vezbi-start');

    console.log('\nthe exercises');
    await page.click('#tiles .app:nth-child(1)');
    await page.waitForSelector('#vezbi:not([hidden]) #stage button');
    check('a tile opens the exercises, and the address says so', page.url().endsWith('#vezbi'), page.url());
    await page.click('#stage button[data-v="0"]');
    await page.waitForSelector('#vezbi .card');
    await shot('vezbi-exercises');

    console.log('\nthe two tools, from the folder above');
    await page.click('#apps button[data-v="tabla"]');
    await page.waitForSelector('#tabla[data-ready="1"]', { state: 'attached', timeout: 30000 });
    check('ComuniBoard opens in its frame from the one copy', (await page.$eval('#tabla', (f) => f.src)) === `${ORIGIN}/ComuniBoard.html`,
        await page.$eval('#tabla', (f) => f.src));
    const board = await (await page.$('#tabla')).contentFrame();
    const whiteboard = await (await board.waitForSelector('#whiteboardFrame')).contentFrame();
    await whiteboard.waitForLoadState('load');
    await whiteboard.evaluate(() => {
        window.__got = [];
        window.addEventListener('message', (e) => { if (e.data && e.data.type === 'insert-generated-image') window.__got.push(String(e.data.url)); });
    });

    console.log('\na card goes to the board');
    await page.click('#apps button[data-v="vezbi"]');
    await page.waitForSelector('#vezbi:not([hidden]) .card');
    if ((await page.getAttribute('#edit', 'aria-pressed')) !== 'true') await page.click('#edit');
    await page.locator('.card button', { hasText: '➜ Во таблата' }).first().click();
    await whiteboard.waitForFunction(() => window.__got.length === 1, null, { timeout: 15000 });
    check('the card arrives on the board as a picture', (await whiteboard.evaluate(() => window.__got[0])).startsWith('data:image/png'));
    check('and the page shows the board', await page.$eval('#tabla', (f) => !f.hidden) && page.url().endsWith('#tabla'), page.url());
    check('on its „Кирилична Табла"', await board.$eval('.nav-tab.active', (b) => b.dataset.target) === 'whiteboard');
    await shot('vezbi-card-on-board');
    await page.evaluate(() => document.getElementById('tabla').contentWindow.postMessage(
        { type: 'insert-generated-image', url: 'https://example.invalid/picture.png' }, '*'));
    await page.waitForTimeout(400);
    check('an address handed in from outside is not taken', (await whiteboard.evaluate(() => window.__got.length)) === 1);

    console.log('\nWBACC Studio, and the way back');
    await page.click('#apps button[data-v="crtanje"]');
    await page.waitForSelector('#crtanje[data-ready="1"]', { state: 'attached', timeout: 60000 });
    check('WBACC Studio opens in its frame from the one copy', (await page.$eval('#crtanje', (f) => f.src)) === `${ORIGIN}/WBACC.html`);
    await page.click('#apps button[data-v="home"]');
    await page.waitForSelector('#home:not([hidden])');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash === '#crtanje');
    check('Back walks the parts instead of leaving the page', await page.$eval('#crtanje', (f) => !f.hidden));

    console.log('\na phone');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${ORIGIN}/vezbi/index.html`);
    await page.waitForSelector('#tiles .app');
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check('the start fits the width of a phone', fits);
    await shot('vezbi-phone');

    console.log('');
    check('the page asked the server for nothing its list does not have', refused.length === 0, refused.join(', '));
    check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
    await browser.close();
    await server.close();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
