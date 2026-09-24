/**
 * One name per MTB app, in every place a person reads it.
 *
 * Until 23 Sep 2026 the same app was named in five places and differently in
 * most of them — the EduHub card („Распоред — 40 минути"), the start page, the
 * workspace tab („Паралелки / списоци"), the shared bar, the browser tab
 * („S-Dnevnik"). Each list was edited on its own, so each drifted on its own.
 * This table is the name; the test reads the five places and fails on the
 * first one that says something else. Change a name HERE and in the files
 * together, or the test says which file was forgotten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const NAMES: Record<string, string> = {
    'MTB-Workspace.html': 'Работен простор',
    'start.html': 'Сите апликации',
    'RasporediFusion.html': 'Кабинети',
    'Nastava.html': 'Настава ↔ терапии',
    'NastavaUredi.html': 'Уреди настава',
    'Podatoci.html': 'Податоци',
    'AkciskiPlan.html': 'Евидентен лист',
    'S-Dnevnik.html': 'S-Дневник',
    'Pregled-Baza.html': 'Преглед на базата',
    'Sinhronizacija.html': 'Синхронизација'
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every MTB app has its name as the browser-tab title', () => {
    for (const [file, name] of Object.entries(NAMES)) {
        const title = /<title>([^<]*)<\/title>/.exec(read(file))?.[1];
        assert.equal(title, `${name} — MTB`, file);
    }
});

test('EduHub cards use the same names', () => {
    const hub = read('index.html');
    for (const [file, name] of Object.entries(NAMES)) {
        const found = new RegExp(`'${esc(file)}': \\{ name: '([^']*)'`).exec(hub)?.[1];
        assert.equal(found, name, `index.html FILE_MAPPINGS for ${file}`);
    }
});

test('the start page uses the same names for what it lists', () => {
    const start = read('start.html');
    const listed = [...start.matchAll(/file:'([^']+)',\s*name:'([^']*)'/g)];
    assert.ok(listed.length >= 7, 'start.html lists its apps');
    for (const [, file, name] of listed) assert.equal(name, NAMES[file], `start.html for ${file}`);
});

test('the workspace tabs use the same names', () => {
    const shell = read('MTB-Workspace.html');
    const tabs = [...shell.matchAll(/<button data-app="([^"]+)"[^>]*>([^<]*)<\/button>/g)];
    assert.ok(tabs.length >= 7, 'the workspace has its app tabs');
    for (const [, file, name] of tabs) assert.equal(name, NAMES[file], `MTB-Workspace.html tab for ${file}`);
});

test('the shared bar uses the same names (its „Сите" is the way home, not a name)', () => {
    const nav = read('app-navigation.js');
    const apps = [...nav.matchAll(/\{ file: '([^']+)', label: '([^']*)'/g)];
    assert.ok(apps.length >= 6, 'app-navigation.js lists its apps');
    for (const [, file, label] of apps) {
        if (file === 'start.html') continue;
        assert.equal(label, NAMES[file], `app-navigation.js label for ${file}`);
    }
});
