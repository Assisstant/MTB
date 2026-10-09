import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
        '/not-yet-reviewed.html',
        // vezbi/ is published file by file, never as a folder.
        '/vezbi/CLAUDE.md',
        '/vezbi/glasovi/',
        '/vezbi/glasovi/not-a-sound.js',
        '/vezbi/../server/.env',
        '/vezbi//index.html',
        '/vezbi\\index.html',
        '/VEZBI/index.html',
        '/wbacc/package.json'
    ];
    for (const file of privatePaths) {
        assert.equal(isPublicStaticPath(file), false, file);
    }
});

test('Вежби за изговор is served from its folder, and every file its page asks for is listed', async (t) => {
    const root = resolve(import.meta.dirname, '..', '..');
    const page = readFileSync(resolve(root, 'vezbi', 'index.html'), 'utf8');
    const sounds = [...page.matchAll(/<script src="(glasovi\/[a-z]+\.js)"><\/script>/g)].map((m) => m[1]);
    assert.equal(sounds.length, 26, 'the page loads one file per sound');
    // A sound added to the page and forgotten in the list would be a blank page
    // on the server and in the cloud while GitHub Pages still showed it.
    for (const file of sounds) {
        assert.equal(isPublicStaticPath('/vezbi/' + file), true, file);
        const audio = '/vezbi/' + file.replace('glasovi/', 'audio/');
        assert.equal(isPublicStaticPath(audio), true, audio);
        assert.ok(readFileSync(resolve(root, audio.slice(1))).length > 100, 'audio bundle exists');
    }
    assert.equal(isPublicStaticPath('/vezbi/audio/not-a-sound.js'), false);
    assert.equal(isPublicStaticPath('/vezbi/audio/private.mp3'), false);
    assert.equal(isPublicStaticPath('/vezbi/audio.js'), true);
    assert.deepEqual(readdirSync(resolve(root, 'vezbi', 'glasovi')).sort(), sounds.map((f) => f.slice(8)).sort());
    // The two tools it frames are the root's own files, one copy of each.
    assert.match(page, /src: '\.\.\/ComuniBoard\.html'/);
    assert.match(page, /src: '\.\.\/WBACC\.html'/);

    const server = Fastify({ logger: false });
    installPublicStatic(server, root);
    await server.ready();
    t.after(() => server.close());
    for (const url of ['/vezbi/', '/vezbi/index.html', '/vezbi/glasovi/p.js', '/vezbi/vezbi.jpg',
        '/vezbi/tabla.jpg', '/vezbi/crtanje.jpg', '/ComuniBoard.html', '/WBACC.html']) {
        assert.equal((await server.inject({ method: 'GET', url })).statusCode, 200, url);
    }
    assert.match((await server.inject({ method: 'GET', url: '/vezbi/' })).body, /<title>Вежби за изговор<\/title>/);
    for (const url of ['/vezbi/glasovi/', '/vezbi/glasovi/x.js', '/vezbi/..%2fserver/.env', '/vezbi/%2e%2e/AGENTS.md']) {
        assert.equal((await server.inject({ method: 'GET', url })).statusCode, 404, url);
    }
});

test('the installed static route refuses local configuration and repository internals', async (t) => {
    const server = Fastify({ logger: false });
    installPublicStatic(server, resolve(import.meta.dirname, '..', '..'));
    await server.ready();
    t.after(() => server.close());

    assert.equal((await server.inject({ method: 'GET', url: '/AkciskiPlan.html' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/app-navigation.js' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/mtb-forms.js' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/mtb-layout.js' })).statusCode, 200);

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
