import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforcing, refuseScope } from '../lib/colleague.js';
import { isCloudOwner } from '../lib/cloud-auth.js';
import { administrator } from '../lib/administrator.js';
import { normalizePortfolio, readPortfolio, savePortfolio } from '../lib/portfolio.js';

const REFUSED = 'Доказите се лични: ги гледа и менува само администраторот.';
const SaveBody = z.object({ doc: z.unknown(), expected: z.number().int().min(0) });

/**
 * Whose evidence: the administrator's — the same answer as for the bookmarks
 * (routes/bookmarks.ts), for the same reason. In the cloud the owner's Google
 * sign-in already says who is asking, so there is no second sign-in while the
 * PIN boundary is off; with MTB_REQUIRE_SIGNIN=1, and on a local server, the
 * administrator's name and PIN are asked.
 */
async function theirs(req: FastifyRequest): Promise<string> {
    if (!enforcing() && isCloudOwner(req)) return 'owner';
    return administrator(req, REFUSED);
}

/**
 * The owner's evidence for the title of mentor (059), read and written only
 * by them. Outside /api/portal/, so in the cloud the owner's sign-in stands in
 * front of it as well.
 */
export async function portfolioRoutes(server: FastifyInstance) {
    server.get('/api/portfolio', async (req, reply) => {
        try { await theirs(req); } catch (err) { return refuseScope(reply, err); }
        return await readPortfolio();
    });

    server.put('/api/portfolio', async (req, reply) => {
        let by: string;
        try { by = await theirs(req); } catch (err) { return refuseScope(reply, err); }
        const body = SaveBody.safeParse(req.body);
        const doc = body.success ? normalizePortfolio(body.data.doc) : null;
        if (!body.success || !doc) return reply.code(400).send({ error: 'Доказите не се во очекуваниот облик.' });
        const saved = await savePortfolio(doc, body.data.expected, by);
        if (saved.ok) return saved;
        return reply.code(409).send({
            error: saved.reason === 'stale'
                ? 'Доказите се сменети од друго место во меѓувреме. Одлучи: земи ги од серверот или препиши ги со овие.'
                : 'Празна листа не ги брише зачуваните докази.',
            reason: saved.reason,
            revision: saved.revision
        });
    });
}
