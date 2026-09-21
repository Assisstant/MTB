import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import pg from 'pg';
import Fastify from 'fastify';
import {workspaceRoutes} from '../src/routes/workspace.js';

const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL||'postgres://therapy:therapy_local@localhost:5432/therapy_dev';
const schema=`workspace_admin_test_${process.pid}`;
const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:scoped.href});
const app=Fastify();
app.setErrorHandler((e:any,_req,reply)=>reply.code(e.name==='ZodError'?400:e.statusCode||500).send({error:e.message}));
const year='2025/2026', later='2026/2027';
async function call(method:any,path:string,body?:any,status=200){
 const res=await app.inject({method,url:path,payload:body});
 assert.equal(res.statusCode,status,res.body);return res.json();
}
const snapshot=()=>call('GET',`/api/workspace?year=${encodeURIComponent(year)}`);
before(async()=>{
 const c=new pg.Client({connectionString:url});await c.connect();await c.query(`CREATE SCHEMA "${schema}"`);await c.end();
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pool.query(readFileSync(resolve(dir,file),'utf8'));
 await pool.query("INSERT INTO school_years(label,starts_on,ends_on) VALUES($1,'2026-09-01','2027-08-31') ON CONFLICT DO NOTHING",[later]);
 const cls=(await pool.query("INSERT INTO school_classes(label) VALUES('Пробна К-1') RETURNING id")).rows[0];
 await pool.query('INSERT INTO class_years(class_id,school_year_id) SELECT $1,id FROM school_years',[cls.id]);
 await app.register(workspaceRoutes,{pool});await app.ready();
});
after(async()=>{await app.close();await pool.end();const c=new pg.Client({connectionString:url});await c.connect();await c.query(`DROP SCHEMA "${schema}" CASCADE`);await c.end();});

test('pupil annual facts, stale writes, legacy kind and preserved history',async()=>{
 const body={year,name:'Измислен Пример Алфа',grade:'Пробна К-1',oddelenie:'II',enrollmentType:'external',boarding:false,programme:'modified',placement:'preparatory',active:true};
 const {pupil}=await call('POST','/api/workspace/pupils',body);
 assert.equal(pupil.kind,'external');assert.equal(pupil.oddelenie,'II');
 await call('PUT',`/api/workspace/pupils/${pupil.public_id}`,{...body,boarding:true,expected:pupil.expected},400);
 await call('PUT',`/api/workspace/pupils/${pupil.public_id}`,{...body,programme:'standard',placement:'regular',expected:pupil.expected},400);
 const {pupil:saved}=await call('PUT',`/api/workspace/pupils/${pupil.public_id}`,{...body,oddelenie:'III',expected:pupil.expected});
 await call('PUT',`/api/workspace/pupils/${pupil.public_id}`,{...body,expected:pupil.expected},409);
 const other=(await call('GET',`/api/workspace?year=${encodeURIComponent(later)}`)).pupils.find((p:any)=>p.public_id===pupil.public_id);
 await call('PUT',`/api/workspace/pupils/${pupil.public_id}`,{...body,year:later,grade:null,oddelenie:'IV',expected:other.expected});
 const history=(await call('GET',`/api/workspace/pupils/${pupil.public_id}/history`)).history;
 assert.equal(history.find((h:any)=>h.year===year).oddelenie,'III');
 assert.equal(history.find((h:any)=>h.year===later).oddelenie,'IV');
 await pool.query("UPDATE student_enrollments SET kind='boarding' WHERE student_id=(SELECT id FROM students WHERE public_id=$1) AND school_year_id=(SELECT id FROM school_years WHERE label=$2)",[saved.public_id,year]);
 const legacy=(await snapshot()).pupils.find((p:any)=>p.public_id===saved.public_id);
 assert.equal(legacy.enrollment_type,'internal');assert.equal(legacy.boarding,true);assert.equal(legacy.programme,'modified');
});

test('one employee holds multiple roles; explicit links preserve profile ids and legacy renames',async()=>{
 const a=(await call('POST','/api/workspace/employees',{year,name:'Измислен Кадар Алфа',identifier:'fixture-a',roles:['teacher','specialist'],teacherKind:'odd'})).employee;
 const b=(await call('POST','/api/workspace/employees',{year,name:'Измислен Кадар Бета',identifier:null,roles:['therapist']})).employee;
 const merged=(await call('POST',`/api/workspace/employees/${a.id}/link`,{year,sourceId:b.id,expected:a.expected,sourceExpected:b.expected})).employee;
 assert.equal(merged.teacher_id,a.teacher_id);assert.equal(merged.therapist_id,b.therapist_id);
 assert.equal(merged.teacher_active,true);assert.equal(merged.therapist_active,true);
 await pool.query("UPDATE therapists SET name='Измислен Кадар Гама' WHERE id=$1",[b.therapist_id]);
 assert.equal((await pool.query('SELECT name FROM teachers WHERE id=$1',[a.teacher_id])).rows[0].name,'Измислен Кадар Гама');
 assert.equal((await pool.query('SELECT name FROM employees WHERE id=$1',[a.id])).rows[0].name,'Измислен Кадар Гама');
 await call('PUT',`/api/workspace/employees/${a.id}`,{year,name:a.name,identifier:a.identifier,roles:[],expected:a.expected},409);
 const now=(await snapshot()).employees.find((e:any)=>e.id===a.id);
 const inactive=(await call('PUT',`/api/workspace/employees/${a.id}`,{year,name:now.name,identifier:now.identifier,roles:['specialist'],expected:now.expected})).employee;
 assert.equal(inactive.teacher_active,false);assert.equal(inactive.therapist_active,false);
 assert.equal(inactive.teacher_id,a.teacher_id);
});

test('caseload uses shared rows and fails closed for invalid foreign keys or stale membership',async()=>{
 const p=(await snapshot()).pupils[0];
 const t=(await call('POST','/api/workspace/employees',{year,name:'Измислен Терапевт Делта',identifier:null,roles:['therapist']})).employee;
 await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[2147483647]},400);
 const changed=(await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[t.therapist_id]})).pupil;
 assert.equal(changed.therapists[0].id,t.therapist_id);
 await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[]},409);
});
