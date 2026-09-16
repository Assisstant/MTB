import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { installCloudAuth, listenOptions } from '../src/lib/cloud-auth.js';
import { installPublicStatic } from '../src/lib/public-static.js';
import { migrationBody } from '../src/lib/migrations.js';
import { installColleagueBoundary } from '../src/lib/colleague.js';

const env = { MTB_CLOUD_AUTH: '1', MTB_CLOUD_USER: 'test-owner',
    MTB_CLOUD_PASSWORD: 'Invented-only:long password 🔑 12345', MTB_CLOUD_ORIGIN: 'https://mtb.example' };
const authorization = 'Basic ' + Buffer.from(`${env.MTB_CLOUD_USER}:${env.MTB_CLOUD_PASSWORD}`).toString('base64');

test('local defaults and explicit host/port; unsafe cloud config fails closed', () => {
    assert.deepEqual(listenOptions({}), { host: '127.0.0.1', port: 3000 });
    assert.deepEqual(listenOptions({ HOST: '0.0.0.0', PORT: '10000' }), { host: '0.0.0.0', port: 10000 });
    assert.throws(() => listenOptions({ PORT: 'NaN' }));
    for (const invalid of [{ MTB_CLOUD_AUTH: 'true' }, { ...env, MTB_CLOUD_PASSWORD: '1234' }, { ...env, MTB_CLOUD_ORIGIN: 'http://mtb.example' }]) {
        assert.throws(() => installCloudAuth(Fastify(), invalid));
    }
});

for (const enabled of [false, true]) test(`server-wide boundary, enabled=${enabled}`, async () => {
    const app = Fastify();
    installCloudAuth(app, enabled ? env : {});
    installPublicStatic(app, fileURLToPath(new URL('../..', import.meta.url)));
    app.register(async child => {
        child.get('/api/private-test', async () => ({ protected: true }));
        child.post('/api/private-test', async () => ({ saved: true }));
        child.get('/api/health', async () => ({ privateMetadata: true }));
    });
    try {
        for (const url of ['/S-Dnevnik.html', '/api/private-test', '/api/health', '/mtb-runtime.js']) {
            assert.equal((await app.inject({ url })).statusCode, enabled ? 401 : 200, url);
            assert.equal((await app.inject({ url, headers: { authorization } })).statusCode, 200, url);
        }
        assert.deepEqual((await app.inject('/healthz')).json(), { ok: true });
        assert.equal((await app.inject({ url: '/server/.env', headers: { authorization } })).statusCode, 404);
        if (enabled) {
            assert.equal((await app.inject({ url: '/missing' })).statusCode, 401);
            for (const auth of ['Basic !!!', 'Basic ' + Buffer.from('wrong:password').toString('base64'), 'Bearer token']) {
                assert.equal((await app.inject({ url: '/api/private-test', headers: { authorization: auth } })).statusCode, 401);
            }
            assert.equal((await app.inject({ url: '/api/private-test', method: 'POST', headers: { authorization, origin: 'https://evil.example' } })).statusCode, 403);
            assert.equal((await app.inject({ url: '/api/private-test', method: 'POST', headers: { authorization, origin: env.MTB_CLOUD_ORIGIN } })).statusCode, 200);
            assert.equal((await app.inject({ url: '/api/private-test', headers: { authorization, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
            assert.equal((await app.inject({ url: '/healthz', method: 'POST' })).statusCode, 401);
            assert.match((await app.inject('/S-Dnevnik.html')).headers['www-authenticate'] as string, /Basic/);
            assert.equal((await app.inject({ url: '/S-Dnevnik.html', headers: { authorization } })).headers['cache-control'], 'no-store');
        }
    } finally { await app.close(); }
});

test('migration wrapper ownership preserves SQL and rejects unpaired transactions', () => {
    assert.equal(migrationBody('-- note\nBEGIN;\nSELECT 1;\nCOMMIT;\n'), '-- note\n\nSELECT 1;\n\n');
    assert.equal(migrationBody('SELECT 1;'), 'SELECT 1;');
    assert.throws(() => migrationBody('BEGIN; SELECT 1;'));
});

test('valid outer credentials do not bypass colleague authorization', async () => {
    const previous = process.env.MTB_REQUIRE_SIGNIN;
    process.env.MTB_REQUIRE_SIGNIN = '1';
    const app = Fastify();
    installCloudAuth(app, env);
    installColleagueBoundary(app);
    app.post('/api/test/unlisted-cloud-write', async () => ({ saved: true }));
    try {
        const response = await app.inject({ method: 'POST', url: '/api/test/unlisted-cloud-write', headers: { authorization } });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers['www-authenticate'], undefined, 'refusal comes from the inner boundary');
    } finally {
        await app.close();
        if (previous === undefined) delete process.env.MTB_REQUIRE_SIGNIN;
        else process.env.MTB_REQUIRE_SIGNIN = previous;
    }
});
