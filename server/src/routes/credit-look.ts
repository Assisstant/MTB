import type { FastifyInstance } from 'fastify';
import { refuseScope } from '../lib/colleague.js';
import { administrator } from '../lib/administrator.js';
import { DEFAULT_LOOK, authorName, creditLook, lookCss, normalizeLook, saveCreditLook } from '../lib/author.js';

/**
 * The watermark's look (046): anybody may read it — every screen shows it —
 * and only the administrator may change it, once, for everybody (owner,
 * 27 Sep 2026). In the cloud this lives outside /api/portal/, behind the
 * owner's sign-in like every other administrator route.
 */
export async function creditLookRoutes(server: FastifyInstance) {
    server.get('/api/credit-look', async () => ({
        author: authorName(),
        look: await creditLook(),
        defaults: DEFAULT_LOOK
    }));

    server.put('/api/credit-look', async (req, reply) => {
        let by: string;
        try { by = await administrator(req, 'Изгледот на водениот жиг го менува само администраторот.'); }
        catch (err) { return refuseScope(reply, err); }
        const look = normalizeLook(req.body);
        if (!look) {
            return reply.code(400).send({ error: 'Изгледот не е во дозволените граници: боја #rrggbb, букви 10–100 %, '
                + 'обруб 0–100 %, големина 9–16 px.' });
        }
        await saveCreditLook(look, by);
        return { ok: true, look, css: lookCss(look) };
    });
}
