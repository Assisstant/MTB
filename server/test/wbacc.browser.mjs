/**
 * WBACC Studio (WBACC.html, built from wbacc/) in a browser. Every call to the
 * MTB server and to ARASAAC is invented here: nothing reaches a database, and
 * nothing needs the Internet — which is also how the offline promise is
 * checked: any request the test did not invent fails the run.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const ORIGIN = 'http://wbacc.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let fails = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '\n       ' + detail : ''}`);
    if (!ok) fails++;
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const unexpected = [];
const server = { signedIn: false, doc: null, revision: 0, puts: [], stale: false };
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.origin === ORIGIN) {
        if (url.pathname === '/WBACC.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: readFileSync(join(ROOT, 'WBACC.html')) });
        if (url.pathname === '/api/health') return json(route, 200, { ok: true, author: 'Измислен Автор' });
        if (url.pathname === '/api/evidence/people') return json(route, 200, { people: [{ kind: 'therapist', id: 9, name: 'Измислен Автор' }] });
        if (url.pathname === '/api/evidence/login') { server.signedIn = true; return json(route, 200, { token: 'invented', person: { name: 'Измислен Автор' } }); }
        if (url.pathname === '/api/bookmarks') {
            if (!server.signedIn) return json(route, 403, { error: 'Обележувачите се лични: ги гледа и менува само администраторот.', needsAdmin: true });
            if (method === 'GET') return json(route, 200, { doc: server.doc, revision: server.revision });
            const body = route.request().postDataJSON();
            server.puts.push(body);
            if (server.stale || body.expected !== server.revision) return json(route, 409, { error: 'Сменети од друго место.', reason: 'stale', revision: server.revision });
            server.doc = body.doc;
            server.revision += 1;
            return json(route, 200, { ok: true, revision: server.revision });
        }
    }
    if (url.hostname === 'api.arasaac.org') return json(route, 200, [{ _id: 2317, keywords: [{ keyword: 'куќа' }] }]);
    // Pictures that only an online browser shows: invented, so the run needs no Internet.
    if (url.hostname === 'static.arasaac.org' || url.hostname === 'img.youtube.com') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    unexpected.push(url.href.slice(0, 100));
    return route.abort();
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('dialog', (d) => d.accept());
await page.goto(`${ORIGIN}/WBACC.html`);
await page.waitForSelector('.excalidraw', { timeout: 20000 });

console.log('WBACC Studio — Excalidraw, one file, offline');
check('the canvas opens from the one file', await page.isVisible('.excalidraw'));
check('with the author\'s watermark', (await page.textContent('.mtb-credit').catch(() => '')) === 'изработил Измислен Автор');

console.log('\nlanguage: English by default, Macedonian on request');
check('English by default — Excalidraw\'s tools and WBACC\'s own buttons',
    await page.getAttribute('[data-testid="toolbar-rectangle"]', 'aria-label') === 'Rectangle'
        && await page.isVisible('button:has-text("Pictograms")'));
await page.click('.dropdown-menu-button');
check('the menu offers exactly English and Macedonian',
    JSON.stringify(await page.$$eval('.wbacc-lang option', (o) => o.map((x) => x.value))) === JSON.stringify(['en', 'mk-MK']));
await page.selectOption('.wbacc-lang', 'mk-MK');
await page.waitForFunction(() => document.querySelector('[data-testid="toolbar-rectangle"]')?.getAttribute('aria-label') === 'Правоаголник', null, { timeout: 5000 }).catch(() => {});
await page.keyboard.press('Escape');
check('Macedonian: Excalidraw\'s own tools in our translation, and WBACC\'s buttons',
    await page.getAttribute('[data-testid="toolbar-rectangle"]', 'aria-label') === 'Правоаголник'
        && await page.isVisible('button:has-text("Пиктограми")'));
check('and what is not translated falls back to English, never to a key',
    !(await page.textContent('body')).match(/\b(toolBar|labels|buttons)\.[a-zA-Z]+/));

const scene = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('wbacc-studio');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('scene-v1'); g.onsuccess = () => res(((g.result && g.result.elements) || []).filter((e) => !e.isDeleted)); };
}));

console.log('\n🖼 pictograms');
await page.click('button:has-text("Пиктограми")');
await page.fill('.wbacc-panel input[type=search]', 'куќа');
await page.click('.wbacc-panel button:has-text("Барај")');
await page.waitForSelector('.wbacc-picto', { timeout: 5000 }).catch(() => {});
await page.click('.wbacc-picto');
check('a pictogram offers its word for the card', await page.inputValue('.wbacc-card-form input:not([type])') === 'Куќа');
await page.click('button:has-text("Во цртежот")');
await page.waitForTimeout(1500);
const card = await scene();
const picture = card.find((e) => e.type === 'image');
const word = card.find((e) => e.type === 'text');
check('the card is a picture with its word, one group', Boolean(picture && word && word.text === 'Куќа'
    && picture.groupIds.length && picture.groupIds[0] === word.groupIds[0]), JSON.stringify(card.map((e) => e.type)));
check('and the word stands under the picture', Boolean(picture && word && word.y > picture.y + picture.height - 1));

console.log('\n🔖 bookmarks — only the administrator, a copy kept offline');
await page.click('button:has-text("Обележувачи")');
await page.waitForSelector('.wbacc-gate', { timeout: 5000 }).catch(() => {});
check('without the administrator\'s sign-in the panel asks for it', await page.isVisible('.wbacc-gate'));
server.doc = { boards: [{ id: 'b1', name: 'Школо', order: 1 }], columnsByBoard: { b1: [{ id: 'k1', name: 'Видеа', order: 1 }] },
    cards: [{ id: 'c1', boardId: 'b1', columnId: 'k1', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Песна', tags: ['музика'], notes: '', pinned: false, order: 1, createdAt: 1, updatedAt: 1 }] };
server.revision = 3;
await page.fill('.wbacc-gate input[name=pin]', '0000');
await page.click('.wbacc-gate button');
await page.waitForSelector('.wbacc-bm', { timeout: 5000 }).catch(() => {});
check('signed in, the server\'s bookmarks show', (await page.textContent('.wbacc-bm').catch(() => '')).includes('Песна'));
await page.click('.wbacc-col header button[title="Нова картичка"]');
await page.fill('.wbacc-edit label:has-text("Линк") input', 'example.org/lekcija');
await page.fill('.wbacc-edit label:has-text("Наслов") input', 'Лекција');
await page.click('.wbacc-edit button:has-text("Зачувај")');
await page.waitForTimeout(2500);
const put = server.puts[server.puts.length - 1];
check('a new card is saved over the revision it started from', Boolean(put && put.expected === 3
    && put.doc.cards.some((c) => c.title === 'Лекција' && c.url === 'https://example.org/lekcija')), JSON.stringify(put && put.expected));
check('and the panel says so', /верзија 4/.test(await page.textContent('.wbacc-status')));

server.stale = true;
server.revision = 9;
await page.click('.wbacc-bm button[title="Избриши"] >> nth=0');
await page.waitForSelector('.wbacc-conflict', { timeout: 6000 }).catch(() => {});
check('another computer saved in between: refused, and the person chooses', await page.isVisible('.wbacc-conflict'));
server.stale = false;
await page.click('.wbacc-conflict button:has-text("Земи ги од серверот")');
check('„take the server\'s" puts its version back', (await page.textContent('.wbacc-cols')).includes('Песна')
    && /верзија 9/.test(await page.textContent('.wbacc-status')));

await page.click('.wbacc-bm button[title="Во цртежот"]');
await page.waitForTimeout(800);
check('a video bookmark goes into the drawing as a playable embed',
    (await scene()).some((e) => e.type === 'embeddable' && /youtube/.test(e.link)));

console.log('\nimport from BookmarksPlus');
const exported = { boards: [{ id: 'x:1', name: 'Увезено', order: 1 }], columnsByBoard: { 'x:1': [{ id: 'y 1', name: 'Колона', order: 1 }] },
    cards: [{ id: 'z1', kind: 'file', fileName: 'upatstvo.pdf', boardId: 'x:1', columnId: 'y 1', title: '', tags: [], notes: '', pinned: true, order: 1, createdAt: 1, updatedAt: 1 },
            { id: 'z2', kind: 'link', url: 'javascript:alert(1)', boardId: 'x:1', columnId: 'y 1', title: 'Лош линк', tags: [], notes: '', pinned: false, order: 2, createdAt: 1, updatedAt: 1 }],
    ui: { activeBoardId: 'x:1' } };
await page.setInputFiles('.wbacc-file input', { name: 'bookmarks.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
await page.waitForTimeout(2500);
const imported = server.puts[server.puts.length - 1].doc;
check('a BookmarksPlus export imports, its ids made safe for the server',
    imported.boards[0].name === 'Увезено' && /^[\w-]+$/.test(imported.boards[0].id) && imported.cards.length === 2);
check('a file kept in that browser travels as its name, not as a file',
    imported.cards.some((c) => c.notes.includes('📎 upatstvo.pdf') && c.url === ''));
check('and a link that is not http(s) is dropped, not stored', imported.cards.every((c) => c.url === '' || /^https?:/.test(c.url)));

console.log('');
check('no request left the page that the test did not invent (offline)', unexpected.length === 0, unexpected.join(' ; '));
check('no JavaScript error', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
