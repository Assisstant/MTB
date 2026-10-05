/** A saved floating/pinned diary must not cover the app the user selects.
 * All requests are fixtures or local source files; no server or real data. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const origin = 'http://127.0.0.1:3099';
const files = new Set(['MTB-Workspace.html', 'workspace-admin.js', 'workspace-admin.css', 'app-navigation.js', 'mtb-theme.js', 'mtb-forms.js', 'mtb-layout.js']);
const browser = await chromium.launch();
try {
  for (const width of [1500, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const loads = new Map(), errors = [], writes = [];
    await context.addInitScript(() => { if (window !== window.top) return; localStorage.setItem('mtb_workspace_layout_v1', JSON.stringify({ version: 1, windows: {
      'app-S-Dnevnik': { mode: 'floating', maximized: true, pinned: true },
      directoryWindow: { mode: 'floating', maximized: true, pinned: true, hidden: false }
    } })); });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), file = url.pathname.slice(1);
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/years') return json([{ label: '2026/2027', is_current: true }]);
      if (url.pathname === '/api/health') return json({ ok: true });
      if (url.pathname === '/api/roster') return json({ year: '2026/2027', students: [], teachers: [], therapists: [], classes: [] });
      if (url.pathname === '/api/categories') return json({ categories: [] });
      if (url.pathname === '/api/categories/holders') return json({ teachers: [], therapists: [] });
      if (url.pathname.startsWith('/api/')) return json({});
      if (url.origin === origin && files.has(file)) return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)], body: await readFile(resolve(root, file)) });
      if (url.origin === origin && file.endsWith('.html')) {
        loads.set(file, (loads.get(file) || 0) + 1);
        return route.fulfill({ contentType: 'text/html', body: `<label>${file}<input id="draft"></label>` });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/MTB-Workspace.html');
    const diary = page.frameLocator('#app-S-Dnevnik iframe');
    await diary.locator('#draft').fill('unsaved diary');
    const select = async (file, id) => {
      await page.locator(`#appTabs [data-app="${file}"]`).click();
      const frame = page.locator(`#${id} iframe`);
      await frame.waitFor();
      const onTop = await frame.evaluate(el => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      });
      assert.equal(onTop, true, `${file} must actually be on top, even after a pinned maximized diary`);
      assert.equal(await page.locator('#appTabs button.active').getAttribute('data-app'), file);
      return page.frameLocator(`#${id} iframe`);
    };
    const data = await select('Podatoci.html', 'app-Podatoci');
    await data.locator('#draft').fill('unsaved data');
    await select('Nastava.html', 'app-Nastava');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.querySelector('#appTabs button.active')?.dataset.app === 'Podatoci.html');
    assert.equal(await data.locator('#draft').inputValue(), 'unsaved data');
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => document.querySelector('#appTabs button.active')?.dataset.app === 'Nastava.html');
    await select('S-Dnevnik.html', 'app-S-Dnevnik');
    await page.locator('#hideBar').click();
    assert.ok((await page.locator('#app-S-Dnevnik iframe').boundingBox()).height > 500);
    await page.locator('#showBar').click();
    assert.equal(await diary.locator('#draft').inputValue(), 'unsaved diary');
    assert.equal(loads.get('S-Dnevnik.html'), 1);
    assert.equal(loads.get('Podatoci.html'), 1);
    assert.equal(await page.locator('#directoryWindow,#dirTabs,#hidePanel,#dockDivider').count(), 0);
    // A late focus event from a background app cannot rename the selected tab.
    await data.locator('#draft').evaluate(el => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    assert.equal(await page.locator('#appTabs button.active').getAttribute('data-app'), 'S-Dnevnik.html');
    const action = name => page.locator(`#app-S-Dnevnik [data-window-action="${name}"]`);
    assert.equal(await page.locator('[data-window-action="pin"],[data-window-action="float"],[data-window-action="maximize"],[data-window-action="minimize"]').count(), 0);
    assert.equal(await action('size').textContent(), 'Помал прозорец', 'old pinned/maximized layout opens at full size');
    await page.locator('#resetLayout').click();
    assert.equal(await page.locator('#app-S-Dnevnik').isVisible(), true, 'reset keeps the selected window visible');
    await select('S-Dnevnik.html', 'app-S-Dnevnik');
    assert.equal(await diary.locator('#draft').inputValue(), 'unsaved diary');
    await page.locator('#resetLayout').click();
    assert.equal(await page.locator('#app-S-Dnevnik').getAttribute('data-mode'), 'docked');
    const full = await page.locator('#app-S-Dnevnik').boundingBox();
    const desktop = await page.locator('#main').boundingBox();
    assert.ok(Math.abs(full.width - desktop.width) < 2, 'the app uses the width freed by the panel');
    await action('size').click();
    const title = page.locator('#app-S-Dnevnik .window-titlebar');
    await title.focus();
    await title.press('ArrowRight');
    await title.press('ArrowDown');
    const handle = page.locator('#app-S-Dnevnik [data-edge="se"]');
    await handle.focus();
    await handle.press('ArrowLeft');
    const moved = await page.locator('#app-S-Dnevnik').boundingBox();
    assert.ok(moved.x >= desktop.x && moved.x + moved.width <= desktop.x + desktop.width + 2);
    assert.equal(await action('size').textContent(), 'Цел простор');
    await action('size').press('Enter');
    assert.equal(await page.locator('#app-S-Dnevnik').getAttribute('data-mode'), 'docked');
    const restored = await page.locator('#app-S-Dnevnik').boundingBox();
    assert.ok(Math.abs(restored.width - desktop.width) < 2, 'one size button restores the whole work area');
    assert.equal(await diary.locator('#draft').inputValue(), 'unsaved diary');
    assert.equal(loads.get('S-Dnevnik.html'), 1, 'layout changes never reload a draft');
    const saved = await page.evaluate(() => localStorage.getItem('mtb_workspace_layout_v1'));
    assert.ok(!saved.includes('directoryWindow') && !saved.includes('pinned') && !saved.includes('maximized') && !saved.includes('unsaved'), 'only current window geometry is persisted');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mkdir(resolve(root, 'backups/workspace-panel-removal'), { recursive: true });
    await page.screenshot({ path: resolve(root, `backups/workspace-panel-removal/light-${width}.png`) });
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: resolve(root, `backups/workspace-panel-removal/dark-${width}.png`) });
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    await context.close();
    console.log(`PASS tabs, saved layout, drafts, history and diary bar at ${width}px`);
  }
} finally { await browser.close(); }
