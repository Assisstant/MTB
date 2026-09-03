import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { rolloverSchoolYear, YearRolloverError } from '../lib/year-rollover.js';

const RolloverBody = z.object({
    from: z.string().min(1).max(64),
    to: z.string().regex(/^\d{4}\/\d{4}$/),
    lastGrade: z.string().min(1).max(8).optional(),
    promote: z.boolean().optional(),
    carryStudents: z.boolean().optional(),
    apply: z.boolean().optional()
});

export async function yearWriteRoutes(server: FastifyInstance) {
    /** Preview first, then send the same request with apply=true. */
    server.post('/api/years/rollover', async (req, reply) => {
        const parsed = RolloverBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'school year must look like 2026/2027' });
        }
        const body = parsed.data;
        const client = await pool.connect();
        try {
            if (body.apply) await client.query('BEGIN');
            const result = await rolloverSchoolYear(client, body);
            if (body.apply) await client.query('COMMIT');
            return result;
        } catch (err) {
            if (body.apply) await client.query('ROLLBACK').catch(() => {});
            if (err instanceof YearRolloverError) {
                return reply.code(err.status).send({ error: err.message });
            }
            throw err;
        } finally {
            client.release();
        }
    });
}
