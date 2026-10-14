// „🔍 Барај" in the workspace (owner, 14 Oct 2026): every place it names exists
// in the app it names, and the words people use find the right place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { publicStaticFiles } from '../src/lib/public-static.js';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const context: any = {};
vm.runInNewContext(read('mtb-search.js'), context);
const { DESTINATIONS, search } = context.MTBSearchData as { DESTINATIONS: any[]; search: (q: string) => any[] };
const all = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((m) => m[1]));

/** What each app answers to, read from the app itself. */
const views: Record<string, Record<string, Set<string>>> = {
    'Podatoci.html': { tab: all(read('Podatoci.html'), /data-tab="([a-z-]+)"/g) },
    'RasporediFusion.html': { panel: all(read('RasporediFusion.html'), /data-panel="([a-z-]+)"/g) },
    'Nastava.html': { view: all(read('Nastava.html').match(/const VIEW_BUTTONS = \{([^}]+)\}/)![1], /(\w+):/g) },
    'NastavaUredi.html': { view: all(read('NastavaUredi.html').match(/const VIEWS = \[([^\]]+)\]/)![1], /'(\w+)'/g) },
    'S-Dnevnik.html': { tab: all(read('S-Dnevnik.html'), /<button class="tab[^"]*" onclick="switchTab\('(\w+)'\)/g) },
    'AkciskiPlan.html': { tab: all(read('AkciskiPlan.html'), /<button class="tab[^"]*" data-p="(\w+)"/g) },
    'Pregled-Baza.html': {}
};

test('every place named by the search exists where it says', () => {
    const apps = all(read('MTB-Workspace.html'), /data-app="([^"]+)"/g);
    const adminTabs = all(read('workspace-admin.js'), /data-ma-tab="(\w+)"/g);
    const kolegaTabs = all(read('Kolega.html'), /tabs\.push\(\{ id: '([a-z-]+)'/g);
    assert.equal(new Set(DESTINATIONS.map((d) => d.title)).size, DESTINATIONS.length, 'titles are unique');
    for (const d of DESTINATIONS) {
        const g = d.go;
        assert.ok(d.words.length && d.path, d.title);
        if (g.app) {
            assert.ok(apps.has(g.app), `${d.title}: ${g.app} is not a window of the workspace`);
            for (const [key, value] of Object.entries(g.view || {})) {
                assert.ok(views[g.app][key]?.has(value as string), `${d.title}: ${g.app} has no ${key}=${value}`);
            }
        } else if (g.admin) assert.ok(adminTabs.has(g.admin), `${d.title}: Администрација has no ${g.admin}`);
        else {
            const [file, hash] = String(g.page).split('#');
            assert.ok(publicStaticFiles.includes(file), `${d.title}: ${file} is not published`);
            const tab = new URLSearchParams(hash || '').get('tab');
            if (tab) assert.ok(kolegaTabs.has(tab), `${d.title}: Колега has no tab ${tab}`);
        }
    }
    assert.ok(publicStaticFiles.includes('mtb-search.js'));
});

test('the words people use find the place, in either alphabet', () => {
    const first = (q: string) => search(q)[0]?.title;
    assert.equal(first('превоз'), 'Надворешни ученици — превоз');
    assert.equal(first('prevoz'), 'Надворешни ученици — превоз', 'Latin finds Cyrillic');
    assert.equal(first('ЕКСТЕРНИ превоз'), 'Надворешни ученици — превоз');
    assert.equal(first('лозинка'), 'Колеги — сметки и пристап');
    assert.equal(first('lozinka'), 'Колеги — сметки и пристап');
    assert.equal(first('аудиограм'), 'Дневник — Аудиограми');
    assert.equal(first('ученици по терапевт'), 'Ученици по терапевт');
    for (const typed of ['ucenici po terapevt', 'uchenici po terapevt', 'učenici po terapevt', 'УЧЕНИЦИ по terapevt']) {
        assert.equal(first(typed), 'Ученици по терапевт', typed);
    }
    assert.equal(first('дежурство'), 'Колега — Дежурства');
    assert.equal(first('dezurstvo'), 'Колега — Дежурства');
    assert.ok(search('присуство').some((d) => d.title === 'Колега — Присуство'));
    // The answers come from the script's own realm, so they are counted, not compared as arrays.
    assert.equal(search('нешто-што-го-нема-никаде').length, 0);
    assert.equal(search('   ').length, 0);
    assert.ok(search('а').length <= 8, 'at most eight answers');
});
