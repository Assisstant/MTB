import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/lib/migrations.js';

// Deliberately no dotenv fallback: an explicit target is required for this command.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL explicitly before running migrations');
const client = new pg.Client({ connectionString: url });
try {
    await client.connect();
    await migrate(client, fileURLToPath(new URL('../../database/migrations/', import.meta.url)));
} catch (error) {
    const message = error instanceof Error && error.message.startsWith('Migration ') ? error.message : 'Migration command failed; verify the target, connection, and migration files';
    console.error(message);
    process.exitCode = 1;
} finally { await client.end(); }
