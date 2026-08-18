import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { pool } from './db.js';
import { stateRoutes } from './routes/state.js';
import { dataRoutes } from './routes/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024 // Unified JSON with dossiers can be large
});

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
    methods: ['GET', 'PUT', 'OPTIONS'],
    credentials: false
});

// Serve the existing HTML apps from the repo root, so every device opens
// the same copy: http://localhost:3000/Rasporedi-Unified-Sync-v5.0.html
server.register(fastifyStatic, {
    root: path.resolve(__dirname, '..', '..')
});

server.get('/api/health', async () => {
    const { rows } = await pool.query('SELECT now() AS db_time');
    return { ok: true, db_time: rows[0].db_time };
});

server.register(stateRoutes);
server.register(dataRoutes);

const port = Number(process.env.PORT || 3000);
server.listen({ port, host: '127.0.0.1' })
    .catch((err) => {
        server.log.error(err);
        process.exit(1);
    });
