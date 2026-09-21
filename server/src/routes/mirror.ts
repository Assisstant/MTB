import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pool as applicationPool } from '../db.js';
import { createMirrorSnapshot } from '../lib/mirror.js';
import { mirrorExportEnabled, mirrorExportKey, mirrorExportRequest } from '../lib/mirror-config.js';
import { resolveServerIdentity } from '../lib/server-identity.js';

export function mirrorRoutes(
    server: FastifyInstance,
    options: { pool?: Pool; env?: NodeJS.ProcessEnv } = {}
) {
    const pool = options.pool || applicationPool;
    const env = options.env || process.env;
    // Fail startup rather than presenting a live service whose export endpoint
    // discovers its missing/weak credential only when a mirror asks for data.
    if (mirrorExportEnabled(env)) mirrorExportKey(env);
    server.get('/api/mirror/snapshot', async (req, reply) => {
        if (!mirrorExportEnabled(env)) return reply.code(404).send({ error: 'Not found' });
        if (!mirrorExportRequest(req, env)) return reply.code(401).send({ error: 'Mirror credential required' });
        const sourceId = resolveServerIdentity(env).id;
        const snapshot = await createMirrorSnapshot(pool, sourceId);
        return reply.header('Cache-Control', 'no-store')
            .header('Content-Disposition', `attachment; filename="${snapshot.snapshotId}.json"`)
            .send(snapshot);
    });
}
