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
 *   5. Back returns to the tiles, and the start fits a phone;
 *   6. on a low screen (a laptop's 1366×650 inside the browser) the controls
 *      are one row, and one card with the keyboard is whole: the picture, the
 *      boxes and 🔊 in sight, nothing scrolled, a key the size of a letter box;
 *   7. S-Дневник has ONE door to all of it, and „📓 S-Дневник" here leads back
 *      only where a server answers — never on GitHub Pages or from the disk,
 *      where the diary is a separate, empty copy;
 *   8. on ComuniBoard's board a space is a thing: marked, kept by „Порамни",
 *      made from a gap left by hand, and never in the picture or on paper;
 *   9. the board and WBACC Studio share the computer's clipboard: letters cross
 *      as text and a picture as a picture, both ways, with a plain Ctrl+V; a
 *      copy pasted back on the board is the things themselves;
 *  10. no dead ends: a tool opened alone has a way to the strip, the tiles of
 *      the Контролна табла open the strip on their own part, and from the disk
 *      the diary's link leads to the address the Контролна табла hands in —
 *      an address handed in on a public page is not believed.
 */
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
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
    // A control of the bar: in the row itself while the row holds it, else in its menu.
    const press = async (menu, selector) => {
        if (!(await page.isVisible(selector))) await page.click(`#${menu} .opener`);
        await page.click(selector);
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
    await page.waitForSelector('#vezbi:not([hidden]) #bar');
    check('a tile opens the exercises, and the address says so', page.url().endsWith('#vezbi'), page.url());
    await press('m-stage', '#stage button[data-v="0"]');
    await page.waitForSelector('#vezbi .card');
    await shot('vezbi-exercises');

    console.log('\na low screen: one row of controls, and the card in the window');
    await page.setViewportSize({ width: 1366, height: 650 });
    const rect = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
    check('the bar is one row', (await rect('#bar')).height < 60, JSON.stringify(await rect('#bar')));
    await press('m-step', '#step button[data-v="2"]');
    await page.click('#kb');
    await page.click('.card .pics');
    await page.waitForSelector('.one .card');
    check('with the keyboard on, a tap on a picture opens that card big', (await page.evaluate('state.view')) === 'one');
    const keys = await rect('#keys'), bar = await rect('#bar');
    const picture = await rect('.one .pics img'), box = await rect('.one .ltr'), sound = await rect('.one .tools button'), key = await rect('.key');
    check('the whole picture is under the bar', picture.top >= bar.bottom && picture.height >= 150, JSON.stringify(picture));
    check('the boxes and 🔊 are above the keyboard', box.bottom <= keys.top && sound.bottom <= keys.top, JSON.stringify({ box, sound, keys }));
    check('nothing scrolls', await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight
        && document.querySelector('main').scrollHeight <= document.querySelector('main').clientHeight));
    check('a key is the size of a letter box', Math.abs(key.width - box.width) < 1 && Math.abs(key.height - box.height) < 1, JSON.stringify({ key, box }));
    const first = await page.$eval('.one .drop', (b) => b.textContent);
    await page.click(`#keys [data-ch="${first}"]`);
    check('a key fills the box', (await page.$$eval('.one .ltr.got', (els) => els.length)) === 1);
    await shot('vezbi-low-screen');
    await page.evaluate(() => history.back());
    await page.waitForSelector('.cards .card');
    check('Back returns to all the cards', (await page.evaluate('state.view')) === 'grid' && page.url().endsWith('#vezbi'), page.url());
    await page.click('#kb');
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log('\nthe two tools, from the folder above');
    await page.click('#apps button[data-v="tabla"]');
    await page.waitForSelector('#tabla[data-ready="1"]', { state: 'attached', timeout: 30000 });
    check('ComuniBoard opens in its frame from the one copy', (await page.$eval('#tabla', (f) => f.src)) === `${ORIGIN}/ComuniBoard.html`,
        await page.$eval('#tabla', (f) => f.src));
    const board = await (await page.$('#tabla')).contentFrame();
    const whiteboard = await (await board.waitForSelector('#whiteboardFrame')).contentFrame();
    await whiteboard.waitForLoadState('load');
    await page.waitForSelector('#apps .sub[data-of="tabla"] button');
    check('its two tabs are in the strip here, and its own row is gone',
        (await page.$$eval('#apps .sub[data-of="tabla"] button', (els) => els.length)) === 2
        && await board.$eval('.top-nav', (n) => getComputedStyle(n).display === 'none'));
    check('the board\'s tools are one row', (await whiteboard.$eval('.main-area', (a) => a.getBoundingClientRect().top)) < 60,
        String(await whiteboard.$eval('.main-area', (a) => a.getBoundingClientRect().top)));
    check('nothing is selected: no floating bar', await whiteboard.$eval('#contextBar', (b) => b.classList.contains('hidden')));
    await page.click('#apps .sub[data-of="tabla"] button:nth-child(1)');
    await board.waitForFunction(() => document.querySelector('.nav-tab.active').dataset.target === 'card');
    await page.waitForSelector('#apps .sub[data-of="tabla"] button:nth-child(1)[aria-pressed="true"]');
    check('a tab in the strip switches the tool', await board.$eval('#panel-card', (p) => p.classList.contains('active')));
    await whiteboard.evaluate(() => {
        window.__got = [];
        window.addEventListener('message', (e) => { if (e.data && e.data.type === 'insert-generated-image') window.__got.push(String(e.data.url)); });
    });

    console.log('\na card goes to the board');
    await page.click('#apps button[data-v="vezbi"]');
    await page.waitForSelector('#vezbi:not([hidden]) .card');
    if ((await page.getAttribute('#edit', 'aria-pressed')) !== 'true') await press('m-more', '#edit');
    await page.locator('.card button', { hasText: '➜ Во таблата' }).first().click();
    await whiteboard.waitForFunction(() => window.__got.length === 1, null, { timeout: 15000 });
    check('the card arrives on the board as a picture', (await whiteboard.evaluate(() => window.__got[0])).startsWith('data:image/png'));
    check('and the page shows the board', await page.$eval('#tabla', (f) => !f.hidden) && page.url().endsWith('#tabla'), page.url());
    check('on its „Кирилична Табла"', await board.$eval('.nav-tab.active', (b) => b.dataset.target) === 'whiteboard');
    await whiteboard.waitForFunction(() => !document.getElementById('contextBar').classList.contains('hidden'));
    check('the card is selected, and its tools float over the board', await whiteboard.$eval('#deleteBtn', (b) => b.offsetParent !== null));
    await whiteboard.click('#tbMoreBtn');
    check('⋯ holds the files and the settings', await whiteboard.$eval('#saveBtn', (b) => b.offsetParent !== null)
        && await whiteboard.$eval('#tbSizeSlider', (b) => b.offsetParent !== null));
    await whiteboard.click('#boardOnlyBtn');
    await page.waitForFunction(() => document.body.classList.contains('bare'));
    check('„само табла" takes every row away: the tool\'s and this page\'s strip',
        await whiteboard.$eval('.toolbar', (n) => getComputedStyle(n).display === 'none')
        && await page.$eval('#apps', (n) => getComputedStyle(n).display === 'none'));
    await shot('vezbi-board-only');
    await whiteboard.click('#boardOnlyExit');
    await page.waitForFunction(() => !document.body.classList.contains('bare'));
    check('and one button brings them back', await whiteboard.$eval('.toolbar', (n) => getComputedStyle(n).display !== 'none'));
    await shot('vezbi-card-on-board');
    await page.evaluate(() => document.getElementById('tabla').contentWindow.postMessage(
        { type: 'insert-generated-image', url: 'https://example.invalid/picture.png' }, '*'));
    await page.waitForTimeout(400);
    check('an address handed in from outside is not taken', (await whiteboard.evaluate(() => window.__got.length)) === 1);

    console.log('\na space between words on the board');
    const row = () => whiteboard.evaluate(() => state.elements.filter((el) => el.type === 'letter')
        .sort((a, b) => a.x - b.x).map((el) => ({ id: el.id, c: el.content, x: el.x, w: el.width, size: el.fontSize })));
    const word = async () => (await row()).map((l) => l.c).join('');
    const tap = (ch) => whiteboard.locator('#keyboardBody .key', { hasText: new RegExp(`^${ch}$`) }).click();
    // Chooses letters as a rectangle or a click would, then presses the real „Порамни".
    const align = async (pick) => {
        await whiteboard.evaluate((spaces) => {
            setMode(null);
            state.selectedIds = state.elements.filter((el) => el.type === 'letter' && (spaces || el.content !== ' ')).map((el) => el.id);
            updateSelectionTools();
            renderElements();
        }, pick === 'with the spaces');
        await whiteboard.click('#alignBtn');
    };
    const mark = (media) => whiteboard.$eval('.element-space', (el) => {
        const s = getComputedStyle(el, '::after');
        return { shown: s.display !== 'none' && s.borderBottomStyle === 'solid', opacity: Number(s.opacity) };
    });
    check('the space key says what it is', await whiteboard.$eval('.key-space', (k) =>
        getComputedStyle(k, '::after').borderBottomStyle === 'solid' && k.title.length > 0));
    // The message at the bottom lies over the middle of the keyboard's last row even while nobody sees it.
    check('and no unseen message takes its taps', await whiteboard.$eval('#toast', (t) => getComputedStyle(t).pointerEvents === 'none'));
    await tap('д'); await tap('а'); await whiteboard.click('.key-space'); await tap('н'); await tap('е');
    let letters = await row();
    check('the space key puts a space between two words', await word() === 'да не', await word());
    check('a space is about a third of a letter\'s size', letters[2].w >= letters[2].size * 0.3, JSON.stringify(letters[2]));
    check('and it is marked on the board, very faintly', (await mark()).shown && (await mark()).opacity < 0.2, JSON.stringify(await mark()));
    await shot('vezbi-space');
    await align('with the spaces');
    letters = await row();
    check('„Порамни" keeps a space that is there', await word() === 'да не'
        && letters[3].x - (letters[1].x + letters[1].w) >= letters[2].w, JSON.stringify(letters));
    check('a chosen space is marked strongly', (await mark()).opacity > 0.5, JSON.stringify(await mark()));
    await align('without the spaces');
    check('a space the selection missed is still the row\'s one space', await word() === 'да не', await word());

    // A deleted space is gone: its gap closes, so „Порамни" finds no gap to turn back into a space.
    await whiteboard.evaluate(() => {
        state.selectedIds = state.elements.filter((el) => el.type === 'letter' && el.content === ' ').map((el) => el.id);
        updateSelectionTools();
        renderElements();
    });
    await whiteboard.click('#deleteBtn');
    letters = await row();
    check('a deleted space takes its gap with it', await word() === 'дане'
        && letters[2].x - (letters[1].x + letters[1].w) < letters[2].size * 0.2, JSON.stringify(letters));
    await align('without the spaces');
    check('and „Порамни" does not bring it back', await word() === 'дане', await word());

    await whiteboard.evaluate(() => {
        state.elements = state.elements.filter((el) => !(el.type === 'letter' && el.content === ' '));
        const moved = state.elements.filter((el) => el.type === 'letter').sort((a, b) => a.x - b.x).slice(2);
        for (const el of moved) el.x += 60;
    });
    check('(a gap made by hand, and no space in it)', await word() === 'дане');
    await align('without the spaces');
    letters = await row();
    check('„Порамни" turns a gap made by hand into a space', await word() === 'да не'
        && Math.abs(letters[3].x - (letters[2].x + letters[2].w)) <= letters[3].size, JSON.stringify(letters));

    await whiteboard.evaluate(() => {
        state.elements = state.elements.filter((el) => !(el.type === 'letter' && el.content === ' '));
        const all = state.elements.filter((el) => el.type === 'letter').sort((a, b) => a.x - b.x);
        let x = all[0].x;
        for (const [i, el] of all.entries()) { el.x = x; x += el.width + [20, 24, 18][i % 3]; }
    });
    await align('without the spaces');
    check('letters dropped loosely are still one word', await word() === 'дане', await word());

    // A letter dropped on the last letter of a word that already ends in a space
    // goes after the space, where it used to land on top of it.
    await whiteboard.evaluate(() => {
        const all = state.elements.filter((el) => el.type === 'letter').sort((a, b) => a.x - b.x);
        state.elements = state.elements.filter((el) => !all.slice(2).includes(el));
        const last = all[1];
        state.elements.push({ id: generateId(), type: 'letter', content: ' ', x: last.x + last.width + state.letterSpacing,
            y: last.y, fontSize: last.fontSize, width: getLetterWidth(' ', last.fontSize), color: last.color });
        renderElements();
        const box = document.getElementById('canvas').getBoundingClientRect();
        const data = new DataTransfer();
        data.setData('text/plain', JSON.stringify({ letter: 'н' }));
        document.getElementById('canvas').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data,
            clientX: box.left + last.x + last.width * 0.6, clientY: box.top + last.y + last.fontSize / 2 }));
    });
    letters = await row();
    check('a letter dropped at the end of a word sticks after its space', await word() === 'да н'
        && letters[3].x >= letters[2].x + letters[2].w, JSON.stringify(letters));

    await whiteboard.$eval('#canvas', (c) => c.classList.add('exporting'));
    check('the saved picture has no mark', !(await mark()).shown);
    await whiteboard.$eval('#canvas', (c) => c.classList.remove('exporting'));
    await page.emulateMedia({ media: 'print' });
    check('nor has the printed board', !(await mark()).shown);
    await page.emulateMedia({ media: null });

    console.log('\nWBACC Studio, and the way back');
    await page.click('#apps button[data-v="crtanje"]');
    await page.waitForSelector('#crtanje[data-ready="1"]', { state: 'attached', timeout: 60000 });
    check('WBACC Studio opens in its frame from the one copy', (await page.$eval('#crtanje', (f) => f.src)) === `${ORIGIN}/WBACC.html`);
    await page.click('#apps button[data-v="home"]');
    await page.waitForSelector('#home:not([hidden])');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash === '#crtanje');
    check('Back walks the parts instead of leaving the page', await page.$eval('#crtanje', (f) => !f.hidden));

    console.log('\ncopy and paste between the board and WBACC Studio');
    // One clipboard, the computer's: what is copied in one tool is pasted in the other with a plain Ctrl+V.
    const studio = await (await page.$('#crtanje')).contentFrame();
    const part = async (name) => { await page.click(`#apps button[data-v="${name}"]`); await page.waitForSelector(`#${name}:not([hidden])`); };
    const boardSpot = () => whiteboard.click('#canvas', { position: { x: 900, y: 420 } });
    const studioSpot = async () => {
        const box = await (await studio.waitForSelector('canvas.interactive')).boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    // What the Studio holds, read the way a person would hand it on: select all, copy.
    const studioCopy = async () => {
        await studioSpot();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Control+C');
        await page.waitForTimeout(300);
        return JSON.parse(await studio.evaluate(() => navigator.clipboard.readText()));
    };
    const count = (type) => whiteboard.evaluate((t) => state.elements.filter((el) => el.type === t).length, type);

    await part('tabla');
    await whiteboard.evaluate(() => {
        setMode(null);
        state.selectedIds = state.elements.filter((el) => el.type === 'letter').map((el) => el.id);
        updateSelectionTools();
        renderElements();
    });
    const sentence = await word();
    await whiteboard.click('#copyBtn');
    check('letters copied on the board are text on the computer\'s clipboard',
        (await whiteboard.evaluate(() => navigator.clipboard.readText())) === sentence, await whiteboard.evaluate(() => navigator.clipboard.readText()));
    const before = await count('letter');
    await boardSpot();
    await page.keyboard.press('Control+V');
    await whiteboard.waitForFunction((n) => state.elements.filter((el) => el.type === 'letter').length > n, before);
    check('pasted back on the board they are the same letters, a step aside, and chosen',
        (await count('letter')) === before * 2 && (await whiteboard.evaluate(() => state.selectedIds.length)) === before
        && await whiteboard.evaluate(() => { const l = state.elements.filter((el) => el.type === 'letter'); return l[l.length - 1].y === l[l.length / 2 - 1].y + 30; }));

    await part('crtanje');
    await studioSpot();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(600);
    let scene = await studioCopy();
    check('in the Studio the same copy is pasted as text', scene.elements.some((el) => el.type === 'text' && el.text === sentence),
        JSON.stringify(scene.elements.map((el) => [el.type, el.text])));

    await part('tabla');
    await whiteboard.evaluate(() => { state.elements = state.elements.filter((el) => el.type !== 'letter'); state.selectedIds = []; renderElements(); });
    await boardSpot();
    await page.keyboard.press('Control+V');
    await whiteboard.waitForFunction(() => state.elements.some((el) => el.type === 'letter'));
    check('text copied in the Studio lands on the board as letters, with its space', await word() === sentence, await word());
    check('and they are chosen, ready to be moved', (await whiteboard.evaluate(() => state.selectedIds.length)) === Array.from(sentence).length);

    const boardPicture = await whiteboard.evaluate(() => {
        const el = state.elements.find((item) => item.type === 'image');
        state.selectedIds = [el.id];
        updateSelectionTools();
        renderElements();
        return { x: el.x, width: el.width };
    });
    await whiteboard.click('#copyBtn');
    await whiteboard.waitForFunction(() => window._wbClipboard.pictureOut === true && document.hasFocus());
    const types = await whiteboard.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types));
    check('a picture copied on the board is a picture on the computer\'s clipboard', types.includes('image/png'), types.join(', '));
    await boardSpot();
    await page.keyboard.press('Control+V');
    await whiteboard.waitForFunction(() => state.elements.filter((el) => el.type === 'image').length === 2);
    check('pasted back on the board it is the same picture, its size kept', await whiteboard.evaluate((p) => {
        const copy = state.elements.filter((el) => el.type === 'image')[1];
        return copy.x === p.x + 30 && copy.width === p.width;
    }, boardPicture));

    await part('crtanje');
    await studioSpot();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(1200);
    scene = await studioCopy();
    check('in the Studio the same copy is pasted as a picture',
        scene.elements.some((el) => el.type === 'image') && Object.keys(scene.files || {}).length > 0, JSON.stringify(scene.elements.map((el) => el.type)));

    await part('tabla');
    await boardSpot();
    await page.keyboard.press('Control+V');
    await whiteboard.waitForFunction(() => state.elements.filter((el) => el.type === 'image').length === 3, null, { timeout: 15000 });
    check('a picture copied in the Studio lands on the board', (await count('image')) === 3);
    check('with the Studio\'s text beside it', (await count('letter')) === Array.from(sentence).length * 2, String(await count('letter')));
    await shot('vezbi-copy-paste');
    const typed = await count('letter');
    await whiteboard.click('#pasteImageBtn');
    await whiteboard.waitForFunction((n) => state.elements.filter((el) => el.type === 'letter').length > n, typed);
    check('the paste button does what Ctrl+V does, for a board without a keyboard', (await count('image')) >= 3);
    // Opened from the disk every page is an address of its own, and a frame may use the clipboard only when it is told so by name.
    check('the frames are given the clipboard, from the disk too',
        (await page.$$eval('#tabla, #crtanje', (frames) => frames.every((f) => /clipboard-write \*/.test(f.allow))))
        && await board.$eval('#whiteboardFrame', (f) => /clipboard-write \*/.test(f.allow)));
    await part('crtanje');

    console.log('\na phone');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${ORIGIN}/vezbi/index.html`);
    await page.waitForSelector('#tiles .app');
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check('the start fits the width of a phone', fits);
    await shot('vezbi-phone');
    await page.click('#tiles .app:nth-child(1)');
    await page.waitForSelector('#vezbi:not([hidden]) #bar');
    await press('m-stage', '#stage button[data-v="0"]');
    await page.click('#view button[data-v="one"]');
    await page.waitForSelector('.one .card');
    check('the exercises fit it too, the bar in two rows at most',
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && (await page.$eval('#bar', (b) => b.offsetHeight)) < 100);
    await shot('vezbi-phone-card');

    console.log('\nthe diary\'s door, and the way back');
    check('without a server that answers there is no link to the diary', (await page.$('#apps .diary')) === null);
    // The door as S-Dnevnik.html really has it, in a page that stands for the diary;
    // and a server that says it is there, as the local one and the cloud do.
    const door = /<a class="tab" href="vezbi\/index\.html"[^>]*>[^<]*<\/a>/.exec(await readFile(join(ROOT, 'S-Dnevnik.html'), 'utf8'));
    check('S-Дневник has one door to the exercises, and it keeps its opener', Boolean(door) && /target="_blank" rel="opener"/.test(door[0]),
        door ? door[0] : 'no door');
    let cloud = false;
    await context.route(`${ORIGIN}/api/health`, (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(cloud ? { ok: true, cloudAuth: 'google' } : { ok: true }) }));
    await context.route(`${ORIGIN}/S-Dnevnik.html`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><title>дневник</title>${door ? door[0] : ''}` }));
    const diary = await context.newPage();
    await diary.setViewportSize({ width: 1280, height: 800 });
    await diary.goto(`${ORIGIN}/S-Dnevnik.html`);
    const [opened] = await Promise.all([context.waitForEvent('page'), diary.click('a.tab')]);
    await opened.waitForSelector('#apps .diary');
    check('the door opens the three tiles', opened.url() === `${ORIGIN}/vezbi/index.html` && (await opened.$$eval('#tiles .app', (els) => els.length)) === 3, opened.url());
    check('with a server the strip has „📓 S-Дневник", to the diary of this server',
        (await opened.$eval('#apps .diary', (a) => a.href)) === `${ORIGIN}/S-Dnevnik.html`, await opened.$eval('#apps .diary', (a) => a.href));
    await opened.click('#tiles .app:nth-child(1)');
    check('and keeps it from one part to the next', await opened.isVisible('#apps .diary'));
    // The click closes the tab it is made in; when the tab goes first, the click has nothing to report to.
    await Promise.all([opened.waitForEvent('close'), opened.click('#apps .diary').catch(() => {})]);
    check('opened from the diary, it closes itself: back in the diary as it was left', opened.isClosed() && !diary.isClosed() && diary.url() === `${ORIGIN}/S-Dnevnik.html`);
    cloud = true;
    await diary.goto(`${ORIGIN}/vezbi/index.html`);
    await diary.waitForSelector('#apps .diary');
    check('in the cloud it leads to the diary inside the work space',
        (await diary.$eval('#apps .diary', (a) => a.href)) === `${ORIGIN}/MTB-Workspace.html?app=S-Dnevnik.html`, await diary.$eval('#apps .diary', (a) => a.href));
    await diary.close();
    await page.goto(`${ORIGIN}/vezbi/index.html?oblak=https%3A%2F%2Fexample.invalid`);
    await page.waitForSelector('#tiles .app');
    await page.waitForSelector('#apps .diary');
    check('an address handed in on a public page is not believed: the link still leads to this server',
        (await page.$$eval('#apps .diary', (links) => links.map((a) => a.href))).join() === `${ORIGIN}/MTB-Workspace.html?app=S-Dnevnik.html`);

    console.log('\nfrom the disk: no dead ends, and the way to the diary');
    // Opened from the disk, as the Контролна табла opens them. A context of its own: this one refuses every other address.
    const local = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await local.route((url) => url.protocol !== 'file:', (route) => route.abort());
    const fileUrl = (...parts) => pathToFileURL(join(ROOT, ...parts)).href;
    const disk = await local.newPage();
    await disk.goto(fileUrl('vezbi', 'index.html') + '#tabla');
    await disk.waitForSelector('#tabla[data-ready="1"]', { state: 'attached', timeout: 30000 });
    check('from the disk, with no address handed in, there is no link to the diary', (await disk.$('#apps .diary')) === null);
    await disk.goto(fileUrl('vezbi', 'index.html') + '?oblak=https%3A%2F%2Fexample.invalid#crtanje');
    await disk.waitForSelector('#apps .diary');
    check('the Контролна табла hands in the cloud\'s address, and „📓 S-Дневник" leads to the work space there',
        (await disk.$eval('#apps .diary', (a) => a.href)) === 'https://example.invalid/MTB-Workspace.html?app=S-Dnevnik.html', await disk.$eval('#apps .diary', (a) => a.href));
    check('and the page opens on the part it was asked for', await disk.$eval('#crtanje', (f) => !f.hidden));
    await disk.goto(fileUrl('vezbi', 'index.html'));
    await disk.waitForSelector('#apps .diary');
    check('a double-click later still knows it', (await disk.$eval('#apps .diary', (a) => a.href)).startsWith('https://example.invalid/'));
    await disk.goto(fileUrl('vezbi', 'index.html') + '?oblak=http%3A%2F%2Fexample.invalid');
    await disk.waitForSelector('#apps .diary');
    check('only an https address is taken', (await disk.$eval('#apps .diary', (a) => a.href)).startsWith('https://example.invalid/'));

    await disk.goto(fileUrl('ComuniBoard.html'));
    const out = await disk.waitForSelector('.top-nav .nav-out');
    check('ComuniBoard opened alone has a way to the strip, on its own part',
        (await out.getAttribute('href')) === 'vezbi/index.html#tabla' && await out.isVisible());
    await out.click();
    await disk.waitForSelector('#tabla[data-ready="1"]', { state: 'attached', timeout: 30000 });
    check('which opens the exercise page with ComuniBoard in it', disk.url().endsWith('/vezbi/index.html#tabla') && await disk.$eval('#tabla', (f) => !f.hidden), disk.url());
    await disk.goto(fileUrl('WBACC.html'));
    const studioOut = await disk.waitForSelector('.wbacc-tools .wbacc-out', { timeout: 60000 });
    check('WBACC Studio opened alone has one too', (await studioOut.getAttribute('href')) === 'vezbi/index.html#crtanje' && await studioOut.isVisible());
    await studioOut.click();
    await disk.waitForSelector('#crtanje[data-ready="1"]', { state: 'attached', timeout: 60000 });
    const framed = await (await disk.$('#crtanje')).contentFrame();
    await framed.waitForSelector('.wbacc-tools');
    check('and inside the strip neither tool shows the link again', (await framed.$('.wbacc-out')) === null);
    await local.close();

    // The Контролна табла's three tiles of „Вежби": one page, three parts. Read from the list itself.
    const launcherTiles = [...(await readFile(join(ROOT, 'scripts', 'mtb-actions.ps1'), 'utf8')).matchAll(/Tab = 'practice'[^\n]*File = '([^']+)'; Part = '([^']+)'/g)]
        .map((m) => m[1] + '#' + m[2]);
    check('each tile of the Контролна табла opens the page with the strip, on its own part',
        launcherTiles.join(' ') === 'vezbi\\index.html#vezbi vezbi\\index.html#tabla vezbi\\index.html#crtanje', launcherTiles.join(' '));

    console.log('');
    check('the page asked the server for nothing its list does not have', refused.length === 0, refused.join(', '));
    check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
    await browser.close();
    await server.close();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
