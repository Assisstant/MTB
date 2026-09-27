import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';

/**
 * Does this installation need updating? (owner, 28 Sep 2026: "a popup before
 * I enter the app, so it's a must I do it if action is needed".)
 *
 *   pendingMigrations — migration files this database has not had. The code
 *                       already expects them, so screens may answer wrongly.
 *   behind            — commits on GitHub not yet pulled here, as of the last
 *                       `git fetch`, which this module runs itself at most
 *                       every half hour, in the background.
 *
 * Only ever READS: fixing it is the „MTB - Azuriraj" shortcut on the machine
 * (scripts/procedures/start/15-update.ps1), never a request from a browser —
 * a button that made the server pull and migrate would be a door for anyone
 * who reaches the page. In the cloud there is no .git and the deploy migrates,
 * so it says nothing there.
 */
export function pendingOf(files: string[], applied: Set<string>): string[] {
    return files.filter((f) => /^\d+_[\w-]+\.sql$/.test(f) && !applied.has(f)).sort();
}

const git = (cwd: string, args: string[], timeout: number) => new Promise<string>((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim()));
});

let remembered: { at: number; value: { pendingMigrations: number; behind: number } } | null = null;
let fetchedAt = 0;

export async function updateStatus(repoRoot: string): Promise<{ pendingMigrations: number; behind: number }> {
    if (remembered && Date.now() - remembered.at < 60_000) return remembered.value;
    let pendingMigrations = 0;
    try {
        const files = await readdir(path.join(repoRoot, 'database', 'migrations'));
        const exists = (await pool.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t;
        const applied = new Set<string>(exists ? (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename) : []);
        pendingMigrations = pendingOf(files, applied).length;
    } catch { /* no migrations folder here (a copy without it): nothing to say */ }
    let behind = 0;
    if (existsSync(path.join(repoRoot, '.git'))) {
        if (Date.now() - fetchedAt > 30 * 60_000) {
            fetchedAt = Date.now();
            void git(repoRoot, ['fetch', '--quiet', 'origin', 'main'], 20_000);   // no network: the last known answer stands
        }
        behind = Number(await git(repoRoot, ['rev-list', '--count', 'HEAD..origin/main'], 5_000)) || 0;
    }
    remembered = { at: Date.now(), value: { pendingMigrations, behind } };
    return remembered.value;
}
