import type { FastifyInstance } from 'fastify';
import { mirrorMode } from './mirror-config.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mirror mode is an installation boundary, not a hidden-button convention.
 * The database pool is read-only too; this hook supplies the useful refusal
 * before a handler attempts work and makes the mode visible to every client.
 */
export function installMirrorWriteBoundary(
    server: FastifyInstance,
    env: NodeJS.ProcessEnv = process.env
): void {
    if (mirrorMode(env) !== 'readonly') return;
    server.addHook('onRequest', async (req, reply) => {
        if (!WRITE_METHODS.has(req.method) || !req.url.split('?')[0].startsWith('/api/')) return;
        return reply.code(423).send({
            error: 'Ова е локална копија само за читање. Измените се прават во cloud MTB.',
            mirrorReadonly: true
        });
    });
}
