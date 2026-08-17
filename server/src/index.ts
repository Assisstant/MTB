import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { pool } from './db.js';
import { stateRoutes } from './routes/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024 // Unified JSON with dossiers can be large
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

const port = Number(process.env.PORT || 3000);
server.listen({ port, host: '127.0.0.1' })
    .catch((err) => {
        server.log.error(err);
        process.exit(1);
    });
