import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Which migrations this database has not had yet — read-only, for the update
// step of the front door (scripts/procedures/start/15-update.ps1), which takes
// a backup BEFORE applying any. Prints one JSON line: {"pending":[...]}.
// Like `migrate`, it wants an explicit DATABASE_URL.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL explicitly');
const dir = fileURLToPath(new URL('../../database/migrations/', import.meta.url));
const files = (await readdir(dir)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
const client = new pg.Client({ connectionString: url });
try {
    await client.connect();
    const exists = (await client.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t;
    const applied = new Set(exists ? (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename) : []);
    console.log(JSON.stringify({ pending: files.filter((f) => !applied.has(f)) }));
} catch {
    console.error('Could not read the migration ledger; verify DATABASE_URL and that PostgreSQL is running');
    process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
