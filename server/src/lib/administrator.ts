import type { FastifyRequest } from 'fastify';
import { isAdmin, scopeOf } from './colleague.js';
import { Refused, whoIsSigned } from './evidence.js';

/**
 * The administrator named in MTB_ADMIN, signed in with their PIN — or a local
 * maintenance script carrying the service key. Anyone else is refused, and the
 * refusal says why, including that no administrator is configured at all.
 *
 * One door for everything only the administrator may do: the review queue of
 * offline form answers (040) and the watermark's look (046). `refusal` is what
 * a signed-in non-administrator is told; the missing-MTB_ADMIN message is the
 * same everywhere, because the fix is the same everywhere.
 */
export async function administrator(req: FastifyRequest, refusal: string): Promise<string> {
    const scope = await scopeOf(req);
    if (!scope.open && scope.service) return 'service';
    if (!(process.env.MTB_ADMIN || '').trim()) {
        throw new Refused(403, 'Нема поставен администратор. Во server/.env додај MTB_ADMIN=therapist:Име Презиме '
            + '(или teacher:Име Презиме) и рестартирај го серверот.', { needsAdmin: true, noAdmin: true });
    }
    const signed = await whoIsSigned(req.headers['x-mtb-evidence-token']);
    if (!isAdmin(signed)) {
        throw new Refused(403, refusal, { needsAdmin: true });
    }
    return signed.name;
}
