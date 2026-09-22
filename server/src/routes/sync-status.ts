import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pool as applicationPool } from '../db.js';
import { resolveServerIdentity } from '../lib/server-identity.js';
import {
    codeMigrations, latestBackup, migrationGap, syncNames, transportDirs, transportStatus
} from '../lib/sync-status.js';

/**
 * `GET /api/sync/status` — where this installation's data stands, for the
 * „Синхронизација и резерви" page. It reads; it never exports, compares or
 * restores. Those stay in `manual-db-sync.ps1` / `git-sync.ps1`, with a person
 * at the keyboard, because accepting a snapshot replaces a whole database.
 *
 * Only the documents that are sync units are listed from `app_state`: the
 * e2e suites save under `*-test` slugs and those are nobody's diary.
 */
const DOCUMENT_APPS = ['sdnevnik', 'rasporedi', 'unified'];

export function syncStatusRoutes(
    server: FastifyInstance,
    options: { pool?: Pool; env?: NodeJS.ProcessEnv; repoRoot: string }
) {
    const pool = options.pool || applicationPool;
    const env = options.env || process.env;
    const { repoRoot } = options;

    server.get('/api/sync/status', async (_req, reply) => {
        const identity = resolveServerIdentity(env);
        const names = syncNames(env);
        const dirs = transportDirs(env, repoRoot);

        // Each read answers alone: a database that predates a table still gets
        // the rest of the page, rather than one missing relation blanking it.
        let applied: string[] | null = null;
        try {
            const { rows } = await pool.query<{ filename: string }>(
                'SELECT filename FROM schema_migrations ORDER BY filename');
            applied = rows.map((r) => r.filename);
        } catch { applied = null; }

        let documents: Array<{ app: string; version: number; updatedAt: string; updatedBy: string | null }> = [];
        try {
            const { rows } = await pool.query(
                `SELECT app, version, updated_at, updated_by FROM app_state
                  WHERE app = ANY($1::text[]) ORDER BY app`, [DOCUMENT_APPS]);
            documents = rows.map((r) => ({
                app: r.app,
                version: Number(r.version),
                updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
                updatedBy: r.updated_by ?? null
            }));
        } catch { documents = []; }

        const inCode = await codeMigrations(repoRoot);
        const [git, pcloud, backup] = await Promise.all([
            transportStatus('git', dirs.git, names.me, names.peer),
            transportStatus('pcloud', dirs.pcloud, names.me, names.peer),
            latestBackup(repoRoot)
        ]);

        return reply.header('Cache-Control', 'no-store').send({
            server: identity,
            me: names.me,
            peer: names.peer,
            migrations: applied ? migrationGap(applied, inCode) : null,
            documents,
            transports: [git, pcloud],
            backup
        });
    });
}
