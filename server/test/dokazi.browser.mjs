/**
 * Докази (Dokazi.html) in a browser: the owner's evidence for the title of
 * mentor — each piece of evidence once, tied to indicators by links. Every
 * call to the MTB server is invented here, so nothing reaches a database, and
 * any request the test did not invent fails the run. The folder with the files
 * is the browser's own private file system, handed over where a person would
 * choose a folder; nothing on this computer's disk is read or written.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', '..');
// localhost: a folder can be opened only in a secure context.
const ORIGIN = 'http://localhost';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FILES = { '/Dokazi.html': 'text/html; charset=utf-8', '/mtb-theme.js': 'application/javascript', '/mtb-look.css': 'text/css' };

let fails = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '\n       ' + detail : ''}`);
    if (!ok) fails++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shots = process.env.SHOT;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name + '.png'), fullPage: true }); };

const file = (id, path, note = '') => ({ id, kind: 'file', path, url: '', label: '', note });
const web = (id, url, label = '') => ({ id, kind: 'link', path: '', url, label, note: '' });
const item = (id, no, title, parts = [], summary = '') => ({ id, no, title, summary, parts, order: no, createdAt: no, updatedAt: no });
const link = (id, itemId, indicator, why = '', parts = []) => ({ id, itemId, indicator, why, parts });
const seed = () => ({
    title: 'Табела со докази', subtitle: 'Измислена табела за проба',
    items: [
        item('e1', 1, 'Измислен циклус на проценка', [file('p1', 'slika.png', 'Шема'), file('p2', 'izvestaj.pdf'), web('p3', 'https://example.org/alat', 'Алатка')]),
        item('e2', 2, 'Измислена обука за наставници', [file('p4', 'pod/video.mp4'), file('p5', 'ja-nema.png')]),
        item('e3', 3, 'Измислена обука за наставниц', [file('p6', 'slika.png')]),
        item('e4', 4, 'Доказ без индикатор')
    ],
    links: [
        link('l1', 'e1', '1.1.1', 'Проценката е во три чекори.'),
        link('l2', 'e1', '6.1.1', 'Податоците се анализираат.', ['p2']),
        link('l3', 'e2', '1.1.1', 'Обуката ја следи проценката.'),
        link('l4', 'e3', '5.2.2', 'Истата обука, напишана двапати.')
    ]
});

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const unexpected = [];

/** One invented server per context: who it lets in, what it holds. */
async function world({ mode = 'owner', doc = seed(), revision = 4, viewport = { width: 1366, height: 900 }, folder = true } = {}) {
    const server = { mode, signedIn: false, doc, revision, puts: [], gets: 0 };
    const context = await browser.newContext({ viewport });
    const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.origin === ORIGIN) {
            if (FILES[url.pathname]) return route.fulfill({ status: 200, contentType: FILES[url.pathname], body: readFileSync(join(ROOT, url.pathname.slice(1))) });
            if (url.pathname === '/empty.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>empty</title>' });
            if (url.pathname === '/api/evidence/people') return json(route, 200, { people: [{ kind: 'therapist', id: 9, name: 'Измислен Автор' }] });
            if (url.pathname === '/api/evidence/login') { server.signedIn = true; return json(route, 200, { token: 'invented', person: { name: 'Измислен Автор' } }); }
            if (url.pathname === '/api/portfolio') {
                if (server.mode === 'pin' && !server.signedIn) return json(route, 401, { error: 'not signed in', signedOut: true });
                if (method === 'GET') { server.gets++; return json(route, 200, { doc: server.doc, revision: server.revision }); }
                const body = route.request().postDataJSON();
                server.puts.push(body);
                if (body.expected !== server.revision) return json(route, 409, { error: 'Сменети од друго место.', reason: 'stale', revision: server.revision });
                server.doc = body.doc;
                server.revision += 1;
                return json(route, 200, { ok: true, revision: server.revision });
            }
        }
        if (url.hostname === 'img.youtube.com') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        // A video's player and a linked site: invented, so the run needs no Internet.
        if (['www.youtube.com', 'docs.google.com', 'example.org'].includes(url.hostname)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>invented</title>' });
        unexpected.push(url.href.slice(0, 100));
        return route.abort();
    });
    const page = await context.newPage();
    // Where a person would choose a folder, the test hands over one of its own:
    // „dokazi" to read from, „izvoz" to write the commission's copy into.
    await page.addInitScript(() => {
        window.__picked = [];
        window.__next = '';
        window.showDirectoryPicker = async (options) => {
            const name = window.__next || (options && options.mode === 'readwrite' ? 'izvoz' : 'dokazi');
            window.__picked.push(name);
            return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
        };
        window.__printed = [];
        window.print = () => window.__printed.push(document.title);
    });
    if (folder) {
        await page.goto(`${ORIGIN}/empty.html`);
        await page.evaluate(async (png) => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('dokazi', { create: true });
            const write = async (folder, name, bytes) => { const s = await (await folder.getFileHandle(name, { create: true })).createWritable(); await s.write(new Uint8Array(bytes)); await s.close(); };
            await write(dir, 'slika.png', png);
            await write(dir, 'izvestaj.pdf', [37, 80, 68, 70]);
            await write(dir, 'ne-se-koristi.png', png);
            await write(await dir.getDirectoryHandle('pod', { create: true }), 'video.mp4', [0, 0, 0, 1]);
        }, [...PNG]);
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.stack || e).slice(0, 400)));
    const dialogs = [];
    let answer = () => true;
    page.on('dialog', (d) => { dialogs.push(d.message()); const a = answer(d); if (a === false) d.dismiss(); else d.accept(typeof a === 'string' ? a : undefined); });
    return { server, context, page, errors, dialogs, reply: (fn) => { answer = fn; } };
}
const open = async (w, hash = '') => { await w.page.goto(`${ORIGIN}/Dokazi.html${hash}`); await w.page.waitForSelector('#shell:not([hidden])'); };
const titles = (page) => page.$$eval('.card .title', (n) => n.map((x) => x.textContent));
const saved = async (w, n) => { await w.page.waitForFunction(() => document.getElementById('status').textContent.startsWith('✓')); return w.server.puts.length === n; };
// Every file under a folder of the browser's private file system, as paths.
const tree = (page, name) => page.evaluate(async (name) => {
    const out = [];
    const walk = async (dir, prefix) => { for await (const [n, h] of dir.entries()) { if (h.kind === 'file') out.push(prefix + n); else await walk(h, prefix + n + '/'); } };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), '');
    return out.sort();
}, name);
// WCAG contrast of an element's own text on the first opaque background behind it.
const contrast = (page, selector) => page.$eval(selector, (el) => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    let node = el, bg = 'rgba(0, 0, 0, 0)';
    while (node && /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)) { bg = getComputedStyle(node).backgroundColor; node = node.parentElement; }
    const a = lum(getComputedStyle(el).color), b = lum(bg);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});

try {
    console.log('the owner already signed in (the cloud): the evidence, each piece once');
    let w = await world();
    let { page, server } = w;
    await open(w);
    check('the page opens with the stored evidence and asks for no PIN', (await titles(page)).length === 4 && (await page.$('#gate')) === null);
    check('its browser tab carries the app\'s name', (await page.title()) === 'Докази — MTB');
    check('the standards are 55 indicators worth 80 points', (await page.textContent('#coveredPoints')).endsWith('од 80 бода') && (await page.textContent('#coveredCount')).endsWith('од 55 индикатори'));
    // 1.1.1 (1) + 6.1.1 (1) + 5.2.2 (2): three indicators, four points — however many pieces of evidence stand under one.
    check('coverage counts an indicator once, with its points', (await page.textContent('#coveredPoints')) === '4 од 80 бода' && (await page.textContent('#coveredCount')) === 'покриени 3 од 55 индикатори');
    check('a card shows the indicators its evidence stands under', same(await page.$$eval('[data-id="e1"] .chip', (n) => n.map((x) => x.textContent)), ['1.1.1', '6.1.1']));
    check('evidence under no indicator says so', (await page.textContent('[data-id="e4"] .warn')).includes('без индикатор'));
    check('the areas show how much of each is covered', (await page.$$eval('#areas .shelf:not(.sub) .n', (n) => n.map((x) => x.textContent))).join(' ') === '1/11 0/11 0/6 0/2 1/7 1/7 0/11');
    check('opening changed nothing on the server', server.puts.length === 0);
    await shot(page, 'library-light');

    console.log('\nthe table is read from the links, never typed');
    await page.click('#areas .shelf.sub >> nth=0');
    await page.waitForSelector('table.sheet');
    check('a section is a step in the address', page.url().endsWith('#p=1.1'));
    check('an indicator lists every piece of evidence under it', same(await page.$$eval('tr[data-code="1.1.1"] a.no', (n) => n.map((x) => x.textContent)), ['Доказ 1', 'Доказ 2']));
    check('each with its own explanation for that indicator', same(await page.$$eval('tr[data-code="1.1.1"] .why', (n) => n.map((x) => x.textContent)), ['Проценката е во три чекори.', 'Обуката ја следи проценката.']));
    check('an indicator with no evidence says so', (await page.textContent('tr[data-code="1.1.2"] td.none')).includes('нема доказ'));
    check('a link shows all of its evidence\'s parts unless it names some', (await page.$$eval('tr[data-link="l1"] .chip.part', (n) => n.length)) === 3);
    await page.goBack();
    await page.waitForSelector('.card');
    check('Back returns to the cards', (await titles(page)).length === 4);

    console.log('\nan explanation is edited where it is read, and only that link changes');
    await page.goto(`${ORIGIN}/Dokazi.html#p=1.1`);
    await page.waitForSelector('tr[data-link="l1"] .why');
    await page.click('tr[data-link="l1"] .why');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Ново образложение.');
    await page.click('#heading h2');
    check('leaving the field saves it', await saved(w, 1));
    check('over the revision the page started from', server.puts[0].expected === 4 && server.revision === 5);
    check('the same evidence keeps its other explanation', same(server.doc.links.map((l) => l.why), ['Ново образложение.', 'Податоците се анализираат.', 'Обуката ја следи проценката.', 'Истата обука, напишана двапати.']));
    check('and nothing was typed twice: four pieces of evidence still', server.doc.items.length === 4);

    console.log('\nevidence is put under an indicator by choosing it');
    await page.click('tr[data-code="1.1.2"] button:has-text("+ Додај доказ")');
    await page.waitForSelector('#picker[open]');
    await page.fill('#pickerSearch', 'без индикатор');
    check('the list narrows as it is searched', (await page.$$eval('#pickerList label:not([hidden])', (n) => n.length)) === 1);
    await page.check('#pickerList label:not([hidden]) input');
    await page.click('#pickerSave');
    await page.waitForSelector('tr[data-code="1.1.2"] a.no');
    check('the indicator now has it', (await page.textContent('tr[data-code="1.1.2"] a.no')) === 'Доказ 4' && await saved(w, 2));
    check('coverage follows', (await page.textContent('#coveredCount')) === 'покриени 4 од 55 индикатори' && (await page.textContent('#coveredPoints')) === '5 од 80 бода');
    w.reply(() => true);
    await page.click('tr[data-code="1.1.2"] button:has-text("Тргни")');
    await page.waitForSelector('tr[data-code="1.1.2"] td.none');
    check('„Тргни" takes the evidence off the indicator and keeps the evidence', await saved(w, 3) && server.doc.items.some((i) => i.id === 'e4') && !server.doc.links.some((l) => l.itemId === 'e4'));

    console.log('\none piece of evidence, opened');
    await page.goto(`${ORIGIN}/Dokazi.html#d=e1`);
    await page.waitForSelector('.detail');
    check('its parts and its indicators are on one screen', (await page.$$('.part-row')).length === 3 && (await page.$$('.link-box')).length === 2);
    check('a link that names some parts says how many', (await page.textContent('[data-link="l2"] summary')).includes('1 од 3'));
    await page.fill('#fTitle', 'Измислен циклус, преименуван');
    await page.click('#heading h2');
    check('a new title is saved once, for every indicator', await saved(w, 4) && server.doc.items.find((i) => i.id === 'e1').title === 'Измислен циклус, преименуван');
    await page.click('#addIndicator');
    await page.waitForSelector('#picker[open]');
    check('indicators it already has cannot be chosen twice', await page.$eval('#pickerList input[value="1.1.1"]', (b) => b.checked && b.disabled));
    await page.check('#pickerList input[value="7.2.7"]');
    await page.click('#pickerSave');
    await page.waitForSelector('.link-box >> nth=2');
    check('a chosen indicator becomes a link with an empty explanation', await saved(w, 5) && same(server.doc.links.filter((l) => l.itemId === 'e1').map((l) => l.indicator), ['1.1.1', '6.1.1', '7.2.7']));
    w.reply((d) => (d.type() === 'prompt' ? 'example.net/dokument' : true));
    await page.click('#addLink');
    await page.waitForSelector('.part-row >> nth=3');
    check('a link is added as http(s)', await saved(w, 6) && server.doc.items.find((i) => i.id === 'e1').parts.at(-1).url === 'https://example.net/dokument');
    w.reply((d) => (d.type() === 'prompt' ? 'javascript:alert(1)' : true));
    await page.click('#addLink');
    check('anything else is refused', w.dialogs.at(-1).includes('http') && server.puts.length === 6);
    await page.click('.part-row[data-part="p2"] button:has-text("Тргни")');
    await page.waitForFunction(() => document.querySelectorAll('.part-row').length === 3);
    check('a part taken out leaves the links that named it', await saved(w, 7) && same(server.doc.links.find((l) => l.id === 'l2').parts, []));

    console.log('\nthe folder with the files: this computer\'s, read only, each file once');
    check('nothing is opened until the person chooses a folder', same(await page.evaluate(() => window.__picked), []) && (await page.textContent('#connect')) === '📂 Поврзи папка');
    await page.click('#connect');
    await page.waitForFunction(() => document.getElementById('folderHint').textContent.includes('4 датотеки'));
    check('the folder is read, sub-folders too', (await page.textContent('#folderHint')).includes('„dokazi"'));
    await page.waitForFunction(() => { const i = document.querySelector('.part-row[data-part="p1"] .thumb img'); return i && i.src.startsWith('blob:'); });
    check('a picture shows itself', true);
    // A real second visit: another page in between, so the script starts again.
    await page.goto(`${ORIGIN}/empty.html`);
    await page.goto(`${ORIGIN}/Dokazi.html#datoteki`);
    await page.waitForSelector('#idleFiles');
    check('the folder is remembered on the next visit', same(await page.evaluate(() => window.__picked), []));
    check('files no evidence names are listed', same(await page.$$eval('#idleFiles .file-row', (n) => n.map((x) => x.dataset.path)), ['izvestaj.pdf', 'ne-se-koristi.png']));
    check('and files that are named but missing', (await page.textContent('#goneFiles')).includes('ja-nema.png') && (await page.textContent('#goneFiles')).includes('Доказ 2'));
    await page.click('#idleFiles [data-path="ne-se-koristi.png"] button:has-text("+ Додај како доказ")');
    await page.waitForSelector('.detail');
    check('an unused file becomes evidence in one click', await saved(w, 8) && server.doc.items.at(-1).parts[0].path === 'ne-se-koristi.png' && server.doc.items.at(-1).no === 5);
    await page.click('#addFile');
    await page.waitForSelector('#picker[open]');
    check('a file can stand in several pieces of evidence, and the list says where it already is',
        (await page.textContent('#pickerList label:has(input[value="slika.png"])')).includes('во 2 доказ'));
    await page.check('#pickerList input[value="slika.png"]');
    await page.click('#pickerSave');
    check('it is named again, not copied', await saved(w, 9) && server.doc.items.at(-1).parts.map((p) => p.path).join() === 'ne-se-koristi.png,slika.png');

    console.log('\nfor the commission: a page that opens without MTB, a folder per evidence, a folder per indicator');
    await page.evaluate(() => { window.__next = 'dokazi'; });
    await page.click('#pack');
    await page.waitForFunction(() => window.__picked.length === 1);
    await page.waitForTimeout(300);
    check('the folder the files are read from is refused as the place to write', w.dialogs.at(-1).includes('Избери друга') && same(await tree(page, 'dokazi'), ['izvestaj.pdf', 'ne-se-koristi.png', 'pod/video.mp4', 'slika.png']));
    await page.evaluate(() => { window.__next = ''; });
    const before = w.dialogs.length;
    await page.click('#pack');
    await page.waitForFunction((n) => window.__picked.length === 2, null);
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('✓'));
    while (w.dialogs.length < before + 2) await page.waitForTimeout(50);
    const out = await tree(page, 'izvoz');
    check('one page beside the folders', out.includes('Табела со докази.html'));
    check('a folder per evidence, each file once', same(out.filter((p) => p.startsWith('Докази/Доказ 01')), ['Докази/Доказ 01 - Измислен циклус, преименуван/slika.png', 'Докази/Доказ 01 - Измислен циклус, преименуван/Линкови.txt'].sort()));
    check('a file one folder down is copied by its name', out.includes('Докази/Доказ 02 - Измислена обука за наставници/video.mp4'));
    check('a folder per indicator holds the evidence under it', out.includes('По индикатор/1.1.1 - Ја проценува подготвеноста на учениците за вклучување и напр/Доказ 01 - Измислен циклус, преименуван/slika.png')
        && out.includes('По индикатор/1.1.1 - Ја проценува подготвеноста на учениците за вклучување и напр/Доказ 02 - Измислена обука за наставници/video.mp4'),
    out.filter((p) => p.startsWith('По индикатор/1.1.1')).join('\n       '));
    check('every one of the 55 indicators has its folder, covered or not', (await page.evaluate(async () => {
        let n = 0; const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('izvoz')).getDirectoryHandle('По индикатор');
        for await (const _ of d.keys()) n++; return n; })) === 55);
    check('a file that is missing is reported, not silently skipped', w.dialogs.at(-1).includes('ja-nema.png'));
    check('the folder read from is untouched', same(await tree(page, 'dokazi'), ['izvestaj.pdf', 'ne-se-koristi.png', 'pod/video.mp4', 'slika.png']));
    const standalone = await page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('izvoz')).getFileHandle('Табела со докази.html')).getFile()).text());
    check('the page carries the table and asks nothing of a server', standalone.includes('Ново образложение.') && standalone.includes('Измислен циклус, преименуван')
        && !/src="https?:|href="(?!https:\/\/example\.|#|%D0%94)|fetch\(/.test(standalone.replace(/href="https:\/\/example\.[^"]*"/g, '')));
    check('its files are addressed beside it', standalone.includes(`href="${['Докази', 'Доказ 01 - Измислен циклус, преименуван', 'slika.png'].map(encodeURIComponent).join('/')}"`));
    const alone = await w.context.newPage();
    const aloneErrors = [];
    alone.on('pageerror', (e) => aloneErrors.push(String(e)));
    await alone.setContent(standalone);
    check('opened on its own it shows 55 indicators and every piece of evidence', (await alone.$$eval('td.ind', (n) => n.length)) === 55 && (await alone.$$eval('article', (n) => n.length)) === 5 && aloneErrors.length === 0, aloneErrors.join(' | '));
    await alone.close();

    console.log('\nprinting the table');
    await page.click('#print');
    await page.waitForFunction(() => window.__printed.length === 1);
    check('the sheet is printed under its own name', same(await page.evaluate(() => window.__printed), ['Табела со докази']) && page.url().endsWith('#tabela'));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    check('and the tab gets its name back', (await page.title()) === 'Докази — MTB');
    await page.emulateMedia({ media: 'print' });
    check('on paper there are no buttons and no sidebar', await page.evaluate(() => [...document.querySelectorAll('aside, header, .screen')].every((n) => getComputedStyle(n).display === 'none')));
    await page.emulateMedia({ media: 'screen' });
    check('the page raised no errors', w.errors.length === 0, w.errors.join(' | '));
    await w.context.close();

    console.log('\ntitles that look alike are offered, never merged by a guess');
    w = await world({ folder: false }); ({ page, server } = w);
    await open(w);
    check('the pair is counted on the left', (await page.textContent('#shelves .shelf:has-text("Слични")')).endsWith('1'));
    await page.click('#shelves .shelf:has-text("Слични")');
    await page.waitForSelector('.pair');
    check('nothing has been merged or saved', server.puts.length === 0 && (await page.$$('.pair')).length === 1);
    w.reply(() => true);
    await page.click('.pair .side >> nth=0 >> button');
    await page.waitForFunction(() => !document.querySelector('.pair'));
    await saved(w, 1);
    const kept = server.doc.items.find((i) => i.id === 'e2');
    check('the chosen one stays, the other is folded into it', kept && !server.doc.items.some((i) => i.id === 'e3') && server.doc.items.length === 3);
    check('its indicators come along', same(server.doc.links.filter((l) => l.itemId === 'e2').map((l) => l.indicator).sort(), ['1.1.1', '5.2.2']));
    check('its files too, and none twice', same(kept.parts.map((p) => p.path), ['pod/video.mp4', 'ja-nema.png', 'slika.png']));
    await page.goto(`${ORIGIN}/Dokazi.html#bez`);
    await page.waitForSelector('#out .file-row');
    check('„Без доказ" lists the indicators still open and the evidence under none', (await page.$$('#out .file-row')).length === 52 && same(await titles(page), ['Доказ 4 · Доказ без индикатор']));
    w.reply(() => true);
    await page.goto(`${ORIGIN}/Dokazi.html#d=e1`);
    await page.waitForSelector('#deleteItem');
    await page.click('#deleteItem');
    await page.waitForSelector('.card');
    check('deleting evidence deletes its links and nothing else', await saved(w, 2) && server.doc.items.length === 2 && server.doc.links.every((l) => l.itemId === 'e2'));
    check('the page raised no errors', w.errors.length === 0, w.errors.join(' | '));
    await w.context.close();

    console.log('\nthe old table: a row per indicator, the same evidence typed again');
    w = await world({ doc: null, revision: 0, folder: false }); ({ page, server } = w);
    await open(w);
    check('a server that holds nothing yet opens empty, and nothing is saved', (await page.textContent('#status')).includes('уште нема докази') && server.puts.length === 0);
    const att = (attId, name) => ({ attId, kind: 'file', name, data: 'Dokazi/' + name, storage: 'local', description: '' });
    const row = (col2, col1, col3, atts = [], atts1 = []) => ({ col1, col2, col3, atts, atts1, atts2: [], points: 1, checked: false });
    const first = 'Ја проценува подготвеноста на учениците за вклучување и напредување во образовниот систем.';
    const third = 'Има познавање за користење асистивна технологија при работа со ученици со посебни образовни потреби.';
    const old = { mainTitle: 'Табела со докази', subtitle: 'Стара измислена табела', pages: [{ rows: [
        { isSection: true, title: 'Подрачје 1', secNo: '1' },
        row(first, 'Доказ 1 - Измислена проценка', 'Прво<br>образложение', [att('a1', 'slika.png'), att('a2', 'izvestaj.pdf')],
            [{ attId: 'a3', kind: 'link', url: 'https://example.org/alat', title: 'Алатка', storage: 'cloud', description: 'Опис' }]),
        // The same evidence under another number, with one file of its own and one pointed at from the first row.
        row(third, 'Доказ 7 - Измислена проценка', 'Второ образложение', [{ attId: 'a4', kind: 'reference', refId: 'a1', storage: 'reference', description: '' }]),
        // A different piece of evidence that was given the SAME number.
        row(third, 'Доказ 1 - Сосема друг доказ', 'Трето', [{ attId: 'a5', kind: 'youtube', vid: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Видео', storage: 'cloud', description: '' }]),
        row('Индикатор што го нема во стандардите', 'Доказ 9 - Заскитан доказ', 'Четврто', [{ attId: 'a6', kind: 'file', name: 'x.png', data: 'data:image/png;base64,AAAA', storage: 'embedded' }]),
        // The indicator shortened: words left out, none changed — it can only be 7.2.7.
        row('Го осмислува процесот на кризна интервенција.', 'Доказ 3 - Сосема друг доказ', 'Петто'),
        // Too few words to say which indicator: left under none.
        row('Придонесува за училиштето', 'Доказ 9 - Заскитан доказ', 'Шесто'),
        row(first, '', '')
    ] }] };
    w.reply(() => true);
    await page.setInputFiles('#importOld', { name: 'stara.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
    await page.waitForSelector('.card');
    await saved(w, 1);
    check('the person is told what will happen before anything is saved', w.dialogs[0].includes('6 пополнети редови') && w.dialogs[0].includes('3 докази'));
    check('the same title is one piece of evidence, whatever number stood in front', same(server.doc.items.map((i) => i.title), ['Измислена проценка', 'Сосема друг доказ', 'Заскитан доказ']));
    check('a number shared by two different titles does not merge them', same(server.doc.items.map((i) => i.no), [1, 2, 3]));
    check('each indicator keeps its own explanation, line breaks kept', same(server.doc.links.map((l) => [l.indicator, l.why]), [['1.1.1', 'Прво\nобразложение'], ['1.1.3', 'Второ образложение'], ['1.1.3', 'Трето'], ['7.2.7', 'Петто']]));
    check('a shortened indicator is placed only when it can be one indicator, and the person is told', w.dialogs[0].includes('1 редови го имаа индикаторот скратен'));
    const merged = server.doc.items[0];
    check('its files are named once, without the old folder in front', same(merged.parts.map((p) => p.path || p.url), ['slika.png', 'izvestaj.pdf', 'https://example.org/alat']));
    check('a row that showed one of them still shows that one', same(server.doc.links[1].parts, [merged.parts[0].id]) && same(server.doc.links[0].parts, []));
    check('a row under no known indicator keeps its evidence and its words', server.doc.items[2].summary === 'Четврто\n\nШесто' && w.dialogs[0].includes('2 редови не се под познат') && !server.doc.links.some((l) => l.itemId === server.doc.items[2].id));
    check('a file the old page had swallowed is reported as not carried over', w.dialogs[0].includes('1 прилози не можеа'));
    w.reply(() => false);
    await page.setInputFiles('#importOld', { name: 'stara.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
    await page.waitForTimeout(200);
    check('a second import asks before replacing, and „Откажи" changes nothing', w.dialogs.at(-1).includes('ЗАМЕНУВААТ') && server.puts.length === 1);
    await page.setInputFiles('#importOld', { name: 'ne.json', mimeType: 'application/json', buffer: Buffer.from('{"boards":[]}') });
    await page.waitForTimeout(200);
    check('a file that is not the old table is refused in words', w.dialogs.at(-1).includes('старата') && server.puts.length === 1);
    check('the page raised no errors', w.errors.length === 0, w.errors.join(' | '));
    await w.context.close();

    console.log('\ntwo computers: the server refuses a stale save and the person decides');
    w = await world({ folder: false }); ({ page, server } = w);
    await open(w, '#d=e4');
    server.revision = 9;
    server.doc = { ...seed(), items: seed().items.slice(0, 3), links: seed().links };
    await page.fill('#fTitle', 'Сменето тука');
    await page.click('#heading h2');
    await page.waitForSelector('#takeServer');
    check('nothing is merged and nothing overwritten', server.puts.length === 1 && server.revision === 9 && server.doc.items.length === 3);
    await page.reload();
    await page.waitForSelector('#takeServer');
    check('the unsaved change survives a reload, still undecided', (await page.inputValue('#fTitle')) === 'Сменето тука' && server.puts.length === 1);
    w.reply(() => true);
    await page.click('#overwriteServer');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('✓'));
    check('„Препиши го серверот" saves this copy over the newer revision', server.revision === 10 && server.doc.items.some((i) => i.title === 'Сменето тука'));
    await w.context.close();

    console.log('\na local server: the administrator\'s name and PIN');
    w = await world({ mode: 'pin', folder: false }); ({ page, server } = w);
    await page.goto(`${ORIGIN}/Dokazi.html`);
    await page.waitForSelector('#gate');
    check('nothing is shown and nothing can be saved before the sign-in', await page.$eval('#shell', (s) => s.hidden) && server.gets === 0);
    await page.fill('#gate input[name=pin]', '1234');
    await page.click('#gate button');
    await page.waitForSelector('.card');
    check('after it the evidence opens', (await titles(page)).length === 4 && server.puts.length === 0);
    await w.context.close();

    console.log('\na part is shown over the page, as the old table did');
    // A .docx is a zip with its text in word/document.xml; this one is made here, two paragraphs long.
    const docx = (() => {
        const name = Buffer.from('word/document.xml');
        const raw = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            + '<w:p><w:r><w:t>Измислена подготовка</w:t></w:r></w:p><w:p><w:r><w:t>Втор </w:t></w:r><w:r><w:t>пасус</w:t></w:r></w:p></w:body></w:document>');
        const packed = deflateRawSync(raw);
        const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
        end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + packed.length, 16);
        return Buffer.concat([local, name, packed, central, name, end]);
    })();
    w = await world({ doc: { ...seed(), items: [item('v1', 1, 'Измислен доказ со сè', [file('f1', 'slika.png'), file('f2', 'izvestaj.pdf'), file('f3', 'pod/video.mp4'), file('f4', 'opis.docx'),
        file('f5', 'tabela.xlsx'), web('f6', 'https://www.youtube.com/watch?v=abcdefghijk', 'Видео'), web('f7', 'https://example.org/alat', 'Алатка'),
        web('f8', 'https://docs.google.com/document/d/abc_123-x/edit?usp=sharing', 'Документ')])], links: [] } });
    ({ page, server } = w);
    await page.evaluate(async ([bytes]) => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('dokazi');
        for (const [name, data] of [['opis.docx', bytes], ['tabela.xlsx', [80, 75]]]) { const s = await (await dir.getFileHandle(name, { create: true })).createWritable(); await s.write(new Uint8Array(data)); await s.close(); }
    }, [[...docx]]);
    await open(w, '#d=v1');
    await page.click('#connect');
    await page.waitForFunction(() => document.getElementById('folderHint').textContent.includes('6 датотеки'));
    const stage = (selector) => page.waitForSelector('#viewer[open] #viewerStage ' + selector);
    const thumbOf = (id) => page.click(`.part-row[data-part="${id}"] .thumb`);
    await thumbOf('f1'); await stage('img');
    check('a picture opens over the page, under its name', (await page.textContent('#viewerTitle')) === 'slika.png' && (await page.$eval('#viewerStage img', (i) => i.src.startsWith('blob:'))));
    check('the address stays where it was', page.url().endsWith('#d=v1') && w.context.pages().length === 1);
    await page.click('#viewerClose');
    await page.waitForFunction(() => document.getElementById('viewerStage').childElementCount === 0);
    check('closing empties it', (await page.$('#viewer[open]')) === null && (await page.$eval('#viewerStage', (s) => s.childElementCount)) === 0);
    await thumbOf('f2'); await stage('iframe');
    check('a PDF is shown in the page', await page.$eval('#viewerStage iframe', (f) => f.src.startsWith('blob:')));
    await page.keyboard.press('Escape');
    await thumbOf('f3'); await stage('video');
    check('a video plays with its controls', await page.$eval('#viewerStage video', (v) => v.controls && v.src.startsWith('blob:')));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('viewerStage').childElementCount === 0);
    check('and stops when the window is closed', (await page.$('#viewerStage video')) === null);
    await thumbOf('f4'); await stage('.words');
    check('a Word file shows its words, paragraph by paragraph', same(await page.$$eval('#viewerStage .words p:not(.hint)', (n) => n.map((x) => x.textContent)), ['Измислена подготовка', 'Втор пасус']));
    await shot(page, 'viewer-word');
    check('and „↗ Отвори" hands over the file itself', await page.$eval('#viewerOut', (a) => a.href.startsWith('blob:') && a.target === '_blank'));
    await page.keyboard.press('Escape');
    await thumbOf('f6'); await stage('iframe');
    check('a YouTube link plays in the page', (await page.$eval('#viewerStage iframe', (f) => f.src)).startsWith('https://www.youtube.com/embed/abcdefghijk'));
    await page.keyboard.press('Escape');
    await thumbOf('f8'); await stage('iframe');
    check('a Google document is asked for its own preview', (await page.$eval('#viewerStage iframe', (f) => f.src)) === 'https://docs.google.com/document/d/abc_123-x/preview');
    await page.keyboard.press('Escape');
    let [tab] = await Promise.all([w.context.waitForEvent('page'), thumbOf('f7')]);
    check('any other link opens in a tab of its own', tab.url() === 'https://example.org/alat' && (await page.$('#viewer[open]')) === null);
    await tab.close();
    [tab] = await Promise.all([w.context.waitForEvent('page'), thumbOf('f5')]);
    check('a file the browser cannot show is handed over, not shown broken', Boolean(tab) && (await page.$('#viewer[open]')) === null);
    await tab.close();
    await page.goto(`${ORIGIN}/Dokazi.html#tabela`);
    check('looking changed nothing on the server', server.puts.length === 0);
    check('the page raised no errors', w.errors.length === 0, w.errors.join(' | '));
    await w.context.close();

    console.log('\nwords are readable in both themes');
    w = await world({ folder: false }); ({ page } = w);
    for (const theme of ['light', 'dark']) {
        await page.addInitScript((t) => { try { localStorage.setItem('mtb_theme', t); } catch (_) { /* default theme */ } }, theme);
        await page.goto(`${ORIGIN}/Dokazi.html#p=1.1`);
        await page.waitForSelector('table.sheet');
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        for (const [name, selector] of [['a shelf', '#areas .shelf:not([aria-current])'], ['the chosen shelf', '#areas .shelf[aria-current] .name'], ['an indicator', 'td.ind'],
            ['an evidence number', 'td.ev a.no'], ['an explanation', 'tr[data-link="l1"] .why'], ['a part', '.chip.part'], ['a table head', 'table.sheet th'], ['a quiet button', 'td.ind .btn']]) {
            const ratio = await contrast(page, selector);
            check(`${theme}: ${name} reads at 4.5:1 or better`, ratio >= 4.5, ratio.toFixed(2));
        }
        await shot(page, 'table-' + theme);
    }
    await w.context.close();

    console.log('\na phone');
    w = await world({ viewport: { width: 390, height: 800 }, folder: false }); ({ page } = w);
    for (const hash of ['', '#p=1.1', '#d=e1', '#bez']) {
        await page.goto(`${ORIGIN}/Dokazi.html${hash}`);
        await page.waitForSelector('#shell:not([hidden])');
        check(`nothing runs off the side of the screen (${hash || 'cards'})`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    }
    await shot(page, 'phone');
    check('the page raised no errors', w.errors.length === 0, w.errors.join(' | '));
    await w.context.close();

    check('the page asked nobody the test did not invent', unexpected.length === 0, unexpected.join(', '));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
