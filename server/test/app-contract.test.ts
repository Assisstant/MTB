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

test('mirror apply consumes the exact reviewed, gitignored snapshot artifact', async () => {
    const [script, guide, ignore] = await Promise.all([
        readRoot('server/scripts/mirror-pull.ts'),
        readRoot('docs/SUPABASE-MIRROR.md'),
        readRoot('.gitignore')
    ]);
    assert.match(script, /if \(apply && !suppliedFile\)[\s\S]*--apply requires --snapshot-file/);
    assert.match(script, /suppliedFile[\s\S]*readSnapshotArtifact\(suppliedFile\)/);
    assert.match(script, /saveSnapshotArtifact\(snapshot\)/);
    assert.match(guide, /истиот зачуван фајл/);
    assert.match(ignore, /^backups\/$/m);
});

test('every suite screen takes light/dark from the one shared choice', async () => {
    // Before this, six screens followed only the operating system, the
    // workspace was dark-only, and three screens kept their own switch. A page
    // that answers the system on its own again cannot be switched from the
    // others, which is exactly what this closed.
    const pages = ['start.html', 'S-Dnevnik.html', 'RasporediFusion.html', 'Nastava.html',
        'NastavaUredi.html', 'Podatoci.html', 'AkciskiPlan.html', 'Pregled-Baza.html',
        'Sinhronizacija.html', 'MTB-Workspace.html'];
    for (const file of pages) {
        const html = await readRoot(file);
        const head = html.slice(0, html.indexOf('</head>'));
        assert.ok(head.includes('<script src="mtb-theme.js"></script>'),
            `${file} does not load mtb-theme.js in <head>, so it paints before knowing the theme`);
        assert.doesNotMatch(html, /@media\s*\(prefers-color-scheme/,
            `${file} follows the system on its own instead of the suite's choice`);
    }
    // S-Dnevnik's key since before the suite existed: an existing choice carries over.
    assert.match(await readRoot('mtb-theme.js'), /const KEY = 'theme';/);
});

test('the generated documents take their table look from S-Dnevnik, through the standard', async () => {
    // Owner, 23 Sep 2026: the Word files look like S-Dnevnik's — a light
    // header row with its purple line. Before, Распоред printed a grey grid and
    // the евидентен лист a plain #eee row; a generator that paints its own
    // header row again is how they part.
    assert.match(await readRoot('mtb-document.js'),
        /th\{background:#f8f9fa;color:#444;font-weight:bold;text-align:center;border-bottom:2px solid ' \+ ACCENT/);
    for (const file of ['RasporediFusion.html', 'AkciskiPlan.html']) {
        const html = await readRoot(file);
        assert.ok(html.includes('MTBDocument.tableCss'), `${file} does not use the shared table look`);
        // `: 'th{…}'` is the fallback for when the shared file is missing.
        assert.doesNotMatch(html, /(?<!: ')th\{background:#e/, `${file} paints its own header row again`);
    }
});

test('the connected screens take their look from S-Dnevnik, through one stylesheet', async () => {
    // Owner, 23 Sep 2026: S-Dnevnik has the buttons, sizes and header he
    // wants, and the rest follow it. Before, the header was blue in Настава,
    // green in Уреди настава and violet in S-Dnevnik. A page that restates a
    // palette, a header gradient or a button shape is how they drift again.
    const look = await readRoot('mtb-look.css');
    assert.match(look, /--mtb-header: linear-gradient\(135deg, #667eea 0%, #764ba2 100%\)/,
        'the shared header is no longer the S-Dnevnik gradient');
    assert.match(look, /--primary: #667eea;/, 'the shared primary is no longer the S-Dnevnik one');
    assert.match(look, /padding: 12px 25px;/, 'the shared button is no longer the S-Dnevnik size');
    for (const file of ['Nastava.html', 'NastavaUredi.html', 'Podatoci.html', 'Pregled-Baza.html',
        'Sinhronizacija.html', 'start.html']) {
        const html = await readRoot(file);
        const head = html.slice(0, html.indexOf('</head>'));
        const link = head.indexOf('<link rel="stylesheet" href="mtb-look.css">');
        assert.ok(link > 0, `${file} does not load mtb-look.css`);
        assert.ok(link < head.indexOf('<style>'),
            `${file} loads mtb-look.css after its own <style>, so the shared look cannot be refined there`);
        assert.doesNotMatch(head, /--(bg|primary|accent|edit|border|text):\s*#/,
            `${file} states its own palette again`);
        assert.doesNotMatch(head, /\n\s*header \{/, `${file} draws its own header again`);
        assert.doesNotMatch(head, /\n\s*\.btn \{/, `${file} draws its own button again`);
    }
});

test('every generated document takes its font and sizes from the one standard', async () => {
    // Owner, 23 Sep 2026: Times New Roman, 11 pt text, headings a step above.
    // Before, one generator printed Arial 10 pt, another Times 11 PX (8 pt on
    // paper) and a third 12 pt. A generator that states its own body font or
    // a pixel text size again is how they drift apart.
    const standard = await readRoot('mtb-document.js');
    assert.match(standard, /FONT = '"Times New Roman", Times, serif'/);
    assert.match(standard, /body: '11pt', h1: '16pt', h2: '14pt', h3: '12pt'/);
    for (const file of ['S-Dnevnik.html', 'RasporediFusion.html', 'AkciskiPlan.html']) {
        const html = await readRoot(file);
        const head = html.slice(0, html.indexOf('</head>'));
        assert.ok(head.includes('<script src="mtb-document.js"></script>'),
            `${file} does not load the document standard`);
        assert.doesNotMatch(html, /body\{font-family:Arial/,
            `${file} still prints a document in Arial`);
        // `: 'body{…11pt}'` is the fallback for when the shared file is missing.
        assert.doesNotMatch(html, /(?<!: ')body\{font-family:"Times New Roman",serif;font-size:\d+(px|pt)/,
            `${file} states its own body size instead of the standard`);
    }
});
