import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import type { Staff } from '../lib/staff-accounts.js';
import { addDays, AttendanceError, calendarContext, closedReason } from '../lib/cabinet-attendance.js';
import { isIsoDate } from '../lib/duty.js';

type Who = { staff: Staff; year: { id: number; label: string }; author: { name: string } };
type Signed = (req: FastifyRequest, reply: FastifyReply) => Promise<Who | null>;
const mark = z.enum(['present', 'absent']).nullable();
const memberBody = z.object({ publicId: z.string().min(1).max(80), active: z.boolean(), expected: z.boolean() }).strict();
const markBody = z.object({ publicId: z.string().min(1).max(80), date: z.string().refine(isIsoDate), status: mark, expected: mark }).strict();
const unavailable = 'Престој уште не е вклучен на овој сервер (миграција 064).';

export function registerPortalStay(server: FastifyInstance, signed: Signed) {
    async function entering(req: FastifyRequest, reply: FastifyReply) {
        const who = await signed(req, reply);
        if (!who) return null;
        if (!who.staff.stay) { reply.code(403).send({ error: 'Немате вклучен пристап за Престој.' }); return null; }
        return who;
    }
    const failed = (reply: FastifyReply, err: any) => {
        if (err instanceof AttendanceError) return reply.code(err.status).send({ error: err.message });
        if (err?.code === '42P01') return reply.code(503).send({ error: unavailable });
        throw err;
    };
    server.get('/api/portal/stay/pupils', async (req, reply) => {
        const who = await entering(req, reply); if (!who) return;
        try {
            const pupils = (await pool.query(`SELECT s.public_id AS "publicId", s.name, e.grade,
                coalesce(p.active,false) AS selected
                FROM student_enrollments e JOIN students s ON s.id=e.student_id
                LEFT JOIN stay_pupils p ON p.school_year_id=e.school_year_id AND p.student_id=s.id AND p.employee_id=$2
                WHERE e.school_year_id=$1 AND e.active AND s.active ORDER BY e.grade,s.name,s.id`, [who.year.id,who.staff.employeeId])).rows;
            return { pupils };
        } catch (err) { return failed(reply,err); }
    });
    server.get('/api/portal/stay', async (req, reply) => {
        const who = await entering(req, reply); if (!who) return;
        const query = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Изберете месец.' });
        const from = query.data.month + '-01';
        if (!isIsoDate(from)) return reply.code(400).send({ error: 'Изберете месец.' });
        const end = new Date(from+'T00:00:00Z');
        end.setUTCMonth(end.getUTCMonth()+1,0);
        const to = end.toISOString().slice(0,10);
        try {
            const context = await calendarContext(pool,who.year.id);
            const key = [who.year.id,who.staff.employeeId,from,to];
            const pupils = (await pool.query(`SELECT s.public_id AS "publicId",s.name,e.grade,
                (p.active AND coalesce(e.active,false) AND s.active) AS selected
                FROM stay_pupils p JOIN students s ON s.id=p.student_id
                LEFT JOIN student_enrollments e ON e.school_year_id=p.school_year_id AND e.student_id=p.student_id
                WHERE p.school_year_id=$1 AND p.employee_id=$2 AND (p.active OR EXISTS (
                    SELECT 1 FROM stay_attendance a WHERE a.school_year_id=p.school_year_id AND a.employee_id=p.employee_id
                      AND a.student_id=p.student_id AND a.day BETWEEN $3 AND $4)) ORDER BY e.grade,s.name,s.id`,key)).rows;
            const marks = (await pool.query(`SELECT s.public_id AS "publicId",a.day AS date,a.status FROM stay_attendance a
                JOIN students s ON s.id=a.student_id WHERE a.school_year_id=$1 AND a.employee_id=$2 AND a.day BETWEEN $3 AND $4`,key)).rows;
            const days = [];
            for (let i=0;i<end.getUTCDate();i++) {
                const date=addDays(from,i);
                days.push({ date, closed: closedReason(date,context), future: date>context.today });
            }
            return { year:who.year.label,month:query.data.month,pupils,marks,days,today:context.today,readOnly:Boolean(who.staff.readOnly) };
        } catch (err) { return failed(reply,err); }
    });
    // Ownership always comes from the session, never from a body or query parameter.
    for (const path of ['pupil','mark'] as const) server.put('/api/portal/stay/'+path, async (req,reply) => {
        const who=await entering(req,reply); if (!who) return;
        const parsed=(path==='pupil'?memberBody:markBody).safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({error:'Проверете го ученикот и избраната ознака.'});
        const body=parsed.data;
        const c=await pool.connect();
        try {
            await c.query('BEGIN');
            const pupil=(await c.query(`SELECT s.id,(s.active AND coalesce(e.active,false)) AS active
                FROM students s LEFT JOIN student_enrollments e ON e.student_id=s.id AND e.school_year_id=$2
                WHERE s.public_id=$1 FOR SHARE OF s`,[body.publicId,who.year.id])).rows[0];
            if (!pupil) throw new AttendanceError(404,'Нема таков ученик.');
            const key=[who.year.id,who.staff.employeeId,pupil.id];
            // The membership row serializes first marks and removal with marking on another device.
            await c.query('INSERT INTO stay_pupils(school_year_id,employee_id,student_id,active) VALUES($1,$2,$3,false) ON CONFLICT DO NOTHING',key);
            const member=(await c.query('SELECT active FROM stay_pupils WHERE school_year_id=$1 AND employee_id=$2 AND student_id=$3 FOR UPDATE',key)).rows[0];
            if ('active' in body) {
                if (body.active && !pupil.active) throw new AttendanceError(409,'Ученикот не е на активниот список за годинава.');
                if (member.active!==body.expected) throw new AttendanceError(409,'Списокот е сменет во меѓувреме. Освежете го.');
                await c.query('UPDATE stay_pupils SET active=$4 WHERE school_year_id=$1 AND employee_id=$2 AND student_id=$3',[...key,body.active]);
            } else {
                const context=await calendarContext(c,who.year.id), closed=closedReason(body.date,context);
                if (closed || body.date>context.today) throw new AttendanceError(400,closed || 'Присуство не се означува однапред.');
                const old=(await c.query('SELECT status FROM stay_attendance WHERE school_year_id=$1 AND employee_id=$2 AND student_id=$3 AND day=$4',[...key,body.date])).rows[0]?.status ?? null;
                if ((!member.active || !pupil.active) && old===null) throw new AttendanceError(403,'Ученикот не е во вашиот список за Престој.');
                if (old!==body.expected) throw new AttendanceError(409,'Ознаката е сменета во друг прозорец. Освежете ја табелата.');
                if (body.status!==old) {
                    if (body.status===null) await c.query('DELETE FROM stay_attendance WHERE school_year_id=$1 AND employee_id=$2 AND student_id=$3 AND day=$4',[...key,body.date]);
                    else await c.query(`INSERT INTO stay_attendance(school_year_id,employee_id,student_id,day,status,marked_by)
                        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(school_year_id,employee_id,student_id,day)
                        DO UPDATE SET status=EXCLUDED.status,marked_by=EXCLUDED.marked_by,updated_at=now()`,[...key,body.date,body.status,who.author.name]);
                    await c.query(`INSERT INTO stay_attendance_changes(school_year_id,employee_id,student_id,day,previous_status,status,marked_by)
                        VALUES($1,$2,$3,$4,$5,$6,$7)`,[...key,body.date,old,body.status,who.author.name]);
                }
            }
            await c.query('COMMIT'); return {ok:true};
        } catch (err) { await c.query('ROLLBACK'); return failed(reply,err); }
        finally { c.release(); }
    });
}
