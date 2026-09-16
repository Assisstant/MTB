import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installCloudAuth, cloudAuthMode } from '../src/lib/cloud-auth.js';
import { CloudSessionStore } from '../src/lib/google-login.js';
import { fixture, origin, env, headers, sessionCookie } from './google-fixture.js';
test('explicit modes; no Google credentials required locally; misconfiguration fails closed', () => {
    assert.equal(cloudAuthMode({}), 'off');
    assert.equal(cloudAuthMode({ MTB_CLOUD_AUTH: '0' }), 'off');
    assert.equal(cloudAuthMode({ MTB_CLOUD_AUTH: '1' }), 'basic');
    assert.equal(cloudAuthMode({ MTB_CLOUD_AUTH: 'basic' }), 'basic');
    for (const key of ['MTB_GOOGLE_CLIENT_ID', 'MTB_GOOGLE_CLIENT_SECRET', 'MTB_GOOGLE_ALLOWED_EMAIL', 'MTB_SESSION_SECRET']) {
        assert.throws(() => installCloudAuth(Fastify(), { ...env, [key]: '' }));
    }
});

test('Google perimeter: static redirect, API 401, minimal public health and login', async () => {
    const f = await fixture();
    try {
        const page = await f.app.inject({ url: '/S-Dnevnik.html', headers });
        assert.equal(page.statusCode, 302);
        assert.equal(page.headers.location, '/auth/login');
        for (const url of ['/api/private-test', '/api/health', '/api/evidence/therapists']) {
            assert.equal((await f.app.inject({ url, headers })).statusCode, 401);
        }
        assert.deepEqual((await f.app.inject('/healthz')).json(), { ok: true });
        assert.equal((await f.app.inject('/auth/login')).statusCode, 200);
        assert.match((await f.app.inject('/auth/login')).body, /Sign in with Google/);
        assert.equal(f.exchanges(), 0);
    } finally { await f.app.close(); }
});

test('approved identity: rotated session, pages/API, CSRF, inner permissions, logout and replay', async () => {
    const f = await fixture();
    const previous = process.env.MTB_REQUIRE_SIGNIN;
    try {
        const attempt = await f.start();
        const response = await f.callback(attempt);
        assert.equal(response.statusCode, 302, response.body);
        assert.equal(response.headers.location, '/MTB-Workspace.html');
        const cookie = sessionCookie(response);
        assert.ok(cookie && cookie !== attempt.cookie);
        const auth = { ...headers, cookie };
        assert.equal((await f.app.inject({ url: '/S-Dnevnik.html', headers: auth })).statusCode, 200);
        assert.equal((await f.app.inject({ url: '/api/private-test', headers: auth })).statusCode, 200);
        assert.equal((await f.app.inject({ url: '/S-Dnevnik.html', headers: { ...auth, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode, 200);
        assert.equal((await f.app.inject({ url: '/api/private-test', method: 'POST', headers: { ...auth, origin: 'https://evil.example' } })).statusCode, 403);
        assert.equal((await f.app.inject({ url: '/auth/logout', method: 'POST', headers: auth })).statusCode, 403);
        process.env.MTB_REQUIRE_SIGNIN = '1';
        assert.equal((await f.app.inject({ url: '/api/private-test', method: 'POST', headers: { ...auth, origin } })).statusCode, 401);
        assert.equal((await f.callback(attempt)).statusCode, 403, 'callback cannot be replayed');
        assert.equal(f.exchanges(), 1);
        const logout = await f.app.inject({ url: '/auth/logout', method: 'POST', headers: { ...auth, origin } });
        assert.equal(logout.statusCode, 204);
        assert.match(String(logout.headers['set-cookie']), /Expires=Thu, 01 Jan 1970/);
        assert.equal((await f.app.inject({ url: '/api/private-test', headers: auth })).statusCode, 401, 'even a retained cookie is invalid after logout');
        const output = f.logs.join('') + response.body + JSON.stringify(response.headers);
        for (const secret of ['must-not-leak-access-token', 'must-not-leak-refresh-token', 'secret-test-code', env.MTB_GOOGLE_CLIENT_SECRET, env.MTB_SESSION_SECRET]) {
            assert.ok(!output.includes(secret), 'sensitive OAuth data absent from logs/responses');
        }
    } finally {
        if (previous === undefined) delete process.env.MTB_REQUIRE_SIGNIN; else process.env.MTB_REQUIRE_SIGNIN = previous;
        await f.app.close();
    }
});

for (const [label, claims, badSignature] of [
    ['wrong owner', { email: 'other@example.test' }, false],
    ['email alias', { email: 'Owner@example.test' }, false],
    ['unverified', { email_verified: false }, false],
    ['malformed verified claim', { email_verified: 'true' }, false],
    ['missing subject', { sub: '' }, false],
    ['wrong audience', { aud: 'other-client' }, false],
    ['wrong issuer', { iss: 'https://evil.example' }, false],
    ['expired', { exp: 1 }, false],
    ['wrong nonce', { nonce: 'wrong' }, false],
    ['invalid signature', {}, true]
] as const) test(`Google identity rejected: ${label}`, async () => {
    const f = await fixture(claims, badSignature);
    try {
        const attempt = await f.start();
        const response = await f.callback(attempt);
        assert.equal(response.statusCode, 403);
        assert.match(response.body, /Access denied/);
        assert.equal((await f.app.inject({ url: '/api/private-test', headers: { ...headers, cookie: attempt.cookie } })).statusCode, 401);
    } finally { await f.app.close(); }
});

test('missing or mismatched state is refused before token exchange', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.app.inject({ url: '/auth/google/callback?code=anything', headers })).statusCode, 403);
        const attempt = await f.start();
        assert.equal((await f.callback(attempt, 'wrong')).statusCode, 403);
        assert.equal(f.exchanges(), 0);
    } finally { await f.app.close(); }
});

test('session store expires entries and logout removes stored identity', () => {
    const store = new CloudSessionStore();
    store.set('expired', { cookie: { originalMaxAge: 1 }, owner: { sub: 'test', email: 'owner@example.test', expiresAt: Date.now() - 1 } }, assert.ifError);
    store.get('expired', (err, data) => { assert.ifError(err); assert.equal(data, undefined); });
    store.set('active', { cookie: { originalMaxAge: 1000 }, owner: { sub: 'test', email: 'owner@example.test', expiresAt: Date.now() + 1000 } }, assert.ifError);
    store.destroy('active', assert.ifError);
    store.get('active', (err, data) => { assert.ifError(err); assert.equal(data, undefined); });
});
