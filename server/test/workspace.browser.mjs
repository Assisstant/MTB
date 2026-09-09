/**
 * Workspace window behaviour, using invented data only.
 * Start the static/API server first, then run npm run test:workspace.
 * API defaults to http://127.0.0.1:31372; CHROME can select an installed browser.
 * Only the workspace and its shared scripts reach that server. Every API call
 * and child application document is intercepted, and every write is refused.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = (process.env.API || 'http://127.0.0.1:31372').replace(/\/$/, '');
const LAYOUT_KEY = 'mtb_workspace_layout_v1';
const DRAFT = 'Invented unsaved workspace draft';
const STUDENT_ID = 'workspace-invented-student';
const APPS = ['RasporediFusion.html', 'NastavaUredi.html', 'AkciskiPlan.html', 'S-Dnevnik.html', 'Pregled-Baza.html'];
const roster = {
    year: '2026/2027',
    students: [{ public_id: STUDENT_ID, name: 'Ученик Пример', grade: 'I', kind: 'internal', active: true }],
    teachers: [], therapists: [], classes: [{ label: 'I' }]
};
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let failures = 0;

function stub(file, count) {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><style>
      html,body{margin:0;min-height:100%;background:#f1f3fa;font:16px sans-serif}
      main{padding:18px}input{display:block;width:230px;padding:10px;margin-top:8px}
      </style><title>Invented workspace fixture</title><main data-load="${count}">
      <label for="draft">Unsaved ${file} field</label><input id="draft" autocomplete="off">
      </main></html>`;
}

async function openWorkspace({ viewport = { width: 1600, height: 1000 }, savedLayout } = {}) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const loads = new Map(), forbidden = [], errors = [];
    await context.addInitScript(({ key, saved }) => {
        if (window === window.top && saved !== undefined) localStorage.setItem(key, saved);
    }, { key: LAYOUT_KEY, saved: savedLayout });
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (request.method() !== 'GET') {
            forbidden.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({ status: 405, body: 'The workspace regression test never writes data.' });
        }
        if (url.pathname.startsWith('/api/')) {
            switch (url.pathname) {
                case '/api/years': return json([{ id: 1, label: roster.year, is_current: true }]);
                case '/api/roster': return json(roster);
                case '/api/categories': return json({ categories: [] });
                case '/api/categories/holders': return json({ teachers: [], therapists: [] });
                case '/api/health': return json({ ok: true, server: { label: 'ПРОБНА БАЗА' } });
                default:
                    forbidden.push(`Unexpected API ${url.pathname}`);
                    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
            }
        }
        const file = url.pathname.slice(1);
        if (APPS.includes(file)) {
            const count = (loads.get(file) || 0) + 1;
            loads.set(file, count);
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: stub(file, count) });
        }
        if (url.origin === new URL(BASE).origin && (file === 'MTB-Workspace.html' || file === 'app-navigation.js')) {
            return route.continue();
        }
        // No remote resources or production data may escape the fixture router.
        if (file !== 'favicon.ico') forbidden.push(`Unexpected resource ${url.origin}${url.pathname}`);
        return route.fulfill({ status: 404, body: '' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/MTB-Workspace.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('#scheduleWindow.workspace-window').waitFor();
    await page.locator(`[data-pick="${STUDENT_ID}"]`).waitFor({ state: 'attached' });
    await page.frameLocator('#appFrame').locator('#draft').waitFor();
    return { page, context, loads, forbidden, errors };
}

const action = (page, selector, name) => page.locator(`${selector} .window-actions [data-window-action="${name}"]`);
const rect = locator => locator.evaluate(node => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const closeEnough = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;
async function mode(page, selector, expected) {
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.dataset.mode === expected,
        { selector, expected });
}
async function dragTo(page, selector, left, top) {
    const windowBox = await rect(page.locator(selector));
    const title = await rect(page.locator(`${selector} .window-titlebar`));
    const x = title.x + 30, y = title.y + title.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + left - windowBox.x, y + top - windowBox.y, { steps: 14 });
    await page.mouse.up();
}
async function resizeTo(page, selector, width, height) {
    const before = await rect(page.locator(selector));
    const handle = await rect(page.locator(`${selector} .resize-handle[data-edge="se"]`));
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width - before.width, y + height - before.height, { steps: 14 });
    await page.mouse.up();
}
async function z(page, selector) {
    return page.locator(selector).evaluate(node => Number(getComputedStyle(node).zIndex) || 0);
}
async function editor(page) {
    await page.locator(`[data-pick="${STUDENT_ID}"]`).click();
    await page.locator('#sName').fill(DRAFT);
}
async function assertDrafts(page) {
    assert.equal(await page.locator('#sName').inputValue(), DRAFT, 'directory draft survives layout changes');
    assert.equal(await page.frameLocator('#appFrame').locator('#draft').inputValue(), DRAFT,
        'iframe draft survives layout changes');
}
async function run(label, scenario, options) {
    let fixture;
    try {
        fixture = await openWorkspace(options);
        await scenario(fixture);
        assert.deepEqual(fixture.errors, [], 'no browser JavaScript errors');
        assert.deepEqual(fixture.forbidden, [], 'no unexpected API request, write or remote resource');
        console.log(`  ok   ${label}`);
    } catch (error) {
        failures++;
        console.error(`  FAIL ${label}\n       ${error.stack || error}`);
    } finally {
        await fixture?.context.close();
    }
}

try {
    console.log('Workspace windows — isolated browser regression');
    await run('dock divider supports pointer and keyboard without losing drafts', async ({ page }) => {
        await editor(page);
        await page.frameLocator('#appFrame').locator('#draft').fill(DRAFT);
        const directory = page.locator('#directoryWindow'), divider = page.locator('#dockDivider');
        assert.equal(await divider.getAttribute('role'), 'separator');
        const initial = await rect(directory);
        await divider.focus();
        await page.keyboard.press('ArrowLeft');
        const keyboard = await rect(directory);
        assert.ok(keyboard.width > initial.width, 'left arrow widens the right directory');
        const handle = await rect(divider);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
        await page.mouse.down();
        await page.mouse.move(handle.x - 70, handle.y + 190, { steps: 14 });
        await page.mouse.up();
        assert.ok((await rect(directory)).width > keyboard.width + 40, 'drag resizes over the iframe surface');
        await assertDrafts(page);
    });

    let floatingLayout;
    await run('float, drag, resize, maximize, hide and reopen preserve unsaved editors', async ({ page, loads }) => {
        await editor(page);
        await page.frameLocator('#appFrame').locator('#draft').fill(DRAFT);
        await action(page, '#directoryWindow', 'float').click();
        await mode(page, '#directoryWindow', 'floating');
        const desktop = await rect(page.locator('#main'));
        await dragTo(page, '#directoryWindow', desktop.x + 50, desktop.y + 45);
        let box = await rect(page.locator('#directoryWindow'));
        assert.ok(closeEnough(box.x, desktop.x + 50) && closeEnough(box.y, desktop.y + 45),
            'titlebar drags across the embedded application');
        await resizeTo(page, '#directoryWindow', 560, 500);
        const smaller = await rect(page.locator('#directoryWindow'));
        await resizeTo(page, '#directoryWindow', 740, 650);
        box = await rect(page.locator('#directoryWindow'));
        assert.ok(box.width > smaller.width + 120 && box.height > smaller.height + 100,
            'corner resize changes both dimensions over an iframe');
        const restored = { ...box };
        await action(page, '#directoryWindow', 'maximize').click();
        assert.equal(await page.locator('#directoryWindow').getAttribute('data-maximized'), 'true');
        box = await rect(page.locator('#directoryWindow'));
        assert.ok(box.width >= desktop.width - 4 && box.height >= desktop.height - 4,
            'maximized window fills the workspace');
        await action(page, '#directoryWindow', 'maximize').click();
        box = await rect(page.locator('#directoryWindow'));
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(closeEnough(box[key], restored[key]), `restore ${key}`);
        floatingLayout = await page.evaluate(key => localStorage.getItem(key), LAYOUT_KEY);
        assert.ok(floatingLayout && !floatingLayout.includes(DRAFT) && !floatingLayout.includes(roster.students[0].name),
            'persisted layout contains geometry, never editor or roster content');
        await page.locator('#hidePanel').click();
        assert.equal(await page.locator('#directoryWindow').isVisible(), false);
        await page.locator('#hidePanel').click();
        await page.locator('#directoryWindow').waitFor({ state: 'visible' });
        await assertDrafts(page);
        await page.locator('#resetLayout').click();
        await mode(page, '#directoryWindow', 'docked');
        await mode(page, '#scheduleWindow', 'docked');
        await assertDrafts(page);
        assert.equal(loads.get('RasporediFusion.html'), 1, 'layout operations never reload the application');
    });

    await run('overlapping windows focus on click, including iframe focus, while pinned windows stay above', async ({ page }) => {
        const desktop = await rect(page.locator('#main'));
        await action(page, '#directoryWindow', 'float').click();
        await dragTo(page, '#directoryWindow', desktop.x + 650, desktop.y + 40);
        await resizeTo(page, '#directoryWindow', 700, 650);
        await action(page, '#scheduleWindow', 'float').click();
        await dragTo(page, '#scheduleWindow', desktop.x + 30, desktop.y + 145);
        await resizeTo(page, '#scheduleWindow', 850, 600);
        await page.locator('#directoryWindow .window-titlebar').click({ position: { x: 30, y: 18 } });
        assert.ok(await z(page, '#directoryWindow') > await z(page, '#scheduleWindow'));
        await page.frameLocator('#appFrame').locator('#draft').click();
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#scheduleWindow')).zIndex)
            > Number(getComputedStyle(document.querySelector('#directoryWindow')).zIndex));
        await action(page, '#directoryWindow', 'pin').click();
        assert.equal(await action(page, '#directoryWindow', 'pin').getAttribute('aria-pressed'), 'true');
        await page.frameLocator('#appFrame').locator('#draft').click();
        assert.ok(await z(page, '#directoryWindow') > await z(page, '#scheduleWindow'), 'pin outranks iframe focus');
        const topAtOverlap = await page.evaluate(() => {
            const a = document.querySelector('#scheduleWindow').getBoundingClientRect();
            const b = document.querySelector('#directoryWindow').getBoundingClientRect();
            const x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
            const y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
            return document.elementFromPoint(x, y)?.closest('.workspace-window')?.id;
        });
        assert.equal(topAtOverlap, 'directoryWindow', 'pinned window paints above the overlapping iframe');
        await action(page, '#directoryWindow', 'pin').click();
        assert.equal(await action(page, '#directoryWindow', 'pin').getAttribute('aria-pressed'), 'false');
        await page.frameLocator('#appFrame').locator('#draft').click();
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#scheduleWindow')).zIndex)
            > Number(getComputedStyle(document.querySelector('#directoryWindow')).zIndex));
        await page.locator('#resetLayout').click();
        await action(page, '#directoryWindow', 'maximize').click();
        await action(page, '#directoryWindow', 'pin').click();
        await action(page, '#directoryWindow', 'maximize').click();
        await mode(page, '#directoryWindow', 'floating');
        assert.equal(await action(page, '#directoryWindow', 'pin').getAttribute('aria-pressed'), 'true',
            'pinning a maximized docked window keeps it floating when restored');
        await page.frameLocator('#appFrame').locator('#draft').click();
        assert.ok(await z(page, '#directoryWindow') > await z(page, '#scheduleWindow'), 'restore retains the pinned layer');
    });

    await run('Escape cancels a docked drag or floating resize and leaves editors usable', async ({ page }) => {
        await page.frameLocator('#appFrame').locator('#draft').fill(DRAFT);
        const directory = page.locator('#directoryWindow');
        const docked = await rect(directory);
        let title = await rect(page.locator('#directoryWindow .window-titlebar'));
        await page.mouse.move(title.x + 30, title.y + title.height / 2);
        await page.mouse.down();
        await page.mouse.move(title.x - 140, title.y + 140, { steps: 12 });
        await mode(page, '#directoryWindow', 'floating');
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await mode(page, '#directoryWindow', 'docked');
        let after = await rect(directory);
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(closeEnough(after[key], docked[key]), `cancel docked drag ${key}`);
        await action(page, '#directoryWindow', 'float').click();
        const floating = await rect(directory);
        const handle = await rect(page.locator('#directoryWindow .resize-handle[data-edge="se"]'));
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x - 110, handle.y - 95, { steps: 12 });
        assert.ok((await rect(directory)).width < floating.width - 50, 'resize actually began before cancellation');
        await page.keyboard.press('Escape');
        await page.mouse.up();
        after = await rect(directory);
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(closeEnough(after[key], floating[key]), `cancel resize ${key}`);
        assert.equal(await page.locator('#main').evaluate(node => node.classList.contains('is-arranging')), false,
            'cancellation releases the iframe interaction shield');
        await page.frameLocator('#appFrame').locator('#draft').click();
        assert.equal(await page.frameLocator('#appFrame').locator('#draft').inputValue(), DRAFT);
    });

    await run('application tabs reuse frames; floating and minimized windows retain drafts', async ({ page, loads }) => {
        await page.frameLocator('#appFrame').locator('#draft').fill(DRAFT);
        await action(page, '#scheduleWindow', 'float').click();
        await page.locator('#appTabs [data-app="NastavaUredi.html"]').click();
        const teaching = page.frameLocator('iframe[src*="NastavaUredi.html"]');
        await teaching.locator('#draft').fill('Invented teaching draft');
        assert.equal(await page.locator('#scheduleWindow').isVisible(), true, 'floating application remains visible');
        await page.locator('#appTabs [data-app="RasporediFusion.html"]').click();
        await action(page, '#scheduleWindow', 'minimize').click();
        assert.equal(await page.locator('#scheduleWindow').isVisible(), false);
        await page.locator('#appTabs [data-app="RasporediFusion.html"]').click();
        await page.locator('#scheduleWindow').waitFor({ state: 'visible' });
        assert.equal(await page.frameLocator('#appFrame').locator('#draft').inputValue(), DRAFT);
        await action(page, '#scheduleWindow', 'float').click();
        await mode(page, '#scheduleWindow', 'docked');
        await page.locator('#appTabs [data-app="NastavaUredi.html"]').click();
        assert.equal(await page.locator('#scheduleWindow').isVisible(), false, 'inactive docked application is hidden');
        assert.equal(await teaching.locator('#draft').inputValue(), 'Invented teaching draft');
        await page.locator('#appTabs [data-app="RasporediFusion.html"]').click();
        assert.equal(await page.frameLocator('#appFrame').locator('#draft').inputValue(), DRAFT);
        assert.equal(await page.locator('iframe[src*="NastavaUredi.html"]').count(), 1);
        assert.equal(loads.get('RasporediFusion.html'), 1);
        assert.equal(loads.get('NastavaUredi.html'), 1);
    });

    await run('restoring a maximized app after switching tabs keeps that app visible', async ({ page }) => {
        await action(page, '#scheduleWindow', 'maximize').click();
        await page.locator('#appTabs [data-app="NastavaUredi.html"]').click();
        await action(page, '#scheduleWindow', 'maximize').click();
        await mode(page, '#scheduleWindow', 'docked');
        assert.equal(await page.locator('#scheduleWindow').isVisible(), true);
        assert.equal(await page.locator('#app-NastavaUredi').isVisible(), false);
    });

    await run('phone layout keeps window controls within reach', async ({ page }) => {
        const phoneWidth = await page.evaluate(() => ({
            viewport: innerWidth, page: document.documentElement.scrollWidth,
            workspace: document.querySelector('.workspace').getBoundingClientRect().width,
            toolbar: document.querySelector('.topbar').getBoundingClientRect().width
        }));
        assert.ok(phoneWidth.page <= phoneWidth.viewport + 1, `no horizontal page overflow: ${JSON.stringify(phoneWidth)}`);
        assert.equal(await page.locator('#directoryWindow').isVisible(), false, 'phone starts with the schedule available');
        await page.locator('#hidePanel').click();
        await page.locator('#directoryWindow').waitFor({ state: 'visible' });
        for (const selector of ['#scheduleWindow', '#directoryWindow']) {
            for (const name of ['float', 'pin', 'maximize', 'minimize']) {
                const control = action(page, selector, name);
                await control.scrollIntoViewIfNeeded();
                const box = await rect(control);
                assert.ok(box.width > 0 && box.x >= -1 && box.x + box.width <= 391,
                    `${selector} ${name} control fits phone width`);
            }
        }
        await page.locator('#hidePanel').scrollIntoViewIfNeeded();
        await page.locator('#hidePanel').click();
        assert.equal(await page.locator('#directoryWindow').isVisible(), false);
        await page.locator('#hidePanel').click();
        await page.locator('#directoryWindow').waitFor({ state: 'visible' });
    }, { viewport: { width: 390, height: 844 } });

    await run('malformed saved layout falls back to usable windows', async ({ page }) => {
        await mode(page, '#scheduleWindow', 'docked');
        await mode(page, '#directoryWindow', 'docked');
        assert.ok((await rect(page.locator('#directoryWindow'))).width > 200);
    }, { savedLayout: '{invalid workspace JSON' });

    if (floatingLayout) {
        const damaged = JSON.parse(floatingLayout);
        function corruptGeometry(value) {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                if (/^(x|y|left|top)$/i.test(key)) value[key] = -1e9;
                else if (/^(width|height|w|h|dockWidth|directoryWidth)$/i.test(key)) value[key] = 1e9;
                else corruptGeometry(child);
            }
        }
        corruptGeometry(damaged);
        await run('offscreen saved geometry is clamped to the current viewport', async ({ page }) => {
            const main = await rect(page.locator('#main'));
            for (const selector of ['#scheduleWindow', '#directoryWindow']) {
                const title = await rect(page.locator(`${selector} .window-titlebar`));
                assert.ok(title.x >= main.x - 1 && title.y >= main.y - 1,
                    `${selector} title is not stranded above or left of the workspace`);
                assert.ok(title.x + title.width <= main.x + main.width + 1,
                    `${selector} controls stay within the workspace`);
                assert.ok(title.y + title.height <= main.y + main.height + 1,
                    `${selector} title remains reachable`);
            }
        }, { viewport: { width: 1100, height: 760 }, savedLayout: JSON.stringify(damaged) });
    }
} finally {
    await browser.close();
}

console.log(`\n${failures ? `${failures} failed` : 'All workspace browser checks passed'}.`);
process.exitCode = failures ? 1 : 0;
