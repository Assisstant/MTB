import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const backend = process.env.CLOUD_TEST_API;
const user = process.env.MTB_CLOUD_USER;
const password = process.env.MTB_CLOUD_PASSWORD;
if (!backend || !user || !password) throw new Error('Explicit disposable cloud test API and credentials required');
const origin = 'https://mtb.example';
const authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
for (const path of ['/MTB-Workspace.html', '/api/roster', '/api/evidence/therapists', '/api/health', '/mtb-runtime.js']) {
    assert.equal((await fetch(backend + path)).status, 401, path);
    assert.equal((await fetch(backend + path, { headers: { authorization } })).status, 200, path);
}
assert.deepEqual(await (await fetch(backend + '/healthz')).json(), { ok: true });
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
    const native = await browser.newContext({ httpCredentials: { username: user, password } });
    const nativePage = await native.newPage();
    assert.equal((await nativePage.goto(backend + '/MTB-Workspace.html')).status(), 200);
    assert.equal(await nativePage.evaluate(async () => (await fetch('/api/roster')).status), 200,
        'browser-cached Basic credentials cover same-origin API fetches');
    await native.close();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const outside = [], errors = [];
    // Synthetic HTTPS browser origin, backed ONLY by the disposable test server.
    // No DNS, Tailscale, HOME/WORK, or Supabase request can leave this context.
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            if (url.pathname.startsWith('/api/')) outside.push(url.origin);
            return route.abort();
        }
        const response = await route.fetch({ url: backend + url.pathname + url.search,
            headers: { ...route.request().headers(), authorization } });
        await route.fulfill({ response });
    });
    await context.addInitScript(() => {
        localStorage.setItem('sdn_local_server_autosync_v1', '0');
        localStorage.setItem('sdn_local_server_url_v1', 'http://127.0.0.1:1');
        localStorage.setItem('local_server_url_v1', 'http://127.0.0.1:1');
        localStorage.setItem('mtb_podatoci_server_v1', 'http://127.0.0.1:1');
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/S-Dnevnik.html');
    await page.waitForFunction(() => window.SdnLocalSrv);
    assert.equal(await page.evaluate(() => window.SdnLocalSrv.getUrl()), origin);
    for (const file of ['Pregled-Baza.html', 'start.html', 'MTB-Workspace.html', 'RasporediFusion.html']) {
        const requests = [];
        const observe = req => { if (new URL(req.url()).pathname.startsWith('/api/')) requests.push(req.url()); };
        page.on('request', observe);
        await page.goto(origin + '/' + file);
        await page.waitForTimeout(500);
        assert.ok(requests.length, `${file} reads its same-origin API`);
        page.off('request', observe);
    }
    assert.deepEqual(outside, [], 'cloud pages must not select old/local database addresses');
    assert.deepEqual(errors, []);
    console.log('Cloud browser: protected static/API, minimal health, same-origin diary/overview/launcher/workspace/Fusion passed');
} finally { await browser.close(); }
