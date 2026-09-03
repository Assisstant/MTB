import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const readRoot = (path: string) => readFile(new URL(path, root), 'utf8');

test('the launchers expose one canonical schedule application', async () => {
    const [start, navigation, hub] = await Promise.all([
        readRoot('start.html'),
        readRoot('app-navigation.js'),
        readRoot('index.html')
    ]);

    assert.match(start, /id:'raspored'[^\n]+file:'RasporediFusion\.html'/);
    assert.doesNotMatch(start, /file:'Rasporedi\.html'/);
    assert.match(navigation, /file: 'RasporediFusion\.html', label: 'Распоред'/);
    assert.doesNotMatch(navigation, /file: 'Rasporedi\.html', label:/);
    assert.match(hub, /NOT_APPS = new Set\([\s\S]*?'Rasporedi\.html'/);
    assert.match(hub, /apps = apps\.filter\(a => !NOT_APPS\.has\(a\.url\)\)/);
});

test('the canonical schedule keeps its database and suite integration', async () => {
    const fusion = await readRoot('RasporediFusion.html');
    for (const required of [
        '<script src="app-navigation.js"></script>',
        "api('/api/years')",
        "api('/api/roster' + query)",
        "api('/api/schedule/sessions' + query)",
        "api('/api/schedule/block'",
        "api('/api/schedule/session'"
    ]) {
        assert.ok(fusion.includes(required), `RasporediFusion is missing ${required}`);
    }
});

test('the pupil development record is one database-first screen, reachable from the suite', async () => {
    const [evidence, navigation, start] = await Promise.all([
        readRoot('AkciskiPlan.html'),
        readRoot('app-navigation.js'),
        readRoot('start.html')
    ]);

    assert.match(navigation, /file: 'AkciskiPlan\.html', label: 'Евидентен лист'/);
    assert.match(start, /file:'AkciskiPlan\.html'/);
    assert.ok(evidence.includes('<script src="app-navigation.js"></script>'),
        'the record page is outside the shared navigation');
    for (const required of [
        "api('GET', '/api/evidence/catalog'",
        "api('PUT', '/api/evidence/score'",
        "api('POST', '/api/evidence/login'"
    ]) {
        assert.ok(evidence.includes(required), `AkciskiPlan is missing ${required}`);
    }

    // The record must have no browser-only fallback: a therapist who believes a
    // mark is saved because the page still shows it is the failure this rewrite
    // removed. Only the sign-in, the server choice and the theme may persist.
    const uses = [...evidence.matchAll(/localStorage\.(get|set|remove)Item\(\s*([A-Za-z_]+|'[^']*')/g)]
        .map((m) => ({ verb: m[1], key: m[2] }));
    const allowed = new Set(['TOKEN_KEY', 'THEME_KEY', 'SELECTED_SERVER_KEY', 'SERVERS_KEY']);
    assert.deepEqual(uses.filter((u) => !allowed.has(u.key)).map((u) => `${u.verb} ${u.key}`),
        ['get LEGACY_KEY'],
        'AkciskiPlan touches something other than the sign-in, the server and the theme');
    // The old app's records are RESCUED from this browser, never rewritten into
    // it: a therapist who has not moved them yet must still find them tomorrow.
    assert.ok(!/localStorage\.(?:set|remove)Item\(\s*LEGACY_KEY/.test(evidence),
        'the legacy store is written or cleared, not just read');
});

test('the action plan is a second document in the same functional record, not another app', async () => {
    const [record, navigation, contract] = await Promise.all([
        readRoot('AkciskiPlan.html'),
        readRoot('app-navigation.js'),
        readRoot('docs/APP-CONTRACT.md')
    ]);

    assert.equal((navigation.match(/file: 'AkciskiPlan\.html'/g) || []).length, 1,
        'shared navigation exposes the pupil record more than once');
    for (const required of [
        'data-doc="prescribed"',
        'data-doc="action"',
        "api('GET', '/api/evidence/sheet-sections?sheet='",
        "api('PUT', '/api/evidence/sheet-section'",
        "api('POST', '/api/evidence/section'",
        "catalog: 'action', categoryId",
        'if (action) return h;'
    ]) {
        assert.ok(record.includes(required), `the combined record is missing ${required}`);
    }
    assert.match(contract, /renders\s+both the prescribed[\s\S]*action plan/i);
    assert.match(contract, /action plan as a separate Word document/i);
    assert.match(contract, /therapist[\s\S]*or in a class assigned to a teacher/i);
});

test('the written contract names Fusion as canonical and the old page as recovery-only', async () => {
    const contract = await readRoot('docs/APP-CONTRACT.md');
    assert.match(contract, /`RasporediFusion\.html` is the only user-facing schedule/i);
    assert.match(contract, /`Rasporedi\.html`.*compatibility/i);
    assert.match(contract, /selected school year.*enrolment/is);
    assert.match(contract, /hostname.*must never choose/is);
    assert.match(contract, /SYNC_NAME=work.*SYNC_NAME=home/is);
});
