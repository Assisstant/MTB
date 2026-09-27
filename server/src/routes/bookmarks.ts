import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { refuseScope } from '../lib/colleague.js';
import { administrator } from '../lib/administrator.js';
import { normalizeBookmarks, readBookmarks, saveBookmarks } from '../lib/bookmarks.js';

const REFUSED = 'Обележувачите се лични: ги гледа и менува само администраторот.';
const SaveBody = z.object({ doc: z.unknown(), expected: z.number().int().min(0) });

/**
 * The administrator's bookmarks (047), read and written only by them — both
 * directions, since they are personal. Outside /api/portal/, so in the cloud
 * the owner's sign-in stands in front of them as well.
 */
export async function bookmarkRoutes(server: FastifyInstance) {
    server.get('/api/bookmarks', async (req, reply) => {
        try { await administrator(req, REFUSED); } catch (err) { return refuseScope(reply, err); }
        return await readBookmarks();
    });

    server.put('/api/bookmarks', async (req, reply) => {
        let by: string;
        try { by = await administrator(req, REFUSED); } catch (err) { return refuseScope(reply, err); }
        const body = SaveBody.safeParse(req.body);
        const doc = body.success ? normalizeBookmarks(body.data.doc) : null;
        if (!body.success || !doc) return reply.code(400).send({ error: 'Обележувачите не се во очекуваниот облик.' });
        const saved = await saveBookmarks(doc, body.data.expected, by);
        if (saved.ok) return saved;
        return reply.code(409).send({
            error: saved.reason === 'stale'
                ? 'Обележувачите се сменети од друго место во меѓувреме. Одлучи: земи ги од серверот или препиши ги со овие.'
                : 'Празна листа не ги брише зачуваните обележувачи.',
            reason: saved.reason,
            revision: saved.revision
        });
    });
}
