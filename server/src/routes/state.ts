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

/**
 * Which apps are allowed to write the shared relational tables.
 *
 * `projectPayload` decides what a payload IS by looking at its shape, not at
 * who sent it. That was fine while only the two real apps existed. It stopped
 * being fine the moment an experimental fork appeared: a prototype carrying a
 * few invented therapists and a test roster is Rasporedi-shaped, so saving it
 * would rewrite `students`, `therapists` and `schedule_slots` — the tables the
 * real apps and every report read from. The near-empty-payload safeguard in
 * import-core does not catch it, because a test roster is not near-empty.
 *
 * So the slug decides. An app not named here still gets full blob storage,
 * versioning and conflict detection — it simply cannot reach the tables.
 * Adding a fork here is a deliberate act, which is the point.
 *
 * A slug ending in `-test` also projects: the e2e suites save under names like
 * `sdnevnik-test` precisely so they never touch the real blob, and what they
 * assert afterwards is the state of the tables. Declaring yourself a fixture
 * in your own name is a conscious act too — and it is one a therapist opening
 * a forked HTML file cannot perform by accident.
 */
const PROJECTING_APPS = new Set(['unified', 'rasporedi', 'sdnevnik']);

export function appMayProject(app: string): boolean {
    return PROJECTING_APPS.has(app) || app.endsWith('-test');
}

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

            // FOR UPDATE cannot lock a row which does not exist yet. Without
            // this per-app transaction lock, two first saves could both read
            // version 0 and both return success, with the second silently
            // replacing the first. The advisory lock also covers that empty
            // row gap; existing rows still use FOR UPDATE below.
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext('app_state:' || $1))`,
                [app]
            );
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

            // The blob and its relational projection are one state, not two
            // best-effort copies. Committing the blob first used to let the API
            // report a successful save while the tables still described the
            // previous version. Sync clients then recorded a false agreement
            // and had no reason to retry the failed projection.
            //
            // Keep both writes in this transaction. If projection throws, the
            // app_state update rolls back too; the caller keeps its local copy
            // and can retry without any false watermark or green sync status.
            let projection: Record<string, unknown>;
            if (appMayProject(app)) {
                // A save from an app may CREATE a person and may not restate
                // one. `Podatoci.html` owns names, classes, kinds and
                // caseloads now, and a browser open since morning holds the
                // roster as it was then — so without this, one press of
                // „Зачувај на сервер" undoes an afternoon of corrections.
                // A JSON FILE import is exempt (import-json.ts): that is
                // rule 4's escape hatch and it has to restore everything.
                const result = await projectPayload(client, body.payload, { rosterOwned: true });
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
            } else {
                // Saved, versioned, and readable back — but kept out of the
                // tables the real apps share. Say so in the response rather
                // than reporting a success the caller would misread.
                projection = {
                    ok: true,
                    kind: 'blob only',
                    skipped: `app "${app}" is not on the projection list; state stored without touching the shared tables`,
                    students: 0,
                    notes: 0,
                    problems: []
                };
                server.log.info({ app }, 'state stored as blob only — app is not a projecting app');
            }

            await client.query('COMMIT');
            return { app, version: newVersion, projection };
        } catch (err) {
            await client.query('ROLLBACK');
            server.log.error({ err, app }, 'state save and relational projection rolled back');
            throw err;
        } finally {
            client.release();
        }
    });
}
