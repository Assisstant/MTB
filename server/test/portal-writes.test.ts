/**
 * Every write of the colleagues' door is let through the sign-in boundary.
 *
 * Each `/api/portal/` route checks its own session (routes/portal.ts), so the
 * boundary in lib/colleague.ts must list it, or under MTB_REQUIRE_SIGNIN=1 a
 * colleague's own write is refused as an owner-only setting. The list is kept
 * by hand, and a route added without it was exactly the gap this closes: the
 * duty absence and the therapist's own list both shipped missing from it.
 * Reads nothing from a database; the routes are only registered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { portalRoutes } from '../src/routes/portal.js';
import { PUBLIC_WRITES } from '../src/lib/colleague.js';

test('every write route under /api/portal/ is on the boundary\'s list', async () => {
    const app = Fastify();
    const writes: string[] = [];
    app.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        methods.filter((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m))
            .forEach((m) => { if (route.url.startsWith('/api/portal/')) writes.push(`${m} ${route.url}`); });
    });
    await app.register(portalRoutes);
    await app.ready();
    assert.ok(writes.length >= 8, `found ${writes.length} portal writes`);
    const missing = writes.filter((key) => !PUBLIC_WRITES.has(key));
    assert.deepEqual(missing, [], 'a portal write the boundary would refuse');
    await app.close();
});
