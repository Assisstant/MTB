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

test('an employee without teaching is neither odd nor pred, and a scheduled teacher cannot be neither',async()=>{
 // A cabinet or service employee has no teaching profile at all. That is the
 // ABSENCE of one, not a third kind of teacher: the timetable is read one way
 // for an одделенска row and the other for a предметна one.
 const service=(await call('POST','/api/workspace/employees',{year,name:'Измислен Кабинет Ипсилон',identifier:null,roles:['therapist','specialist'],teacherKind:'none'})).employee;
 assert.equal(service.teacher_id,null);assert.equal(service.teacher_kind,null);
 assert.equal(service.therapist_active,true,'the cabinet role is unaffected by having no teaching profile');
 // The database CHECK already refuses the row; what the endpoint adds is the
 // sentence a person can act on, so the sentence is what is asserted.
 const refused=await call('POST','/api/workspace/employees',{year,name:'Измислен Наставник Зета',identifier:null,roles:['teacher'],teacherKind:'none'},400);
 assert.match(refused.error,/одделенски или предметен/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM employees WHERE name=$1',['Измислен Наставник Зета'])).rows[0].n,0,
  'a refused save must leave no half-made employee behind');
 const current=(await snapshot()).employees.find((e:any)=>e.id===service.id);
 await call('PUT',`/api/workspace/employees/${service.id}`,{year,name:service.name,identifier:null,roles:['teacher','therapist'],teacherKind:'none',expected:current.expected},400).then((r:any)=>assert.match(r.error,/одделенски или предметен/));
 const teaching=(await call('PUT',`/api/workspace/employees/${service.id}`,{year,name:service.name,identifier:null,roles:['teacher','therapist'],teacherKind:'odd',expected:current.expected})).employee;
 assert.equal(teaching.teacher_kind,'odd');assert.equal(teaching.teacher_active,true);
 // Taking the teaching away keeps the profile it had; the year's membership is
 // what says whether they teach, and an archived year must still read right.
 const now=(await snapshot()).employees.find((e:any)=>e.id===service.id);
 const back=(await call('PUT',`/api/workspace/employees/${service.id}`,{year,name:service.name,identifier:null,roles:['therapist'],teacherKind:'none',expected:now.expected})).employee;
 assert.equal(back.teacher_active,false);assert.equal(back.teacher_kind,'odd');
});

test('caseload uses shared rows and fails closed for invalid foreign keys or stale membership',async()=>{
 const p=(await snapshot()).pupils[0];
 const t=(await call('POST','/api/workspace/employees',{year,name:'Измислен Терапевт Делта',identifier:null,roles:['therapist']})).employee;
 await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[2147483647]},400);
 const changed=(await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[t.therapist_id]})).pupil;
 assert.equal(changed.therapists[0].id,t.therapist_id);
 await call('PUT',`/api/workspace/pupils/${p.public_id}/therapists`,{year,expected:p.expected,therapistIds:[]},409);
});

test('annual professions and duties do not create schedules, profiles or permissions',async()=>{
 const directory=await snapshot();
 for(const code of ['pedagog','spec_edukator','vospituvac','socijalen_rabotnik']) assert.ok(directory.staffProfessions[code]);
 assert.ok(directory.staffDuties.modified_teaching);assert.ok(directory.staffDuties.preparatory_group);
 for(const professionCode of ['pedagog','spec_edukator','vospituvac']){
  const body={year,name:`Измислен Профил ${professionCode}`,identifier:null,roles:['specialist'],professionCode,
   jobTitle:'Пробно работно место',duties:['preparatory_group','modified_teaching','preparatory_group']};
  const e=(await call('POST','/api/workspace/employees',body)).employee;
  assert.equal(e.teacher_id,null);assert.equal(e.therapist_id,null);
  assert.equal(e.teacher_active,false);assert.equal(e.therapist_active,false);
  assert.equal(e.profession_code,professionCode);assert.deepEqual(e.duties,['modified_teaching','preparatory_group']);
  const updated=(await call('PUT',`/api/workspace/employees/${e.id}`,{year,name:e.name,identifier:null,roles:['specialist'],expected:e.expected})).employee;
  assert.equal(updated.job_title,body.jobTitle);assert.equal(updated.profession_code,professionCode);
  assert.deepEqual(updated.duties,e.duties,'older clients must preserve annual facts');
  await call('PUT',`/api/workspace/employees/${e.id}`,{...body,professionCode:'invalid',expected:updated.expected},400);
  await call('PUT',`/api/workspace/employees/${e.id}`,{...body,duties:['invalid'],expected:updated.expected},400);
  const second=(await call('POST','/api/workspace/employees',{...body,name:`Измислен Втор Профил ${professionCode}`})).employee;
  assert.equal(second.profession_code,professionCode,'a shared profession is allowed');
 }
});

test('annual staff facts preserve other years and reject stale or conflicting links',async()=>{
 const body={year,name:'Измислен Годишен Профил',identifier:null,roles:['specialist'],professionCode:'spec_edukator',duties:['preparatory_group'],jobTitle:'Пробна служба'};
 const e=(await call('POST','/api/workspace/employees',body)).employee;
 const other=(await call('GET',`/api/workspace?year=${encodeURIComponent(later)}`)).employees.find((r:any)=>r.id===e.id);
 const changed=(await call('PUT',`/api/workspace/employees/${e.id}`,{...body,year:later,professionCode:'pedagog',duties:['counselling'],expected:other.expected})).employee;
 assert.equal(changed.teacher_id,null);assert.equal(changed.therapist_id,null);
 const history=(await call('GET',`/api/workspace/employees/${e.id}/history`)).history;
 assert.equal(history.find((r:any)=>r.year===year).profession_code,'spec_edukator');
 assert.equal(history.find((r:any)=>r.year===later).profession_code,'pedagog');
 await call('PUT',`/api/workspace/employees/${e.id}`,{...body,year:later,expected:other.expected},409);
 const source=(await call('POST','/api/workspace/employees',{...body,name:'Измислен Друг Годишен Профил',professionCode:'vospituvac'})).employee;
 const targetLater=(await call('GET',`/api/workspace?year=${encodeURIComponent(later)}`)).employees.find((r:any)=>r.id===e.id);
 const sourceLater=(await call('GET',`/api/workspace?year=${encodeURIComponent(later)}`)).employees.find((r:any)=>r.id===source.id);
 await call('POST',`/api/workspace/employees/${e.id}/link`,{year:later,sourceId:source.id,expected:targetLater.expected,sourceExpected:sourceLater.expected},409);
 assert.equal((await pool.query('SELECT superseded_by FROM employees WHERE id=$1',[source.id])).rows[0].superseded_by,null);
 const blank=(await call('POST','/api/workspace/employees',{year:later,name:'Измислен Идентитет Без Историја',identifier:null,roles:['administration']})).employee;
 const target=(await snapshot()).employees.find((r:any)=>r.id===blank.id);
 const merged=(await call('POST',`/api/workspace/employees/${blank.id}/link`,{year,sourceId:source.id,expected:target.expected,sourceExpected:source.expected})).employee;
 assert.equal(merged.profession_code,'vospituvac');assert.deepEqual(merged.duties,['preparatory_group']);
});
