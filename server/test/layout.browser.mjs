/**
 * mtb-layout.js — pin and fold for every tab strip, table head and section —
 * in a real browser, on an invented page. No server, no database: the page and
 * the script are answered here, and nothing is written anywhere.
 *
 *   node test/layout.browser.mjs          (npm run test:layout)
 *
 * What it proves (owner, 27 Sep 2026: „на секоја лента за табови поле за
 * замрзнување, на секој насловен ред во табелите опција да се замрзне при
 * лизгање и опција да се собере дел"):
 *
 *   1. A strip is ONE row at any width — it slides, it never wraps.
 *   2. „📌 Замрзни" on a strip keeps it at the top while the page scrolls,
 *      and a second pinned strip stacks under the first.
 *   3. A table's header row gets 📌 and ▾ without changing its words.
 *      Pinned, a copy of the header rides the top while the rows pass under;
 *      ▾ folds the rows away and leaves the header.
 *   4. A header the page already keeps on screen itself starts pinned, and
 *      can be let go.
 *   5. The schedule's div grid (`.schedule-grid`) gets the same.
 *   6. A section folds on its heading.
 *   7. Nothing is stored until somebody clicks, and what is stored is only
 *      the layout; after a reload the choice is still there.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3992';

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const rows = (n, cells) => Array.from({ length: n }, (_, i) =>
    '<tr>' + Array.from({ length: cells }, (_, c) => `<td>ред ${i + 1} · ${c + 1}</td>`).join('') + '</tr>').join('');
const PAGE = `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>Измислена страница</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .mtb-tabs { display: flex; gap: 5px; padding: 0 10px; background: #1a1a2e; }
  .mtb-tabs > .btn { padding: 10px 20px; margin-top: 5px; border: 0; background: #2d3748; color: #fff; }
  .card { margin: 16px; padding: 12px; border: 1px solid #ccc; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px; }
  thead th { background: #5a67d8; color: #fff; }
  .box { max-height: 200px; overflow: auto; }
  .box thead th { position: sticky; top: 0; }
  .schedule-grid { display: grid; grid-template-columns: 100px repeat(3, 1fr); gap: 1px; background: #eee; }
  .schedule-grid > div { background: #fff; padding: 10px; }
  .schedule-grid > .schedule-header { background: #667eea; color: #fff; }
  /* A page's own dark theme, as Кабинети and S-Dnevnik had it: black tabs. */
  body.dark-mode .mtb-tabs > .btn { background: linear-gradient(to bottom, #1a202c 0%, #0f1419 100%); }
</style></head><body>
<div class="mtb-tabs" id="strip">${['Ученици', 'Наставници', 'Терапевти', 'Одделенија', 'Формулари', 'Колеги', 'Изглед']
        .map((t, i) => `<button class="btn" aria-pressed="${i === 0}">${t}</button>`).join('')}</div>
<div class="card" id="plainCard"><h2>Список</h2><p>Опис на делот.</p>
  <table id="plain"><thead><tr><th>Р.Бр.</th><th>Име</th><th>Одделение</th></tr></thead><tbody>${rows(60, 3)}</tbody></table>
</div>
<div class="card"><h2>Во своја кутија</h2><div class="box">
  <table id="boxed"><thead><tr><th>Р.Бр.</th><th>Име</th></tr></thead><tbody>${rows(30, 2)}</tbody></table>
</div></div>
<div class="card"><table id="small"><thead><tr><th>A</th></tr></thead><tbody>${rows(2, 1)}</tbody></table></div>
<div class="card"><div class="schedule-grid" id="grid">
  <div class="schedule-header">Час</div><div class="schedule-header">Пон</div><div class="schedule-header">Вто</div><div class="schedule-header">Сре</div>
  ${Array.from({ length: 12 }, (_, i) => `<div>${i + 1}</div><div>x</div><div>y</div><div>z</div>`).join('')}
</div></div>
<div style="height: 1500px"></div>
<script src="mtb-layout.js"></script>
</body></html>`;

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 420, height: 700 }, serviceWorkers: 'block' });
const loaded = [];
await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    loaded.push(url.pathname);
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/Izmislena.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
    if (url.pathname === '/mtb-layout.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: await readFile(join(ROOT, 'mtb-layout.js')) });
    return route.fulfill({ status: 404, body: '' });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${ORIGIN}/Izmislena.html`);
await page.waitForFunction(() => document.querySelector('#plain .mtb-hctl'), null, { timeout: 5000 });

console.log('the strip');
const strip = await page.$eval('#strip', (s) => ({ h: s.offsetHeight, wraps: getComputedStyle(s).flexWrap, overflow: getComputedStyle(s).overflowX }));
check('seven tabs on a phone stay ONE row that slides', strip.wraps === 'nowrap' && strip.overflow === 'auto' && strip.h < 70, JSON.stringify(strip));
await page.evaluate(() => document.body.classList.add('dark-mode'));
check("one look for every tab, in either theme — the page's own black dark tabs do not win",
    // #082E3F, the blue scale's 900 (7 Oct 2026); the words on it are its 100.
    await page.$eval('#strip .btn:not([aria-pressed="true"])', (b) => getComputedStyle(b).backgroundColor + ' / ' + getComputedStyle(b).color)
        .then((look) => look === 'rgb(8, 46, 63) / rgb(192, 229, 247)'));
await page.evaluate(() => document.body.classList.remove('dark-mode'));
check('„📌 Замрзни" sits at its right end', await page.$eval('#strip', (s) => s.lastElementChild.classList.contains('mtb-pin')));
check('nothing is stored before anybody clicks', await page.evaluate(() => localStorage.getItem('mtb_layout_v1')) === null);
await page.check('#strip .mtb-pin input');
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(150);
check('pinned, the strip stays at the top while the page scrolls', await page.$eval('#strip', (s) => Math.round(s.getBoundingClientRect().top)) === 0);
check('and its place in the page is kept, so nothing jumps', await page.evaluate(() => Boolean(document.querySelector('.mtb-ph'))));

console.log('\na table\'s header row');
check('the header\'s words are unchanged: the glyphs are drawn, not written', await page.$eval('#plain thead th', (th) => th.textContent) === 'Р.Бр.');
check('a table of two rows is left alone', await page.$$eval('#small .mtb-hctl', (n) => n.length) === 0);
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('#plain .mtb-hpin');
await page.evaluate(() => window.scrollTo(0, document.getElementById('plain').offsetTop + 400));
await page.waitForTimeout(200);
const float = await page.evaluate(() => {
    const f = document.querySelector('#plainCard .mtb-float-head');
    const strip = document.getElementById('strip').getBoundingClientRect();
    return f && !f.hidden ? { top: Math.round(f.getBoundingClientRect().top), under: Math.round(strip.bottom), words: f.textContent } : null;
});
check('pinned, a copy of the header rides the top while the rows pass under it', float && /Име/.test(float.words), JSON.stringify(float));
check('and it stacks under the pinned strip, not over it', float && Math.abs(float.top - float.under) <= 1, JSON.stringify(float));
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('#plain .mtb-hfold');
check('▾ folds the rows away and leaves the header', await page.$eval('#plain tbody', (b) => getComputedStyle(b).display === 'none')
    && await page.isVisible('#plain thead'));

console.log('\na header the page keeps on screen itself');
check('starts pinned', await page.$eval('#boxed .mtb-hpin', (b) => b.getAttribute('aria-pressed')) === 'true');
await page.click('#boxed .mtb-hpin');
check('and can be let go', await page.$eval('#boxed thead th', (th) => getComputedStyle(th).position) === 'static');

console.log('\nthe schedule\'s grid');
check('the grid gets the same two controls in „Час"', await page.$eval('#grid .schedule-header', (h) => Boolean(h.querySelector('.mtb-hpin') && h.querySelector('.mtb-hfold'))));
await page.click('#grid .mtb-hfold');
check('▾ folds its rows and leaves the header row', await page.$$eval('#grid > div:not(.schedule-header)', (d) => d.every((x) => getComputedStyle(x).display === 'none'))
    && await page.isVisible('#grid .schedule-header'));

console.log('\na section');
check('its heading gets ▾', await page.$eval('#plainCard > h2', (h) => Boolean(h.querySelector('.mtb-fold'))));
await page.click('#plainCard .mtb-fold');
check('which folds everything under the heading', await page.isHidden('#plainCard > p') && await page.isVisible('#plainCard > h2'));

console.log('\nremembered, as layout only');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mtb_layout_v1') || '{}'));
check('one key, holding only pinned and folded', Object.values(stored).every((v) => Object.keys(v).every((k) => ['frozen', 'folded'].includes(k))), JSON.stringify(stored));
await page.reload();
await page.waitForFunction(() => document.querySelector('#plain .mtb-hctl'), null, { timeout: 5000 });
await page.waitForTimeout(200);
check('after a reload the strip is still pinned', await page.isChecked('#strip .mtb-pin input'));
check('the section is still folded', await page.isHidden('#plainCard > p'));
check('the grid still folded', await page.$$eval('#grid > div:not(.schedule-header)', (d) => d.every((x) => getComputedStyle(x).display === 'none')));
check('the let-go header still let go', await page.$eval('#boxed thead th', (th) => getComputedStyle(th).position) === 'static');

console.log('\nprinted');
await page.emulateMedia({ media: 'print' });
check('no pin, no fold button, no header copy on paper', await page.evaluate(() =>
    [...document.querySelectorAll('.mtb-ui')].every((n) => getComputedStyle(n).display === 'none')));
await page.emulateMedia({ media: 'screen' });

check('it loads nothing but itself', loaded.every((p) => ['/Izmislena.html', '/mtb-layout.js'].includes(p)), loaded.join(', '));
check('no page errors', errors.length === 0, errors.join('\n       '));
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
