import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { projectPayload } from '../lib/import-core.js';

// Stage 2.5 — blob endpoints. The whole Unified Sync JSON lives in one
// jsonb row per app, with a version counter for conflict detection.

const AppParam = z.object({
    app: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)
});

const PutBody = z.object({
    baseVersion: z.number().int().min(0),
    payload: z.record(z.unknown()),
    updated_by: z.string().max(120).optional()
});

export async function stateRoutes(server: FastifyInstance) {

    // Current state, or 404 if nothing was ever saved for this app.
    server.get('/api/state/:app', async (req, reply) => {
        const { app } = AppParam.parse(req.params);
        const { rows } = await pool.query(
            'SELECT app, version, payload, updated_at, updated_by FROM app_state WHERE app = $1',
            [app]
        );
        if (rows.length === 0) return reply.code(404).send({ error: 'no state yet', app });
        return rows[0];
    });

    // Save new state. baseVersion must match the stored version, otherwise
    // someone else saved in between and the caller gets 409 with the
    // current server state (same idea as the Supabase cloud module).
    server.put('/api/state/:app', async (req, reply) => {
        const { app } = AppParam.parse(req.params);
        const body = PutBody.parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                'SELECT version FROM app_state WHERE app = $1 FOR UPDATE',
                [app]
            );
            const currentVersion = rows.length ? rows[0].version : 0;

            if (body.baseVersion !== currentVersion) {
                const { rows: current } = await client.query(
                    'SELECT app, version, payload, updated_at, updated_by FROM app_state WHERE app = $1',
                    [app]
                );
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'version conflict', current: current[0] ?? null });
            }

            const newVersion = currentVersion + 1;
            await client.query(
                `INSERT INTO app_state (app, version, payload, updated_at, updated_by)
                 VALUES ($1, $2, $3, now(), $4)
                 ON CONFLICT (app) DO UPDATE
                 SET version = $2, payload = $3, updated_at = now(), updated_by = $4`,
                [app, newVersion, JSON.stringify(body.payload), body.updated_by ?? null]
            );
            await client.query('COMMIT');

            // Project the saved state into the relational tables.
            //
            // Deliberately AFTER the blob is committed and in its own
            // transaction: the blob is what the apps depend on, so a fault in
            // the projection must never stop someone saving their work. A
            // failure is reported back and the tables simply stay one save
            // behind until the next successful save re-projects everything.
            let projection: Record<string, unknown> = { ok: false, skipped: true };
            try {
                const p = await pool.connect();
                try {
                    await p.query('BEGIN');
                    const result = await projectPayload(p, body.payload);
                    await p.query('COMMIT');
                    projection = {
                        ok: true,
                        kind: result.kind,
                        students: result.students,
                        notes: result.report.notes.length,
                        problems: result.report.problems
                    };
                    if (result.report.problems.length) {
                        server.log.warn({ problems: result.report.problems }, 'projection reported problems');
                    }
                } catch (err) {
                    await p.query('ROLLBACK');
                    throw err;
                } finally {
                    p.release();
                }
            } catch (err) {
                server.log.error({ err }, 'projection into relational tables failed');
                projection = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            return { app, version: newVersion, projection };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });
}
