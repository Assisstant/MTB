import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { OngoingPlan, PlanRefusal, confirmOngoing, activateOngoing } from '../lib/diary-cabinet-plan.js';
import { mirrorMode } from '../lib/mirror-config.js';
import { GROUP_MAX } from './schedule-write.js';

export async function diaryCabinetPlanRoutes(server: FastifyInstance) {
    // Owner-only through the root default-deny write boundary: this writes
    // the personal diary as well as its owner's shared cabinet schedule.
    server.put('/api/diary/ongoing-plan', async (req, reply) => {
        const parsed = OngoingPlan.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: `Проверете ја неделата и избраните ученици. Еден термин може да има најмногу ${GROUP_MAX} ученици.` });
        try { return await confirmOngoing(parsed.data); }
        catch (e) { if (e instanceof PlanRefusal) return reply.code(e.status).send(e.body); throw e; }
    });
    server.get('/api/diary/ongoing-plan', async () => ({ plans: (await pool.query(
        `SELECT id,from_week,status,problem FROM diary_cabinet_changes
         WHERE status IN ('scheduled','blocked') ORDER BY from_week`)).rows }));
}

export function installOngoingActivation(server: FastifyInstance) {
    if (mirrorMode() === 'readonly') return;
    let running: Promise<void> | null = null;
    let checked = 0;
    const run = async () => {
        if (running) return running;
        if (Date.now() - checked < 1000) return;
        running = (async () => {
            // Old local installations can still start and display the existing
            // migration notice instead of breaking every GET until the updater runs.
            if ((await pool.query("SELECT to_regclass('diary_cabinet_changes') AS table_name")).rows[0].table_name) await activateOngoing();
        })().finally(() => { checked = Date.now(); running = null; });
        return running;
    };
    server.addHook('preHandler', async req => {
        if (/^\/api\/(state|schedule|portal|teaching|diary)\//.test(req.url)) await run();
    });
    let timer: ReturnType<typeof setInterval>;
    server.addHook('onReady', async () => {
        await run();
        timer = setInterval(() => { void run().catch(err => server.log.error({ err }, 'ongoing timetable activation failed')); }, 30000);
        timer.unref();
    });
    server.addHook('onClose', async () => { clearInterval(timer); if (running) await running; });
}
