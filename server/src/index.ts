import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { pool } from './db.js';
import { stateRoutes } from './routes/state.js';
import { dataRoutes } from './routes/data.js';
import { scheduleWriteRoutes } from './routes/schedule-write.js';
import { rosterWriteRoutes } from './routes/roster-write.js';
import { diaryWriteRoutes } from './routes/diary-write.js';
import { recordWriteRoutes } from './routes/record-write.js';
import { teachingRoutes } from './routes/teaching.js';
import { teachingEditRoutes } from './routes/teaching-edit.js';
import { yearWriteRoutes } from './routes/year-write.js';
import { annualRosterRoutes } from './routes/annual-roster.js';
import { rosterPurgeRoutes } from './routes/roster-purge.js';
import { evidenceRoutes } from './routes/evidence.js';
import { evidenceAuthRoutes } from './routes/evidence-auth.js';
import { categoryRoutes } from './routes/categories.js';
import { mirrorRoutes } from './routes/mirror.js';
import { workspaceRoutes } from './routes/workspace.js';
import { syncStatusRoutes } from './routes/sync-status.js';
import { formReplyRoutes } from './routes/form-replies.js';
import { portalRoutes } from './routes/portal.js';
import { resolveServerIdentity } from './lib/server-identity.js';
import { installColleagueBoundary } from './lib/colleague.js';
import { installMirrorWriteBoundary } from './lib/mirror-boundary.js';
import { installPublicStatic } from './lib/public-static.js';
import { cloudAuthMode, cloudRequestLog, installCloudAuth, listenOptions } from './lib/cloud-auth.js';
import { mirrorMode, mirrorSourceLabel } from './lib/mirror-config.js';
import { mirrorStatus } from './lib/mirror.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({
    logger: {
        // OAuth callback query strings contain authorization codes. Never log
        // request queries, headers, session cookies or provider error objects.
        serializers: { req: cloudRequestLog },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie']
    },
    trustProxy: cloudAuthMode() === 'google', // Render terminates HTTPS; callbacks use configured origin only.
    bodyLimit: 50 * 1024 * 1024 // Unified JSON with dossiers can be large
});
await installCloudAuth(server);

/**
 * The apps are also published on GitHub Pages, so they run from a different
 * origin than this API and need CORS to reach it.
 *
 * An allowlist, never '*': this server holds student data and is reachable at
 * http://localhost:3000 from the same machine, so any website the user happens
 * to visit could otherwise read and overwrite it from their browser.
 * Extra origins can be added with ALLOWED_ORIGINS (comma separated).
 */
const allowedOrigins = [
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    'https://assisstant.github.io'
];

server.register(fastifyCors, {
    origin(origin, cb) {
        // Same-origin and non-browser callers (curl, the scripts) send no Origin.
        if (!origin) return cb(null, true);
        try {
            const { hostname, protocol } = new URL(origin);
            const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
            const isTailnet = hostname.endsWith('.ts.net');
            if (isLocal || isTailnet || allowedOrigins.includes(origin)) return cb(null, true);
        } catch { /* malformed Origin */ }
        server.log.warn({ origin }, 'CORS: origin refused');
        cb(null, false);
    },
    // The per-row endpoints use more than GET and PUT: roster-write is
    // POST/PATCH/DELETE, and progress rebuild is POST. This list was still the
    // blob-only one, which worked by accident -- the apps are served BY this
    // server, so those requests are same-origin and never preflighted. The
    // published GitHub Pages copy is not, and would have been refused the
    // moment anyone pointed it at a tailnet address.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false
});

// Serve only the explicitly public app files from the repo root.  A wildcard
// rooted here without an allowlist also exposes server/.env, .git metadata,
// migrations and ignored local handoff files to every tailnet client.
installPublicStatic(server, path.resolve(__dirname, '..', '..'));

// A mirror rejects every API mutation before the ordinary role boundary. The
// pool also asks PostgreSQL for read-only transactions, so scripts cannot walk
// around this HTTP hook by importing the normal application connection.
installMirrorWriteBoundary(server);

// Install this on the root instance before route plugins are registered.  A
// plugin-local hook would be encapsulated and sibling route plugins could walk
// around it; this perimeter must see every mutating API route, including ones
// added later.
installColleagueBoundary(server);

/**
 * A value unique to this running server, so a caller can tell two machines
 * apart. sync-peer uses it to refuse when it has been pointed at the machine it
 * is running on: with two PCs whose Windows hostname is the same, that mistake
 * is easy to make and otherwise looks like a successful "nothing to do".
 * Regenerated on restart, which is fine — it is only ever compared live.
 */
const INSTANCE = randomUUID();
const SERVER_IDENTITY = resolveServerIdentity();

/**
 * Can this database lower-case Cyrillic?
 *
 * Every name match in the API is `lower(btrim(name)) = $1`, against a value
 * lower-cased in JavaScript. Postgres `lower()` follows the DATABASE's
 * collation, and a cluster created with `--locale=C` — which is the default in
 * a container and on a minimal Linux install — leaves Cyrillic untouched. The
 * comparison then never matches, so "does this therapist already exist?"
 * answers no every time and the insert dies on the unique constraint: a 500
 * with `duplicate key`, which reads as a bug in the endpoint and is not.
 *
 * Cost of finding this the hard way: six endpoint tests failing in six
 * different-looking ways. So it is asked once, out loud.
 */
async function cyrillicFolds(): Promise<boolean> {
    try {
        const { rows } = await pool.query(`SELECT lower('Ѓ') = 'ѓ' AS ok`);
        return rows[0]?.ok === true;
    } catch { return false; }
}

server.get('/api/health', async () => {
    const { rows } = await pool.query('SELECT now() AS db_time, current_database() AS db_name');
    const folds = await cyrillicFolds();
    let mirror: Record<string, unknown> | undefined;
    if (mirrorMode() === 'readonly') {
        try { mirror = await mirrorStatus(pool, mirrorSourceLabel()); }
        catch (err) {
            mirror = { mode: 'readonly', source: mirrorSourceLabel(), pending: true,
                error: err instanceof Error ? err.message : String(err) };
        }
    }
    const warnings = [
        SERVER_IDENTITY.warning,
        ...(folds ? [] : ['this database cannot lower-case Cyrillic (collation C) — name matching will fail']),
        ...(mirror && mirror.pending ? ['mirror mode has no successfully applied snapshot'] : []),
        ...(mirror && mirror.lastError ? [`mirror last attempt failed: ${mirror.lastError}`] : [])
    ].filter(Boolean);
    return {
        ok: true,
        db_time: rows[0].db_time,
        database: rows[0].db_name,
        server: SERVER_IDENTITY,
        instance: INSTANCE,
        // Additive deployment capability: pages can become read-only before a
        // signed-out user presses Save, while the API remains the authority.
        signinRequired: process.env.MTB_REQUIRE_SIGNIN === '1',
        ...(cloudAuthMode() === 'google' ? { cloudAuth: 'google' } : {}),
        ...(mirror ? { mirror } : {}),
        ...(warnings.length ? { warning: warnings.join('; ') } : {})
    };
});

server.register(mirrorRoutes);
server.register(syncStatusRoutes, { repoRoot: path.resolve(__dirname, '..', '..') });
server.register(workspaceRoutes);
server.register(stateRoutes);
server.register(dataRoutes);
server.register(scheduleWriteRoutes);
server.register(rosterWriteRoutes);
server.register(diaryWriteRoutes);
server.register(recordWriteRoutes);
server.register(teachingRoutes);
server.register(teachingEditRoutes);
server.register(yearWriteRoutes);
server.register(annualRosterRoutes);
server.register(rosterPurgeRoutes);
server.register(evidenceAuthRoutes);
server.register(categoryRoutes);
server.register(evidenceRoutes);
server.register(formReplyRoutes);
server.register(portalRoutes);

server.listen(listenOptions())
    .then(async () => {
        if (!(await cyrillicFolds())) {
            server.log.error(
                'This database was created with a collation that does not lower-case Cyrillic (usually locale C). ' +
                'Every name match will fail and adding a therapist will answer 500 "duplicate key". ' +
                'Recreate it with a UTF-8 collation: CREATE DATABASE therapy TEMPLATE template0 ENCODING UTF8 ' +
                "LC_COLLATE 'C.utf8' LC_CTYPE 'C.utf8';"
            );
        }
    })
    .catch((err) => {
        server.log.error(err);
        process.exit(1);
    });
