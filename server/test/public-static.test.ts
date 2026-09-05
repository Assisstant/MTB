import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import {
    installPublicStatic, isPublicStaticPath, publicStaticFiles
} from '../src/lib/public-static.js';

test('the local server publishes the application shell and nothing below the repo root', () => {
    assert.equal(isPublicStaticPath('/'), true);
    for (const file of publicStaticFiles) {
        assert.equal(isPublicStaticPath('/' + encodeURIComponent(file)), true, file);
    }

    const privatePaths = [
        '/server/.env',
        '/.git/config',
        '/scripts/roster-2026-2027.local.json',
        '/database/migrations/022_evidence_sheets.sql',
        '/docs/APP-CONTRACT.md',
        '/backups/latest.sql',
        '/AGENTS.md',
        '/finish-setup.ps1',
        '/server%2f.env',
        '/%2e%2egit/config',
        '/SERVER/.ENV',
        '/not-yet-reviewed.html'
    ];
    for (const file of privatePaths) {
        assert.equal(isPublicStaticPath(file), false, file);
    }
});

test('the installed static route refuses local configuration and repository internals', async (t) => {
    const server = Fastify({ logger: false });
    installPublicStatic(server, resolve(import.meta.dirname, '..', '..'));
    await server.ready();
    t.after(() => server.close());

    assert.equal((await server.inject({ method: 'GET', url: '/AkciskiPlan.html' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/app-navigation.js' })).statusCode, 200);

    for (const url of [
        '/server/.env',
        '/.git/config',
        '/scripts/roster-2026-2027.local.json',
        '/database/migrations/022_evidence_sheets.sql',
        '/AGENTS.md',
        '/server%2f.env',
        '/%2e%2e/.git/config',
        '/SERVER/.ENV',
        '/not-yet-reviewed.html'
    ]) {
        const response = await server.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 404, url);
    }
});
