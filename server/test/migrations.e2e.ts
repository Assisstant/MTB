import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/lib/migrations.js';

// Explicit opt-in only; never fall back to the user's DATABASE_URL or .env.
const target = process.env.CLOUD_TEST_DATABASE_URL;
if (!target) throw new Error('CLOUD_TEST_DATABASE_URL must identify a disposable database');
const client = new pg.Client({ connectionString: target });
const schema = `migration_test_${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), 'mtb-migrations-'));
await client.connect();
try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const actual = fileURLToPath(new URL('../../database/migrations/', import.meta.url));
    // The expected number comes from the ledger of files, not from a literal.
    // It was pinned at 33 while 034-036 existed, so this suite claimed "all
    // migrations" while three were unproven — and the assertion still passed,
    // which is the worst kind of green. Counting the directory keeps the claim
    // true as migrations are added; the atomicity checks below are untouched.
    const expected = (await readdir(actual)).filter(name => name.endsWith('.sql')).length;
    assert.ok(expected > 0, 'no migration files were found to apply');
    const messages: string[] = [];
    await migrate(client, actual, m => messages.push(m));
    assert.equal(messages.filter(m => m.startsWith('Applied:')).length, expected);
    messages.length = 0;
    await migrate(client, actual, m => messages.push(m));
    assert.equal(messages.filter(m => m.startsWith('Already applied:')).length, expected);
    await writeFile(join(directory, '100_failure.sql'), 'BEGIN;\nCREATE TABLE rollback_probe(id int);\nSELECT * FROM missing_test_table;\nCOMMIT;');
    await assert.rejects(migrate(client, directory), /100_failure.sql failed \(SQLSTATE 42P01\); rolled back/);
    assert.equal((await client.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name, null);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='100_failure.sql'")).rows[0].n, 0);
    await writeFile(join(directory, '100_failure.sql'), 'BEGIN;\nCREATE TABLE rollback_probe(id int);\nCOMMIT;');
    await migrate(client, directory, () => {});
    assert.equal((await client.query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='100_failure.sql'")).rows[0].n, 1);
    console.log(`Migrations: all ${expected}, repeat skip, atomic failure, and corrected retry passed`);
} finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
    await rm(directory, { recursive: true, force: true });
}
