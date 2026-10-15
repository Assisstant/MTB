import type { FastifyRequest } from 'fastify';
import { enforcing, isAdmin, scopeOf } from './colleague.js';
import { isCloudOwner } from './cloud-auth.js';
import { Refused, whoIsSigned, type Signed } from './evidence.js';

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

/**
 * The owner in Евидентен лист without a PIN (owner, 15 Oct 2026: „кај
 * администратор не мора најава… да можам да ги разгледувам сите", and the
 * contents will be corrected, so also written). Only the owner's own Google
 * sign-in in the cloud, and only while the PIN boundary is off — the same
 * rule as the bookmarks (11 Oct). A PIN, when one is sent, always wins: a
 * colleague at the owner's computer is still themselves.
 *
 * The owner has no row of their own here: `kind: 'owner'` is never a
 * therapist or a teacher, so nothing writes 0 into a person's column, and the
 * record says „Администраторот", as the colleagues' door does for an
 * administrator's entry.
 */
export const OWNER_AUTHOR = 'Администраторот';
export type OwnerSigned = { kind: 'owner'; personId: 0; name: string; therapistId: null };

export function evidenceOwner(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env): OwnerSigned | null {
    const token = req.headers['x-mtb-evidence-token'];
    if (typeof token === 'string' && token.trim()) return null;
    if (enforcing() || !isCloudOwner(req, env)) return null;
    return { kind: 'owner', personId: 0, name: OWNER_AUTHOR, therapistId: null };
}

export async function signedOrOwner(req: FastifyRequest): Promise<Signed | OwnerSigned> {
    return evidenceOwner(req) ?? whoIsSigned(req.headers['x-mtb-evidence-token']);
}
