/**
 * Податоци → Ученици: „можеби исто дете двапати" and „Спои" (owner, 4 Oct
 * 2026). The rule and the merge are lib/student-merge.ts; this file is the
 * two doors to them. Outside `/api/portal/`, so in the cloud the owner's gate
 * holds: merging is the administrator's, never a colleague's.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { isMergeRefusal, lookAlikePairs, mergeStudents } from '../lib/student-merge.js';

const MergeBody = z.object({
    keep: z.string().trim().min(1).max(80),
    fold: z.string().trim().min(1).max(80)
});

export async function studentMergeRoutes(server: FastifyInstance) {
    /** Pairs whose names match or differ by a letter per part. Reads only. */
    server.get('/api/roster/look-alike', async (req, reply) => {
        const label = (req.query as any)?.year as string | undefined;
        const { rows } = await pool.query(
            `SELECT id, label FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
            [label ?? null]);
        if (!rows.length) return reply.code(404).send({ error: `no such school year: ${label ?? '(current)'}` });
        return { year: rows[0].label, pairs: await lookAlikePairs(pool, rows[0].id) };
    });

    /** Fold one row into the other, everything with it, in one transaction. */
    server.post('/api/roster/merge', async (req, reply) => {
        const parsed = MergeBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'keep and fold are both required' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const outcome = await mergeStudents(client, parsed.data.keep, parsed.data.fold, 'Списоци и пристап · спојување');
            await client.query('COMMIT');
            return { ok: true, ...outcome };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (isMergeRefusal(err)) return reply.code(409).send({ error: err.message });
            throw err;
        } finally {
            client.release();
        }
    });
}
