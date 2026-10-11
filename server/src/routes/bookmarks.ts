import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enforcing, refuseScope } from '../lib/colleague.js';
import { isCloudOwner } from '../lib/cloud-auth.js';
import { administrator } from '../lib/administrator.js';
import { normalizeBookmarks, readBookmarks, saveBookmarks } from '../lib/bookmarks.js';

const REFUSED = 'Обележувачите се лични: ги гледа и менува само администраторот.';
const SaveBody = z.object({ doc: z.unknown(), expected: z.number().int().min(0) });

/**
 * The administrator's bookmarks (047), read and written only by them — both
 * directions, since they are personal. Outside /api/portal/, so in the cloud
 * the owner's sign-in stands in front of them as well.
 */
/**
 * Whose bookmarks: the administrator's — and in the cloud the owner's Google
 * sign-in already says who that is (owner, 11 Oct 2026: a second sign-in with
 * a PIN, on a page he had opened as himself, read as a mistake). Only while
 * the PIN boundary is off: with MTB_REQUIRE_SIGNIN=1 every write asks for the
 * PIN again (lib/colleague.ts), and the bookmarks ask with them.
 */
async function theirs(req: FastifyRequest): Promise<string> {
    if (!enforcing() && isCloudOwner(req)) return 'owner';
    return administrator(req, REFUSED);
}

export async function bookmarkRoutes(server: FastifyInstance) {
    server.get('/api/bookmarks', async (req, reply) => {
        try { await theirs(req); } catch (err) { return refuseScope(reply, err); }
        return await readBookmarks();
    });

    server.put('/api/bookmarks', async (req, reply) => {
        let by: string;
        try { by = await theirs(req); } catch (err) { return refuseScope(reply, err); }
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
