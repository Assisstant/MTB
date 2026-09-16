import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fixture, origin, headers, COOKIE } from './google-fixture.js';
test('browser Google redirect, secure cookie, visible workspace logout and mobile login', async () => {
    const f = await fixture();
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === 'https://accounts.google.com') {
                f.authorization(url);
                return route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(origin + '/auth/google/callback?code=secret-test-code&state=' + url.searchParams.get('state')) + ')</script>' });
            }
            if (url.origin !== origin) return route.abort();
            const requestHeaders = await route.request().allHeaders();
            const response = await f.app.inject({ method: route.request().method() as 'GET', url: url.pathname + url.search,
                headers: { ...requestHeaders, ...headers }, payload: route.request().postData() || undefined });
            const outgoing = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !['content-length', 'transfer-encoding', 'set-cookie'].includes(key)).map(([key, value]) => [key, String(value)]));
            const setCookie = response.headers['set-cookie'];
            if (setCookie) outgoing['set-cookie'] = (Array.isArray(setCookie) ? setCookie : [setCookie]).join('\n');
            // Browser interception does not re-route every HTTP redirect hop.
            // Navigate explicitly between mocked endpoints so no DNS/network
            // lookup can escape the fixture; inject tests assert the real 302s.
            if (response.statusCode === 302 && response.headers.location) {
                delete outgoing.location;
                outgoing['content-type'] = 'text/html';
                return route.fulfill({ status: 200, headers: outgoing,
                    body: '<script>location.replace(' + JSON.stringify(response.headers.location) + ')</script>' });
            }
            await route.fulfill({ status: response.statusCode, headers: outgoing, body: response.rawPayload });
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/MTB-Workspace.html');
        await page.waitForURL(origin + '/auth/login');
        assert.equal(new URL(page.url()).pathname, '/auth/login');
        await page.getByRole('link', { name: 'Sign in with Google' }).click();
        await page.waitForURL(origin + '/MTB-Workspace.html');
        await page.locator('#mtbCloudLogout').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(async () => (await fetch('/api/private-test')).status), 200);
        assert.ok(!(await page.evaluate(() => document.cookie)).includes(COOKIE));
        const cookies = await context.cookies();
        const ownerCookie = cookies.find(c => c.name === COOKIE)!;
        assert.ok(ownerCookie.secure && ownerCookie.httpOnly && ownerCookie.sameSite === 'Lax');
        page.on('dialog', dialog => dialog.accept());
        await page.locator('#mtbCloudLogout').click();
        await page.waitForURL(origin + '/auth/login');
        assert.equal(await page.evaluate(async () => (await fetch('/api/private-test')).status), 401);
        await page.setViewportSize({ width: 390, height: 844 });
        await mkdir('../backups/google-login-qa', { recursive: true });
        await page.screenshot({ path: '../backups/google-login-qa/login-mobile.png', fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await f.app.close(); }
});
