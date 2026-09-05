/**
 * Build git-filter-repo's temporary replacement list from the local database.
 *
 * The output contains real names. It must be outside the repository, used only
 * for the coordinated history rewrite, and deleted immediately afterwards.
 * This command never prints a name and refuses to overwrite an existing file.
 *
 *   npx tsx scripts/write-history-redactions.ts --output=C:\\...\\redactions.txt
 */

import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { bareName } from '../src/lib/import-core.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outputArg = process.argv.slice(2).find((arg) => arg.startsWith('--output='));
if (!outputArg) {
    console.error('Usage: npx tsx scripts/write-history-redactions.ts --output=<outside-repo-path>');
    process.exit(2);
}

const output = resolve(outputArg.slice('--output='.length));
const relativeToRepo = relative(REPO, output);
if (!isAbsolute(output) || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo))) {
    console.error('The redaction list contains private data and must be written outside the repository.');
    process.exit(2);
}

function searchable(raw: string): string | null {
    const stripped = String(raw ?? '')
        .replace(/^\s*[^\s]{1,8}\s+-\s+/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.split(' ').filter(Boolean).length >= 2 ? stripped : null;
}

try {
    const { rows } = await pool.query(
        `SELECT name FROM students
         UNION SELECT name FROM teachers
         UNION SELECT name FROM therapists`
    );
    const identities = new Map<string, string>();
    const addIdentity = (candidate: string | null) => {
        if (!candidate) return;
        const folded = candidate.toLocaleLowerCase('mk-MK');
        if (!identities.has(folded)) identities.set(folded, candidate);
    };
    for (const row of rows) {
        addIdentity(searchable(row.name));
        addIdentity(searchable(bareName(row.name)));
    }

    const variants = new Set<string>();
    for (const name of identities.values()) {
        variants.add(name);
        variants.add(name.toLocaleLowerCase('mk-MK'));
        variants.add(name.toLocaleUpperCase('mk-MK'));
    }
    for (const value of variants) {
        if (value.includes('\0') || value.includes('\n') || value.includes('\r') || value.includes('==>')) {
            throw new Error('A database identity cannot be represented safely as a filter-repo literal.');
        }
    }

    const body = [...variants]
        .sort((a, b) => b.length - a.length || a.localeCompare(b, 'mk-MK'))
        .map((value) => `${value}==>***REMOVED***`)
        .join('\n') + '\n';
    writeFileSync(output, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Prepared ${variants.size} redaction variants for ${identities.size} local identities; no name was printed.`);
} finally {
    await pool.end().catch(() => {});
}
