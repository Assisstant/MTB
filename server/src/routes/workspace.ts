import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool as applicationPool } from '../db.js';
import { assertOwner, scopeOf, refuseScope } from '../lib/colleague.js';
import { sha256 } from '../lib/mirror.js';
import { pupilDetailsProblem, validAnnualClass } from '../lib/pupil-membership.js';

const Year = z.string().min(1).max(64);
const Name = z.string().trim().min(1).max(120);
const Expected = z.string().regex(/^[a-f0-9]{64}$/);
const Pupil = z.object({
    year: Year, name: Name, grade: z.string().max(40).nullable(),
    oddelenie: z.enum(['I','II','III','IV','V','VI','VII','VIII','IX']).nullable(),
    enrollmentType: z.enum(['internal','external']), boarding: z.boolean(),
    programme: z.enum(['unknown','standard','modified']),
    placement: z.enum(['unknown','regular','preparatory','observation','none']),
    active: z.boolean(), expected: Expected.optional()
}).strict();
const StaffRole = z.enum(['teacher','therapist','specialist','administration']);
const Employee = z.object({
    year: Year, name: Name, identifier: z.string().trim().max(80).nullable(),
    roles: z.array(StaffRole).max(4), teacherKind: z.enum(['odd','pred']).default('pred'),
    expected: Expected.optional()
}).strict();
class Problem extends Error {
    constructor(public statusCode: number, message: string) { super(message); }
}
const stamp = (row: any) => ({ ...row, expected: sha256(row) });
async function yearRow(c: PoolClient, label: string) {
    const row = (await c.query('SELECT id,label,is_current FROM school_years WHERE label=$1', [label])).rows[0];
    if (!row) throw new Problem(404, 'Учебната година не постои.');
    return row;
}
async function pupilRows(c: PoolClient, yid: number, publicId?: string) {
    return (await c.query(`SELECT s.public_id,s.name,s.active AS globally_active,
        e.active AS annual_active,e.grade,e.oddelenie,e.kind,e.enrollment_type,e.boarding,e.programme,e.placement,
        EXISTS(SELECT 1 FROM student_enrollments x WHERE x.student_id=s.id AND x.school_year_id=$1) AS enrolled,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.id)
          FROM therapist_students ts JOIN therapists t ON t.id=ts.therapist_id
          WHERE ts.student_id=s.id AND ts.school_year_id=$1),'[]'::jsonb) AS therapists
        FROM students s LEFT JOIN student_enrollments e ON e.student_id=s.id AND e.school_year_id=$1
        WHERE ($2::text IS NULL OR s.public_id=$2) ORDER BY s.name,s.public_id`, [yid,publicId ?? null])).rows;
}
async function employeeRows(c: PoolClient, yid: number, id?: number) {
    return (await c.query(`SELECT e.id,e.name,e.identifier,t.id AS teacher_id,h.id AS therapist_id,
        t.kind AS teacher_kind,coalesce(ty.active,false) AS teacher_active,coalesce(hy.active,false) AS therapist_active,
        coalesce((SELECT jsonb_agg(r.role ORDER BY r.role) FROM employee_roles r
          WHERE r.employee_id=e.id AND r.school_year_id=$1 AND r.active),'[]'::jsonb) AS additional_roles
        FROM employees e LEFT JOIN teachers t ON t.employee_id=e.id LEFT JOIN therapists h ON h.employee_id=e.id
        LEFT JOIN teacher_years ty ON ty.teacher_id=t.id AND ty.school_year_id=$1
        LEFT JOIN therapist_years hy ON hy.therapist_id=h.id AND hy.school_year_id=$1
        WHERE e.superseded_by IS NULL AND ($2::integer IS NULL OR e.id=$2) ORDER BY e.name,e.id`, [yid,id ?? null])).rows;
}
async function expectRow(row: any, expected: string | undefined) {
    if (!row) throw new Problem(404, 'Записот не постои.');
    if (!expected || sha256(row) !== expected) throw new Problem(409,
        'Податоците се изменети по вчитувањето. Задржете го внесот, освежете и споредете пред повторно зачувување.');
}

export async function workspaceRoutes(server: FastifyInstance, options: {pool?: Pool} = {}) {
    const pool = options.pool || applicationPool;
    server.setErrorHandler((error: any, _request, reply) => {
        if (error instanceof z.ZodError) return reply.code(400).send({error:'Проверете ги задолжителните полиња и избраните вредности.'});
        const code=error.statusCode || 500;
        return reply.code(code).send({error:code<500?error.message:'Базата не ја потврди промената. Внесот е задржан; обидете се повторно.'});
    });
    async function transaction<T>(fn: (c: PoolClient) => Promise<T>, read = false): Promise<T> {
        const c = await pool.connect();
        try {
            await c.query(read ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
            const out = await fn(c); await c.query('COMMIT'); return out;
        } catch(error: any) {
            await c.query('ROLLBACK').catch(()=>{});
            if (['40001','40P01','23505'].includes(error.code)) throw new Problem(409,
                'Записот е изменет или веќе постои. Освежете и проверете го идентитетот.');
            if (['23514','23503','23502'].includes(error.code)) throw new Problem(400,
                'Избраните податоци не се усогласени со постојните записи.');
            throw error;
        } finally { c.release(); }
    }
    async function owner(req: any, reply: any) {
        try { assertOwner(await scopeOf(req), 'заедничките податоци'); return true; }
        catch(error) { refuseScope(reply,error); return false; }
    }

    server.get('/api/workspace', async (req) => {
        const {year} = z.object({year:Year}).parse(req.query);
        return transaction(async c => {
            const y = await yearRow(c,year);
            const pupils = (await pupilRows(c,y.id)).map(stamp);
            const employees = (await employeeRows(c,y.id)).map(stamp);
            const classes = (await c.query(`SELECT c.id,c.label FROM school_classes c JOIN class_years cy
              ON cy.class_id=c.id WHERE cy.school_year_id=$1 AND cy.active ORDER BY c.sort_key,c.label`,[y.id])).rows;
            return {year:y.label,pupils,employees,classes};
        },true);
    });
    server.get('/api/workspace/pupils/:id/history', async req => {
        const id = z.string().min(1).parse((req.params as any).id);
        return transaction(async c => ({history:(await c.query(`SELECT y.label AS year,e.grade,e.oddelenie,e.active,
          e.enrollment_type,e.boarding,e.programme,e.placement FROM student_enrollments e
          JOIN students s ON s.id=e.student_id JOIN school_years y ON y.id=e.school_year_id
          WHERE s.public_id=$1 ORDER BY y.starts_on DESC`,[id])).rows}),true);
    });
    async function savePupil(req: any, reply: any, create: boolean) {
        if (!await owner(req,reply)) return;
        const b = Pupil.parse(req.body);
        const publicId = create ? `pupil-${randomUUID()}` : String(req.params.id);
        return transaction(async c => {
            const y = await yearRow(c,b.year);
            let previous: any;
            let sid: number;
            if (!create) {
                const lock = (await c.query('SELECT id,active FROM students WHERE public_id=$1 FOR UPDATE',[publicId])).rows[0];
                if (!lock) throw new Problem(404,'Ученикот не постои.');
                previous = (await pupilRows(c,y.id,publicId))[0];
                await expectRow(previous,b.expected);
                if (!lock.active) throw new Problem(409,'Ученикот е глобално архивиран. Архивата прво се проверува во S-Дневник.');
                sid=lock.id;
            } else {
                // Do not guess same-name identity: warn/refuse; an administrator
                // reviews the existing records before intentionally adding a namesake.
                const duplicate=(await c.query('SELECT 1 FROM students WHERE lower(btrim(name))=lower($1)',[b.name])).rowCount;
                if(duplicate) throw new Problem(409,'Веќе има ученик со ова име. Проверете го постојниот запис во Податоци пред додавање истоимен ученик.');
                sid=(await c.query('INSERT INTO students(public_id,name,grade) VALUES($1,$2,$3) RETURNING id',
                    [publicId,b.name,b.grade])).rows[0].id;
            }
            const kind=b.enrollmentType==='external'?'external':b.boarding?'boarding':'internal';
            const issue=pupilDetailsProblem({...b,kind},b.grade,
                create||b.grade!==previous?.grade||b.enrollmentType!==previous?.enrollment_type||b.programme!==previous?.programme||b.placement!==previous?.placement);
            if(issue) throw new Problem(400,issue);
            if((create||b.grade!==previous?.grade)&&!await validAnnualClass(c,y.id,b.grade)) throw new Problem(400,'Паралелката не е активна во избраната година.');
            await c.query(`UPDATE students SET name=$2,grade=CASE WHEN $4 THEN $3 ELSE grade END,updated_at=now() WHERE id=$1`,
                [sid,b.name,b.grade,y.is_current]);
            await c.query(`INSERT INTO student_enrollments(student_id,school_year_id,grade,oddelenie,kind,active,enrollment_type,boarding,programme,placement)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(student_id,school_year_id) DO UPDATE SET
              grade=EXCLUDED.grade,oddelenie=EXCLUDED.oddelenie,kind=EXCLUDED.kind,active=EXCLUDED.active,
              enrollment_type=EXCLUDED.enrollment_type,boarding=EXCLUDED.boarding,programme=EXCLUDED.programme,placement=EXCLUDED.placement`,
                [sid,y.id,b.grade,b.oddelenie,kind,b.active,b.enrollmentType,b.boarding,b.programme,b.placement]);
            return {ok:true,pupil:stamp((await pupilRows(c,y.id,publicId))[0])};
        });
    }
    server.post('/api/workspace/pupils',async(req,reply)=>savePupil(req,reply,true));
    server.put('/api/workspace/pupils/:id',async(req,reply)=>savePupil(req,reply,false));
    server.put('/api/workspace/pupils/:id/therapists',async(req,reply)=>{
        if(!await owner(req,reply))return;
        const b=z.object({year:Year,expected:Expected,therapistIds:z.array(z.number().int().positive()).max(100)}).strict().parse(req.body);
        return transaction(async c=>{
            const y=await yearRow(c,b.year), id=String((req.params as any).id);
            const s=(await c.query('SELECT id,active FROM students WHERE public_id=$1 FOR UPDATE',[id])).rows[0];
            if(!s)throw new Problem(404,'Ученикот не постои.');
            const current=(await pupilRows(c,y.id,id))[0];await expectRow(current,b.expected);
            if(!s.active||!current.annual_active)throw new Problem(409,'Прво активирајте го ученикот во годишниот список.');
            const ids=[...new Set(b.therapistIds)];
            const valid=(await c.query('SELECT therapist_id FROM therapist_years WHERE school_year_id=$1 AND active AND therapist_id=ANY($2::int[])',[y.id,ids])).rows;
            if(valid.length!==ids.length)throw new Problem(400,'Избраниот терапевт не е активен во оваа година.');
            const bookings=(await c.query('SELECT 1 FROM schedule_slots WHERE student_id=$1 AND school_year_id=$2 AND NOT(therapist_id=ANY($3::int[])) LIMIT 1',[s.id,y.id,ids])).rows;
            if(bookings.length)throw new Problem(409,'Прво отстранете ги постојните термини кај терапевтот што го тргате.');
            await c.query('DELETE FROM therapist_students WHERE student_id=$1 AND school_year_id=$2 AND NOT(therapist_id=ANY($3::int[]))',[s.id,y.id,ids]);
            for(const tid of ids)await c.query('INSERT INTO therapist_students(student_id,school_year_id,therapist_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[s.id,y.id,tid]);
            return {ok:true,pupil:stamp((await pupilRows(c,y.id,id))[0])};
        });
    });

    async function saveEmployee(req: any,reply: any,create:boolean) {
        if(!await owner(req,reply))return;
        const b=Employee.parse(req.body);
        return transaction(async c=>{
            const y=await yearRow(c,b.year);let id:number;
            if(create)id=(await c.query('INSERT INTO employees(name,identifier) VALUES($1,$2) RETURNING id',[b.name,b.identifier||null])).rows[0].id;
            else {
                id=z.coerce.number().int().positive().parse(req.params.id);
                await c.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[id]);
                await expectRow((await employeeRows(c,y.id,id))[0],b.expected);
                await c.query('UPDATE employees SET name=$2,identifier=$3 WHERE id=$1',[id,b.name,b.identifier||null]);
            }
            for(const role of ['teacher','therapist'] as const) {
                const table=role==='teacher'?'teachers':'therapists';
                let profile=(await c.query(`SELECT id FROM ${table} WHERE employee_id=$1`,[id])).rows[0];
                if(!profile&&b.roles.includes(role))profile=(await c.query(role==='teacher'
                    ?'INSERT INTO teachers(name,kind,employee_id) VALUES($1,$2,$3) RETURNING id'
                    :'INSERT INTO therapists(name,employee_id) VALUES($1,$2) RETURNING id',
                    role==='teacher'?[b.name,b.teacherKind,id]:[b.name,id])).rows[0];
                if(profile) {
                    if(role==='teacher'&&b.roles.includes(role))await c.query('UPDATE teachers SET kind=$2 WHERE id=$1',[profile.id,b.teacherKind]);
                    await c.query(`INSERT INTO ${role}_years(school_year_id,${role}_id,active) VALUES($1,$2,$3)
                      ON CONFLICT(school_year_id,${role}_id) DO UPDATE SET active=EXCLUDED.active`,[y.id,profile.id,b.roles.includes(role)]);
                }
            }
            for(const role of ['specialist','administration'] as const)await c.query(`INSERT INTO employee_roles(employee_id,school_year_id,role,active)
              VALUES($1,$2,$3,$4) ON CONFLICT(employee_id,school_year_id,role) DO UPDATE SET active=EXCLUDED.active`,[id,y.id,role,b.roles.includes(role)]);
            return {ok:true,employee:stamp((await employeeRows(c,y.id,id))[0])};
        });
    }
    server.post('/api/workspace/employees',async(req,reply)=>saveEmployee(req,reply,true));
    server.put('/api/workspace/employees/:id',async(req,reply)=>saveEmployee(req,reply,false));
    server.post('/api/workspace/employees/:id/link',async(req,reply)=>{
        if(!await owner(req,reply))return;
        const id=z.coerce.number().int().positive().parse((req.params as any).id);
        const b=z.object({year:Year,sourceId:z.number().int().positive(),expected:Expected,sourceExpected:Expected}).strict().parse(req.body);
        if(id===b.sourceId)throw new Problem(400,'Изберете два различни записи.');
        return transaction(async c=>{
            const y=await yearRow(c,b.year);
            await c.query('SELECT id FROM employees WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[id,b.sourceId]]);
            const target=(await employeeRows(c,y.id,id))[0],source=(await employeeRows(c,y.id,b.sourceId))[0];
            await expectRow(target,b.expected);await expectRow(source,b.sourceExpected);
            if((target.teacher_id&&source.teacher_id)||(target.therapist_id&&source.therapist_id))throw new Problem(409,
                'Двата записи имаат ист вид профил. Потребна е посебна проверка на историјата; не се спојуваат автоматски.');
            if(target.identifier&&source.identifier&&target.identifier!==source.identifier)throw new Problem(409,'Идентификаторите на вработените се различни.');
            await c.query('UPDATE employees SET identifier=NULL WHERE id=$1',[b.sourceId]);
            if(!target.identifier&&source.identifier)await c.query('UPDATE employees SET identifier=$2 WHERE id=$1',[id,source.identifier]);
            await c.query('UPDATE teachers SET employee_id=$1 WHERE employee_id=$2',[id,b.sourceId]);
            await c.query('UPDATE therapists SET employee_id=$1 WHERE employee_id=$2',[id,b.sourceId]);
            await c.query(`INSERT INTO employee_roles(employee_id,school_year_id,role,active)
              SELECT $1,school_year_id,role,active FROM employee_roles WHERE employee_id=$2
              ON CONFLICT(employee_id,school_year_id,role) DO UPDATE SET active=employee_roles.active OR EXCLUDED.active`,[id,b.sourceId]);
            await c.query('UPDATE employees SET superseded_by=$1 WHERE id=$2',[id,b.sourceId]);
            await c.query('INSERT INTO employee_identity_links(source_id,target_id) VALUES($1,$2)',[b.sourceId,id]);
            return {ok:true,employee:stamp((await employeeRows(c,y.id,id))[0])};
        });
    });
}
