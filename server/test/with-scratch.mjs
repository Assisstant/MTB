/**
 * Run a browser suite that needs "the server running" against a database of
 * its own, never the real one.
 *
 *     node test/with-scratch.mjs test/podatoci.browser.mjs [more suites…]
 *     npm run test:scratch -- test/podatoci.browser.mjs
 *
 * Those suites write invented, prefixed rows and clean up after themselves,
 * and some delete the diary's document outright (they ask for MTB_SCRATCH_DB=1
 * for that reason). Run against `therapy_dev` they are one bug away from the
 * school's data. Here they cannot be: a schema is made in the configured
 * database, every migration is applied in it, a server is started on a spare
 * port with every connection pinned to that schema (`search_path`; no server
 * code names `public.`), each suite runs with API and DATABASE_URL pointing
 * there, and then the server is stopped and the schema dropped — also when a
 * suite fails. The same setup as diary-offline.browser.mjs.
 */
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suites = process.argv.slice(2);
if (!suites.length) { console.error('Usage: node test/with-scratch.mjs test/<suite>.browser.mjs [...]'); process.exit(2); }
const PORT = Number(process.env.SCRATCH_PORT || 3092);
const BASE = `http://127.0.0.1:${PORT}`;
const SCHEMA = `scratch_run_test_${process.pid}`;
const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!base) throw new Error('Configure a database connection (DATABASE_URL).');
const scoped = new URL(base);
scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);

const admin = new pg.Client({ connectionString: base });
let server;
const results = [];
try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const db = new pg.Client({ connectionString: scoped.href });
    await db.connect();
    const where = (await db.query('SELECT current_schema() AS s')).rows[0].s;
    if (where !== SCHEMA) throw new Error(`refusing: connections resolve to ${where}, not ${SCHEMA}`);
    const dir = resolve(SERVER_DIR, '../database/migrations');
    // Recorded as applied, as the installer does, or the server reports them pending and
    // every page opens behind its update notice.
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        await db.query(readFileSync(resolve(dir, f), 'utf8'));
        await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    }
    await db.end();

    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, DATABASE_URL: scoped.href, PORT: String(PORT), HOST: '127.0.0.1', MTB_CLOUD_AUTH: 'off', MTB_REQUIRE_SIGNIN: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '', output = '', listening = false;
    server.stderr.on('data', (d) => { said += d; });
    // A healthy port might belong to somebody else's server. Only probe it
    // after OUR child reports that it successfully bound this exact address.
    server.stdout.on('data', (d) => {
        output += d;
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, end); output = output.slice(end + 1);
            try {
                const log = JSON.parse(line);
                if (log.pid === server.pid && log.msg === 'Server listening at ' + BASE) listening = true;
            } catch { /* only structured startup messages establish ownership */ }
        }
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
        if (server.exitCode !== null) break;
        try { up = listening && (await fetch(BASE + '/api/health')).ok; } catch { /* not yet */ }
        if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error('the scratch server did not start:\n' + said.slice(-2000));
    console.log(`scratch schema ${SCHEMA}, server ${BASE}`);

    for (const suite of suites) {
        console.log(`\n━━ ${suite}`);
        const code = await new Promise((done) => {
            const child = spawn(process.execPath, ['--import', 'tsx', suite], {
                cwd: SERVER_DIR, stdio: 'inherit',
                env: { ...process.env, API: BASE, DATABASE_URL: scoped.href, MTB_SCRATCH_DB: '1' }
            });
            child.on('exit', (c) => done(c ?? 1));
        });
        results.push([suite, code]);
    }
} catch (err) {
    console.error(err);
    results.push(['setup', 1]);
} finally {
    if (server && server.exitCode === null) server.kill();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => console.error('could not drop', SCHEMA, e.message));
    await admin.end().catch(() => {});
}
console.log('\n' + results.map(([s, c]) => `${c === 0 ? 'ok  ' : 'FAIL'} ${s}`).join('\n'));
process.exit(results.some(([, c]) => c !== 0) ? 1 : 0);
