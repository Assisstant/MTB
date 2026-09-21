import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { databasePoolOptions } from '../src/db.js';
import { mirrorExportRequest, mirrorMode } from '../src/lib/mirror-config.js';
import { installMirrorWriteBoundary } from '../src/lib/mirror-boundary.js';

const KEY = 'mirror-test-key-1234567890-abcdefghijk';

test('mirror mode is explicit and the normal database pool is transaction-read-only', () => {
    assert.equal(mirrorMode({}), 'off');
    assert.equal(mirrorMode({ MTB_MIRROR_MODE: 'readonly' }), 'readonly');
    assert.throws(() => mirrorMode({ MTB_MIRROR_MODE: 'maybe' }), /must be off or readonly/);
    const options = databasePoolOptions({
        DATABASE_URL: 'postgres://example:example@localhost:5432/therapy_mirror?options=-c%20search_path%3Dtest',
        MTB_MIRROR_MODE: 'readonly'
    });
    assert.match(String(options.options), /search_path=test/);
    assert.match(String(options.options), /default_transaction_read_only=on/);
    assert.match(new URL(options.connectionString!).searchParams.get('options')!, /default_transaction_read_only=on/);
});

test('the machine credential authorizes only the exact read-only snapshot endpoint', () => {
    const env = { MTB_MIRROR_EXPORT: '1', MTB_MIRROR_EXPORT_KEY: KEY };
    const request = (method: string, url: string, key = KEY) => ({
        method, url, headers: { authorization: `Bearer ${key}` }
    });
    assert.equal(mirrorExportRequest(request('GET', '/api/mirror/snapshot'), env), true);
    assert.equal(mirrorExportRequest(request('GET', '/api/students'), env), false);
    assert.equal(mirrorExportRequest(request('POST', '/api/mirror/snapshot'), env), false);
    assert.equal(mirrorExportRequest(request('GET', '/api/mirror/snapshot', 'wrong-key'), env), false);
});

test('mirror HTTP mode blocks writes but keeps reads available', async () => {
    const app = Fastify();
    installMirrorWriteBoundary(app, { MTB_MIRROR_MODE: 'readonly' });
    app.get('/api/value', async () => ({ ok: true }));
    app.put('/api/value', async () => ({ saved: true }));
    assert.equal((await app.inject({ method: 'GET', url: '/api/value' })).statusCode, 200);
    const write = await app.inject({ method: 'PUT', url: '/api/value' });
    assert.equal(write.statusCode, 423);
    assert.equal(write.json().mirrorReadonly, true);
    await app.close();
});
