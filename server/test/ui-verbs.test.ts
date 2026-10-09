/**
 * One word per action, on every screen (owner, 4 Oct 2026: „ист метод
 * насекаде — конфузно е насекаде да имаме различни пристапи").
 *
 * The same action had four names: „Додади" in S-Дневник and „+ Додај" in
 * Податоци, „Измени" beside „✏️ Уреди", „Отстрани" beside „Тргни", „Исчисти"
 * beside „Испразни". A person who learnt one screen read the next as a
 * different operation. The vocabulary is written in docs/APP-CONTRACT.md
 * („One word per action"); this test fails on the first retired word that
 * comes back into a live screen and names the file and the line.
 *
 * Lower-case „измени" is the noun (changes) and stays allowed; the verb is
 * caught where it is a label — capitalised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// The live MTB screens. Rasporedi.html and the older generations are
// compatibility copies (rule 4) and keep the words they were written with.
const SCREENS = [
    'S-Dnevnik.html', 'RasporediFusion.html', 'Podatoci.html', 'Nastava.html', 'NastavaUredi.html',
    'Kolega.html', 'AkciskiPlan.html', 'MTB-Workspace.html', 'start.html', 'Sinhronizacija.html',
    'Pregled-Baza.html', 'mtb-forms.js', 'mtb-teacher-week.js', 'mtb-schedule-form.js', 'mtb-class-form.js',
    'workspace-admin.js', 'app-navigation.js', 'mtb-layout.js'
];

// retired word → the word that replaced it
const RETIRED: Array<[RegExp, string]> = [
    [/(?<!\p{L})[Дд]одади(?!\p{L})/u, '+ Додај'],
    [/(?<!\p{L})Измени(?!\p{L})/u, '✏️ Уреди'],
    [/(?<!\p{L})[Оо]тстрани(?!\p{L})/u, 'Тргни'],
    [/(?<!\p{L})[Ии]счисти(?!\p{L})/u, 'Испразни (a cell or a list) or Избриши (for good)']
];

test('the live screens use one word per action', () => {
    const found: string[] = [];
    for (const file of SCREENS) {
        let text: string;
        try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
        text.split(/\r?\n/).forEach((line, i) => {
            for (const [word, instead] of RETIRED) {
                // Owner's 8 Oct clarification: these are explicit copy directions,
                // not a second name for the ordinary edit button.
                const checked = line.replaceAll('Измени го распоредот во S-Дневник според групниот распоред', '')
                    .replaceAll('Измени го групниот распоред според S-Дневник', '');
                const hit = checked.match(word);
                if (hit) found.push(`${file}:${i + 1} „${hit[0]}" → ${instead}`);
            }
        });
    }
    assert.deepEqual(found, [], `retired words on a live screen:\n  ${found.join('\n  ')}`);
});
