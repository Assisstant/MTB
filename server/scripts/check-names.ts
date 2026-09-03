/**
 * No real name may be committed to this repository.
 *
 *   npm run check:names
 *
 * Rule 1 says student names belong in the local database only, because this
 * repository is public — GitHub Pages serves the apps straight out of it.
 * Rule 6 says the same for the rest of the real data. Both were being broken,
 * for months, by nothing more sinister than illustrating a point: a comment
 * explaining why two children with one name must never be merged is clearer
 * with the actual pair in front of you, and that is exactly how a child's name
 * ends up on the public internet.
 *
 * THE BLOCKLIST IS THE DATABASE. That is the whole idea. A list of real names
 * kept in a file could not live in this repository either — it would be the
 * same leak with a different filename. The one list that already exists, is
 * already local-only and is already gitignored is `students`, `teachers` and
 * `therapists`, so this reads those and greps the tracked files against them.
 *
 * IT NEVER PRINTS THE NAME IT FOUND. A report is a thing that gets pasted into
 * a chat, a log, an issue. So a hit is reported as the file, the line and a
 * masked form — enough to find it, not enough to leak it again.
 *
 * A machine with no database (a fresh clone, CI) gets a warning and a zero
 * exit. This is a guard for the people who have the data, not a gate that
 * blocks everyone else.
 *
 * ONE FALSE POSITIVE IS WORTH HAVING. A test fixture left behind in the
 * database — „Измислен Терапевт" and friends — is a real row, so an invented
 * name in a test file matches it and gets reported. The fix is to clean the
 * fixture, not the file, and this project has already been bitten three times
 * by a suite that wrote a row and did not remove it. So the noise is a second
 * detector rather than a nuisance.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { bareName } from '../src/lib/import-core.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** „Ана Тестова" -> „А••• Т•••••" — findable, not readable. */
const mask = (name: string) =>
    name.split(/\s+/).map((w) => (w.length > 1 ? w[0] + '•'.repeat(w.length - 1) : w)).join(' ');

/**
 * A name is worth searching for only if it is specific enough to mean a
 * person. One word is a first name and would match half the prose in the
 * repository; „Ана" is not evidence of anything.
 */
function searchable(raw: string): string | null {
    // The old roster embedded the class in the name („V-а - Име Презиме"),
    // so strip that the same way every identity match already does.
    const stripped = String(raw ?? '')
        .replace(/^\s*[^\s]{1,8}\s+-\s+/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.split(' ').filter(Boolean).length >= 2 ? stripped : null;
}

let names: string[] = [];
try {
    const { rows } = await pool.query(
        `SELECT name FROM students
         UNION SELECT name FROM teachers
         UNION SELECT name FROM therapists`
    );
    // Keyed on the folded form so „Ана Тестова" and its lower-cased twin are
    // one search term rather than two identical-looking hits.
    const seen = new Map<string, string>();
    const add = (value: string | null) => {
        if (!value) return;
        const key = value.toLocaleLowerCase('mk-MK');
        if (!seen.has(key)) seen.set(key, value);
    };
    for (const row of rows) {
        add(searchable(row.name));
        // Also the form without the class prefix, in case the row still has one.
        const bare = bareName(row.name);
        if (bare.split(' ').filter(Boolean).length >= 2) add(bare);
    }
    names = [...seen.values()];
} catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await pool.end().catch(() => {});
    if (!process.env.DATABASE_URL) {
        console.log('No database is configured on this machine — nothing to check against.');
        console.log(`  (${detail})`);
        process.exit(0);
    }
    console.error('The configured database could not be checked; refusing to report a clean repository.');
    console.error(`  (${detail})`);
    process.exit(1);
}
await pool.end().catch(() => {});

if (!names.length) {
    console.log('The database holds no names — nothing to check against.');
    process.exit(0);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);

const lower = names.map((n) => ({ term: n, needle: n.toLocaleLowerCase('mk-MK') }));
let hits = 0;

for (const file of tracked) {
    const pathText = file.toLocaleLowerCase('mk-MK');
    for (const { term, needle } of lower) {
        if (!pathText.includes(needle)) continue;
        console.log(`  ${file} (path)  ${mask(term)}`);
        hits++;
    }

    const full = join(REPO, file);
    let text: string;
    try {
        text = readFileSync(full, 'utf8');
    } catch { continue; }
    // Cheap rejection first: most files contain no Cyrillic name at all.
    const haystack = text.toLocaleLowerCase('mk-MK');
    for (const { term, needle } of lower) {
        if (!haystack.includes(needle)) continue;
        const line = text.split('\n').findIndex((l) => l.toLocaleLowerCase('mk-MK').includes(needle)) + 1;
        console.log(`  ${file}:${line}  ${mask(term)}`);
        hits++;
    }
}

if (hits) {
    console.error(
        `\n${hits} real name${hits === 1 ? '' : 's'} in tracked files.\n` +
        'This repository is public (GitHub Pages serves from it). Replace them with\n' +
        'invented ones — the tests already use Тестова / Пробен / Измислен.\n'
    );
    process.exit(1);
}
console.log(`Checked ${tracked.length} tracked files against ${names.length} names — none of them appears.`);
