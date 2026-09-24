/**
 * A request the server makes to ITSELF (`server.inject`), told apart from one
 * that came over the network.
 *
 * The review queue writes through the routes that own each fact, by
 * injecting a request into this same process. In the cloud
 * those requests met the Google gate with no session cookie and were refused
 * (401) — and a request with no Origin header fails the same-origin check
 * before that. So an injected request carries a secret made at start-up and
 * held only in memory: nothing outside the process can know it, and it is
 * never written anywhere. The owning routes still apply every check of their
 * own (`expected`, clashes, the year); this only answers "is this the server".
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const INTERNAL_HEADER = 'x-mtb-internal';
const secret = randomBytes(32).toString('hex');

export const internalHeaders = (): Record<string, string> => ({ [INTERNAL_HEADER]: secret });

export function isInternal(req: Pick<FastifyRequest, 'headers'>): boolean {
    const offered = req.headers[INTERNAL_HEADER];
    if (typeof offered !== 'string' || offered.length !== secret.length) return false;
    return timingSafeEqual(Buffer.from(offered), Buffer.from(secret));
}
