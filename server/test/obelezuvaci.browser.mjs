/**
 * Обележувачи (Obelezuvaci.html) in a browser: the administrator's bookmarks
 * as a page of their own. Every call to the MTB server is invented here, so
 * nothing reaches a database, and any request the test did not invent fails
 * the run — the page asks nobody but its own server and the bookmarked sites.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const ORIGIN = 'http://obelezuvaci.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FILES = { '/Obelezuvaci.html': 'text/html; charset=utf-8', '/mtb-theme.js': 'application/javascript', '/mtb-look.css': 'text/css' };

let fails = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '\n       ' + detail : ''}`);
    if (!ok) fails++;
};
const shots = process.env.SHOT;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name + '.png') }); };

const seed = () => ({
    boards: [{ id: 'b1', name: 'Логопедија', order: 1 }, { id: 'b2', name: 'Музика', order: 2 }],
    columnsByBoard: { b1: [{ id: 'c1', name: 'Општо', order: 1 }, { id: 'c2', name: 'Видеа', order: 2 }], b2: [{ id: 'c3', name: 'Општо', order: 1 }] },
    cards: [
        { id: 'k1', boardId: 'b1', columnId: 'c1', url: 'https://example.org/vezbi', title: 'Вежби за дишење', tags: ['дишење', 'вежби'], notes: 'За почеток на час', pinned: false, order: 1, createdAt: 1, updatedAt: 1 },
        { id: 'k2', boardId: 'b1', columnId: 'c2', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Песна за гласот Р', tags: ['вежби'], notes: '', pinned: true, order: 2, createdAt: 2, updatedAt: 2 },
        { id: 'k3', boardId: 'b2', columnId: 'c3', url: 'https://example.net/pesni', title: 'Детски песни', tags: [], notes: '', pinned: false, order: 3, createdAt: 3, updatedAt: 3 }
    ]
});

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const unexpected = [];

/** One invented server per context: who it lets in, what it holds. */
async function world({ mode = 'owner', doc = seed(), revision = 4, viewport = { width: 1366, height: 900 } } = {}) {
    const server = { mode, signedIn: false, doc, revision, puts: [], down: false };
    const context = await browser.newContext({ viewport });
    const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.origin === ORIGIN) {
            if (FILES[url.pathname]) return route.fulfill({ status: 200, contentType: FILES[url.pathname], body: readFileSync(join(ROOT, url.pathname.slice(1))) });
            if (url.pathname === '/MTB-Workspace.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>workspace</title>' });
            if (server.down && url.pathname.startsWith('/api/')) return route.abort();
            if (url.pathname === '/api/evidence/people') return json(route, 200, { people: [{ kind: 'therapist', id: 9, name: 'Измислен Автор' }] });
            if (url.pathname === '/api/evidence/login') { server.signedIn = true; return json(route, 200, { token: 'invented', person: { name: 'Измислен Автор' } }); }
            if (url.pathname === '/api/bookmarks') {
                // 'pin': a server that asks for the administrator's PIN; 'owner': the cloud, where the Google sign-in is enough.
                if (server.mode === 'pin' && !server.signedIn) return json(route, 401, { error: 'not signed in', signedOut: true });
                if (server.mode === 'expired') return json(route, 401, { error: 'Authentication required' });
                if (method === 'GET') return json(route, 200, { doc: server.doc, revision: server.revision });
                const body = route.request().postDataJSON();
                server.puts.push(body);
                if (body.expected !== server.revision) return json(route, 409, { error: 'Сменети од друго место.', reason: 'stale', revision: server.revision });
                server.doc = body.doc;
                server.revision += 1;
                return json(route, 200, { ok: true, revision: server.revision });
            }
        }
        // A bookmarked site's own icon, and a video's picture: invented, so the run needs no Internet.
        if (url.pathname === '/favicon.ico' || url.hostname === 'img.youtube.com') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        unexpected.push(url.href.slice(0, 100));
        return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.stack || e).slice(0, 400)));
    const dialogs = [];
    let answer = () => true;
    page.on('dialog', (d) => { dialogs.push(d.message()); const a = answer(d); if (a === false) d.dismiss(); else d.accept(typeof a === 'string' ? a : undefined); });
    return { server, context, page, errors, dialogs, reply: (fn) => { answer = fn; } };
}
const titles = (page) => page.$$eval('.card .title', (n) => n.map((x) => x.textContent));
// WCAG contrast of an element's own text on the first opaque background behind it.
const contrast = (page, selector) => page.$eval(selector, (el) => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    let node = el, bg = 'rgba(0, 0, 0, 0)';
    while (node && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)) { bg = getComputedStyle(node).backgroundColor; node = node.parentElement; }
    const a = lum(getComputedStyle(el).color), b = lum(bg);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});

try {
    console.log('the owner already signed in (the cloud): no second sign-in');
    let w = await world();
    let { page, server } = w;
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('.card');
    check('the page opens with the stored bookmarks and asks for no PIN', (await titles(page)).length === 3 && (await page.$('#gate')) === null);
    check('its browser tab carries the app\'s name', (await page.title()) === 'Обележувачи — MTB');
    check('collections with their counts on the left',
        JSON.stringify(await page.$$eval('#boards .shelf', (n) => n.map((x) => x.textContent))) === JSON.stringify(['🗂 Логопедија2', '🗂 Музика1']));
    check('tags with their counts, the most used first',
        JSON.stringify(await page.$$eval('#tags .shelf', (n) => n.map((x) => x.textContent))) === JSON.stringify(['#вежби2', '#дишење1']));
    // Playwright never lets a favicon.ico request through, so here the icon always
    // fails — which is the case that has to look right: the letter stays, no broken picture.
    check('a video shows its picture; a site whose icon does not load keeps its letter',
        (await page.$eval('[data-id="k2"] .cover img', (i) => i.src)).startsWith('https://img.youtube.com/vi/abcdefghijk/')
        && (await page.textContent('[data-id="k1"] .cover .letter')) === 'В' && (await page.$('[data-id="k1"] .cover img')) === null);
    check('a link opens in a new tab, without handing this page over',
        await page.$eval('[data-id="k1"] a.title', (a) => a.target === '_blank' && a.rel === 'noopener noreferrer' && a.href === 'https://example.org/vezbi'));
    check('opening changed nothing on the server', server.puts.length === 0);
    await shot(page, 'grid-light');

    console.log('\nshelves are steps in the browser\'s history');
    await page.click('#boards .shelf >> nth=0');
    await page.waitForSelector('.group');
    check('a collection shows its groups', JSON.stringify(await page.$$eval('.group h3', (n) => n.map((x) => x.textContent))) === JSON.stringify(['Општо 1', 'Видеа 1']));
    await page.click('#shelves .shelf >> nth=1');
    await page.waitForFunction(() => document.querySelector('#heading h2').textContent.includes('Омилени'));
    check('⭐ Омилени shows only the starred', JSON.stringify(await titles(page)) === JSON.stringify(['Песна за гласот Р']));
    await page.click('.card .chip:has-text("#вежби")');
    await page.waitForFunction(() => document.querySelector('#heading h2').textContent.startsWith('#'));
    check('a tag on a card opens that tag', (await page.textContent('#heading h2')).startsWith('#вежби') && (await titles(page)).length === 2);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.querySelector('#heading h2').textContent.includes('Омилени'));
    check('Back returns to the shelf before', true);
    await page.reload();
    await page.waitForSelector('.card');
    check('a reload keeps the shelf', (await page.textContent('#heading h2')).includes('Омилени'));
    await page.click('#shelves .shelf >> nth=0');
    await page.fill('#search', 'ДИШЕЊЕ');
    check('search reads title, link, tag and note, whatever the case', JSON.stringify(await titles(page)) === JSON.stringify(['Вежби за дишење']));
    await page.fill('#search', '');

    console.log('\nadding, changing, removing — each saved over the revision it started from');
    await page.click('#addCard');
    await page.fill('#fUrl', 'example.com/nov');
    await page.fill('#fTags', '#игри, игри, слики');
    await page.selectOption('#fBoard', 'b2');
    await page.click('#editorSave');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    let put = server.puts.at(-1);
    let added = put.doc.cards.find((c) => c.url === 'https://example.com/nov');
    check('a new bookmark: https added, the title taken from the site, tags once each',
        Boolean(added) && added.title === 'example.com' && JSON.stringify(added.tags) === JSON.stringify(['игри', 'слики']) && added.boardId === 'b2' && added.columnId === 'c3',
        JSON.stringify(added));
    check('the save named the revision it started from', put.expected === 4 && server.revision === 5);
    check('the document keeps only the stored shape', JSON.stringify(Object.keys(added).sort()) === JSON.stringify(['boardId', 'columnId', 'createdAt', 'id', 'notes', 'order', 'pinned', 'tags', 'title', 'updatedAt', 'url']));
    await page.click('#addCard');
    await page.fill('#fUrl', 'javascript:alert(1)');
    w.dialogs.length = 0;
    await page.click('#editorSave');
    check('a link that is not http(s) is refused', w.dialogs.some((d) => d.includes('http')) && await page.$eval('#editor', (d) => d.open));
    await page.click('#editorCancel');
    await page.click('[data-id="k3"] .fav');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('the star marks a favourite', server.doc.cards.find((c) => c.id === 'k3').pinned === true);
    await page.click('[data-id="k1"] .edit');
    await page.fill('#fTitle', 'Вежби за дишење — нови');
    await page.click('#editorSave');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('✏️ Уреди changes the same bookmark', server.doc.cards.find((c) => c.id === 'k1').title === 'Вежби за дишење — нови' && server.doc.cards.length === 4);
    await page.evaluate(() => { const d = new DataTransfer(); d.setData('text', 'https://example.org/zalepen'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); });
    check('a pasted link opens the form with it', await page.$eval('#editor', (d) => d.open) && (await page.inputValue('#fUrl')) === 'https://example.org/zalepen');
    await page.click('#editorCancel');
    await page.dragAndDrop('[data-id="k3"] .body', '#boards .shelf >> nth=0');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('a card dragged onto a collection moves into its first group',
        server.doc.cards.find((c) => c.id === 'k3').boardId === 'b1' && server.doc.cards.find((c) => c.id === 'k3').columnId === 'c1');
    await page.click('[data-id="k3"] .del');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('Избриши asks, then removes only that one', w.dialogs.some((d) => d.includes('Детски песни')) && server.doc.cards.length === 3 && !server.doc.cards.some((c) => c.id === 'k3'));

    console.log('\ncollections and groups');
    w.reply((d) => (d.type() === 'prompt' ? 'Читање' : true));
    await page.click('#addBoard');
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('+ Додај makes a collection with its first group and opens it',
        server.doc.boards.some((b) => b.name === 'Читање') && (await page.textContent('#heading h2')).includes('Читање')
        && server.doc.columnsByBoard[server.doc.boards.find((b) => b.name === 'Читање').id].length === 1);
    w.dialogs.length = 0;
    await page.click('#boards .shelf >> nth=0');
    await page.click('#deleteBoard');
    check('a collection that still holds bookmarks is not deleted', w.dialogs.some((d) => d.includes('прво премести')) && server.doc.boards.length === 3);
    await page.click('#viewList');
    check('☰ Листа shows the same cards as rows, and the choice is this browser\'s',
        await page.$eval('.cards', (n) => n.classList.contains('list')) && (await page.evaluate(() => JSON.parse(localStorage.getItem('mtb_obelezuvaci_look_v1')).view)) === 'list');
    await shot(page, 'list-light');
    await page.click('#viewGrid');

    console.log('\nboth themes read');
    for (const theme of ['light', 'dark']) {
        if (theme === 'dark') await page.click('#theme');
        for (const [what, sel] of [['a card title', '.card .title'], ['its site', '.card .host'], ['a tag', '.card .chip'], ['a shelf', '#tags .shelf'],
            ['the chosen shelf', '.shelf[aria-current="true"]'], ['a count', '#tags .shelf .n'], ['a group button', '.group .btn'], ['deleting a group', '.group .btn.del'], ['the status', '#status'], ['Избриши', '.card .del']]) {
            const ratio = await contrast(page, sel);
            check(`${theme}: ${what} reads (${ratio.toFixed(1)}:1)`, ratio >= 4.5);
        }
        await shot(page, 'collection-' + theme);
    }
    check('no script error', w.errors.length === 0, w.errors.join('\n'));
    await w.context.close();

    console.log('\na server that asks for the administrator\'s PIN');
    w = await world({ mode: 'pin' });
    ({ page, server } = w);
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('#gate');
    check('nothing is shown and nothing can be changed before the sign-in', await page.isHidden('#shell') && (await page.textContent('#notice')).includes('PIN'));
    await page.fill('#gate input[name=pin]', '0000');
    await page.click('#gate button');
    await page.waitForSelector('.card');
    check('after it the bookmarks open, and the notice is gone', (await titles(page)).length === 3 && await page.isHidden('#notice'));
    await w.context.close();

    console.log('\nthe owner\'s sign-in ran out');
    w = await world({ mode: 'expired' });
    ({ page, server } = w);
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('#notice a');
    check('the page says so and offers the way back in, not a PIN', (await page.getAttribute('#notice a', 'href')) === 'auth/login' && (await page.$('#gate')) === null && await page.isHidden('#shell'));
    await w.context.close();

    console.log('\nan empty page never overwrites what is stored');
    w = await world();
    ({ page, server } = w);
    server.down = true;
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('#notice button');
    check('with no answer from the server there is nothing to edit', await page.isHidden('#shell') && server.puts.length === 0);
    server.down = false;
    await page.click('#notice button');
    await page.waitForSelector('.card');
    check('↻ reads them once the server answers', (await titles(page)).length === 3 && server.puts.length === 0);

    console.log('\na change the server did not confirm waits in this browser');
    server.down = true;
    await page.click('[data-id="k1"] .fav');
    await page.waitForFunction(() => /чека сервер/.test(document.getElementById('status').textContent));
    check('it says it is kept here only', (await page.evaluate(() => JSON.parse(localStorage.getItem('mtb_obelezuvaci_draft_v1')).revision)) === 4);
    server.down = false;
    await page.reload();
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('after a reload it is sent, over the same revision', server.puts.at(-1).expected === 4 && server.doc.cards.find((c) => c.id === 'k1').pinned === true
        && (await page.evaluate(() => localStorage.getItem('mtb_obelezuvaci_draft_v1'))) === null);

    console.log('\nanother computer saved in between: the person decides');
    server.revision = 9;
    server.doc = { ...seed(), cards: seed().cards.slice(0, 1) };
    await page.click('[data-id="k2"] .fav');
    await page.waitForSelector('#takeServer');
    check('the save is refused and nothing is merged', server.revision === 9 && server.doc.cards.length === 1);
    w.dialogs.length = 0;
    await page.click('[data-id="k2"] .edit');
    check('no further change until the choice is made', w.dialogs.some((d) => d.includes('одлучи')) && !(await page.$eval('#editor', (d) => d.open)));
    await page.click('#takeServer');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    check('⬇ takes the server\'s and writes nothing', server.revision === 9 && await page.isHidden('#notice')
        && (await page.evaluate(() => localStorage.getItem('mtb_obelezuvaci_draft_v1'))) === null);
    check('no script error', w.errors.length === 0, w.errors.join('\n'));
    await w.context.close();

    console.log('\nreserve and the browser\'s own export');
    w = await world();
    ({ page, server } = w);
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('.card');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportFile')]);
    const reserve = JSON.parse(readFileSync(await download.path(), 'utf8'));
    check('📤 writes the whole document as one file', reserve.cards.length === 3 && /^obelezuvaci-\d{4}-\d\d-\d\d\.json$/.test(download.suggestedFilename()));
    await page.setInputFiles('#importHtml', { name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(
        '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Лента</H3><DL><p>'
        + '<DT><A HREF="https://example.org/a" ADD_DATE="1700000000">Прва</A>'
        + '<DT><H3>Вежби</H3><DL><p><DT><A HREF="https://example.org/b">Втора</A></DL><p>'
        + '<DT><A HREF="javascript:alert(1)">Лоша</A></DL><p></DL>') });
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent) && document.querySelectorAll('#boards .shelf').length === 3);
    const fromBrowser = server.doc.boards.at(-1);
    check('a browser\'s HTML export is ADDED as one collection, a group per folder, only http(s) links',
        server.doc.cards.length === 5 && JSON.stringify(server.doc.columnsByBoard[fromBrowser.id].map((c) => c.name)) === JSON.stringify(['Лента', 'Лента / Вежби'])
        && server.doc.cards.find((c) => c.title === 'Прва').createdAt === 1700000000000);
    await page.setInputFiles('#importJson', { name: 'reserve.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reserve)) });
    await page.waitForFunction(() => document.querySelectorAll('#boards .shelf').length === 2);
    await page.waitForFunction(() => /✓ Зачувано/.test(document.getElementById('status').textContent));
    check('♻️ a reserve replaces everything, after asking', w.dialogs.some((d) => d.includes('ЗАМЕНУВААТ')) && server.doc.cards.length === 3);
    w.dialogs.length = 0;
    await page.setInputFiles('#importJson', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"not":"bookmarks"}') });
    await page.waitForTimeout(200);
    check('a file that is not a reserve changes nothing', w.dialogs.some((d) => d.includes('не е резерва')) && server.doc.cards.length === 3);
    check('no script error', w.errors.length === 0, w.errors.join('\n'));
    await w.context.close();

    console.log('\na phone');
    w = await world({ viewport: { width: 390, height: 780 } });
    ({ page } = w);
    await page.goto(`${ORIGIN}/Obelezuvaci.html`);
    await page.waitForSelector('.card');
    check('nothing runs off the side of the screen', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await shot(page, 'phone');
    await w.context.close();

    check('the page asked nobody the test did not invent', unexpected.length === 0, unexpected.join('\n'));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
