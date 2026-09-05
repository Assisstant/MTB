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
 * `therapists`, so this reads those and checks every file Git could commit:
 * the index, the working copy of tracked files, and untracked non-ignored
 * files. Looking only at `git ls-files` misses a newly created fixture; looking
 * only at the working tree misses sensitive content already staged and then
 * edited away locally.
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

const gitFiles = (args: string[]) =>
    execFileSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8').split('\0').filter(Boolean);

// `--cached` is the exact set of paths represented in the index, including a
// force-added ignored file. `--others --exclude-standard` adds new files that
// would otherwise evade the guard until after somebody stages them.
const indexed = gitFiles(['ls-files', '--cached', '-z']);
const untracked = gitFiles(['ls-files', '--others', '--exclude-standard', '-z']);
const candidates = [...new Set([...indexed, ...untracked])];
const indexedSet = new Set(indexed);

const lower = names.map((n) => ({ term: n, needle: n.toLocaleLowerCase('mk-MK') }));
let hits = 0;

function scanText(displayFile: string, text: string, source: string) {
    // Cheap rejection first: most files contain no Cyrillic name at all.
    const haystack = text.toLocaleLowerCase('mk-MK');
    for (const { term, needle } of lower) {
        if (!haystack.includes(needle)) continue;
        const line = text.split('\n').findIndex((l) => l.toLocaleLowerCase('mk-MK').includes(needle)) + 1;
        console.log(`  ${displayFile}:${line} (${source})  ${mask(term)}`);
        hits++;
    }
}

/** Do not let a name stored in a filename defeat the output masking rule. */
function maskedPath(file: string): string {
    let result = file;
    for (const { needle } of lower) {
        let at = result.toLocaleLowerCase('mk-MK').indexOf(needle);
        while (at >= 0) {
            const found = result.slice(at, at + needle.length);
            result = result.slice(0, at) + mask(found) + result.slice(at + needle.length);
            at = result.toLocaleLowerCase('mk-MK').indexOf(needle, at + found.length);
        }
    }
    // Git permits control characters in a path; keep a diagnostic on one line.
    return result.replace(/[\r\n\t]/g, '?');
}

for (const file of candidates) {
    const displayFile = maskedPath(file);
    const pathText = file.toLocaleLowerCase('mk-MK');
    for (const { term, needle } of lower) {
        if (!pathText.includes(needle)) continue;
        console.log(`  ${displayFile} (path)  ${mask(term)}`);
        hits++;
    }

    let indexText: string | null = null;
    if (indexedSet.has(file)) {
        try {
            indexText = execFileSync('git', ['show', `:${file}`], {
                cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'
            });
            scanText(displayFile, indexText, 'index');
        } catch { /* a non-blob entry has no text to scan */ }
    }

    const full = join(REPO, file);
    let workingText: string;
    try {
        workingText = readFileSync(full, 'utf8');
    } catch { continue; }

    // Avoid duplicate reports for the usual index/worktree copy. Normalizing
    // line endings keeps Windows CRLF from making every tracked file look like
    // a second content version.
    const comparable = (value: string) => value.replace(/\r\n?/g, '\n');
    if (indexText == null || comparable(indexText) !== comparable(workingText)) {
        scanText(displayFile, workingText, indexedSet.has(file) ? 'working tree' : 'untracked');
    }
}

if (hits) {
    console.error(
        `\n${hits} real name${hits === 1 ? '' : 's'} in files Git could commit.\n` +
        'This repository is public (GitHub Pages serves from it). Replace them with\n' +
        'invented ones — the tests already use Тестова / Пробен / Измислен.\n'
    );
    process.exit(1);
}
console.log(
    `Checked ${candidates.length} commit-candidate files ` +
    `(${indexed.length} tracked/indexed, ${untracked.length} untracked) against ${names.length} names — none appears.`
);
