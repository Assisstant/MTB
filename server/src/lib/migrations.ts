import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';

/** Existing files 014–022 have one outer BEGIN/COMMIT pair. The runner owns it
 * so SQL and its ledger record commit together. Do not edit historical SQL. */
export function migrationBody(sql: string): string {
    let body = sql.replace(/^\uFEFF/, '');
    const begin = /^(\s*(?:(?:--[^\n]*\n)\s*)*)BEGIN\s*;/i;
    const commit = /COMMIT\s*;(\s*(?:(?:--[^\n]*(?:\n|$))\s*)*)$/i;
    if (begin.test(body) !== commit.test(body)) throw new Error('Unpaired outer migration transaction');
    if (begin.test(body)) body = body.replace(begin, '$1').replace(commit, '$1');
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(body)) throw new Error('Unsupported nested migration transaction');
    return body;
}

export async function migrate(client: Client, directory: string, log = console.log) {
    const files = (await readdir(directory)).filter(f => /^\d+_[\w-]+\.sql$/.test(f)).sort();
    if (!files.length) throw new Error('No numbered migrations found');
    const numbers = files.map(f => Number(f.split('_')[0]));
    if (new Set(numbers).size !== numbers.length) throw new Error('Duplicate migration number');
    files.sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
    // Session lock requires direct PostgreSQL or a SESSION pooler, never transaction mode.
    await client.query('SELECT pg_advisory_lock(716284, 1)');
    try {
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
        const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));
        for (const file of files) {
            if (applied.has(file)) { log(`Already applied: ${file}`); continue; }
            const sql = migrationBody(await readFile(join(directory, file), 'utf8'));
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
                log(`Applied: ${file}`);
            } catch (error) {
                await client.query('ROLLBACK');
                const code = (error as { code?: string }).code || 'unknown';
                // SQL details may contain private row values; report file + SQLSTATE only.
                throw new Error(`Migration ${file} failed (SQLSTATE ${code}); rolled back`);
            }
        }
    } finally { await client.query('SELECT pg_advisory_unlock(716284, 1)'); }
}
