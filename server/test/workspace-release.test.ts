import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {workspaceRelease} from '../src/lib/workspace-release.js';
import {migrationBody} from '../src/lib/migrations.js';
import 'dotenv/config';
test('release upgrades 032 atomically, retains private recovery, and repeats safely',async()=>{
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL||'postgres://therapy:therapy_local@localhost:5432/therapy_dev';
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`workspace_release_test_${process.pid}`,backup=`mtb_workspace_recovery_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=32).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  await c.query("INSERT INTO teachers(name,kind) VALUES('Измислен Кадар Река','pred')");
  // A conflicting table must roll back the preceding migrations and backup.
  await c.query('CREATE TABLE employees(id integer)');
  await assert.rejects(workspaceRelease(c,dir,()=>{},backup),/rolled back/);
  assert.equal((await c.query("SELECT to_regnamespace($1) AS n",[backup])).rows[0].n,null);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,32);
  await c.query('DROP TABLE employees');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${backup}.teachers`)).rows[0].n,1);
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='employees'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM employees')).rows[0].n,1);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM employee_year_details')).rows[0].n,0,'migration must not classify people');
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='employee_year_details'::regclass")).rows[0].relrowsecurity,true);
  await workspaceRelease(c,dir,()=>{},backup);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('staff release upgrades 036 without overwriting the previous recovery snapshot',async()=>{
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`staff_release_test_${process.pid}`,backup=`mtb_workspace_recovery_staff_test_${process.pid}`,oldBackup=`mtb_workspace_recovery_old_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=36).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  await c.query(`CREATE SCHEMA ${oldBackup}`);await c.query(`CREATE TABLE ${oldBackup}.probe(id integer)`);
  await c.query(`INSERT INTO ${oldBackup}.probe VALUES(1)`);
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query(`SELECT id FROM ${oldBackup}.probe`)).rows[0].id,1);
  await workspaceRelease(c,dir,()=>{},backup);
  // The NEXT reviewed batch must not be handed this batch's recovery name:
  // it would overwrite the snapshot taken before this upgrade. A deploy log
  // meets this as duplicate_schema, so the refusal has to name the schema.
  const last=(await c.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0].filename;
  await c.query('DELETE FROM schema_migrations WHERE filename=$1',[last]);
  // One fewer than all of them: counted, so the next migration does not have to edit this line.
  const pendingOne=(await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
  await assert.rejects(workspaceRelease(c,dir,()=>{},backup),new RegExp(`recovery schema ${backup} already exists`));
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,pendingOne,'the refusal must roll back');
  await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[last]);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${oldBackup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('039 lets a therapist\'s own list be ordered, on a database already at 038', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`caseload_order_test_${process.pid}`,backup=`mtb_workspace_recovery_caseload_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=38).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1990/1991-order','1990-09-01','1991-08-31',false) RETURNING id")).rows[0].id;
  await c.query("INSERT INTO roster_order VALUES($1,'classes','7',0)",[y]);
  await assert.rejects(c.query("INSERT INTO roster_order VALUES($1,'caseload:5','p-1',0)",[y]),/roster_order_list_check/,'038 alone has no per-therapist list');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.deepEqual((await c.query('SELECT list,member_key,position FROM roster_order')).rows,[{list:'classes',member_key:'7',position:0}],'no existing row is touched');
  await c.query("INSERT INTO roster_order VALUES($1,'caseload:5','p-1',0)",[y]);
  for(const bad of ['caseload:','caseload:0','caseload:x','caseloads:5','pupils'])
   await assert.rejects(c.query("INSERT INTO roster_order VALUES($1,$2,'p-2',1)",[y,bad]),/roster_order_list_check/,bad);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('040 adds the form review queue, locked away from the REST roles, on a database at 039', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`form_replies_test_${process.pid}`,backup=`mtb_workspace_recovery_forms_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=39).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1991/1992-forms','1991-09-01','1992-08-31',false) RETURNING id")).rows[0].id;
  assert.equal((await c.query("SELECT to_regclass('form_replies') AS t")).rows[0].t,null,'039 alone has no queue');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM school_years WHERE id=$1',[y])).rows[0].n,1,'no existing row is touched');
  for(const t of ['form_replies','form_reply_decisions'])
   assert.equal((await c.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[t])).rows[0].relrowsecurity,true,t);
  const r=(await c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('cabinet',$1,'therapist:проба','Проба','f1','{}') RETURNING id,status",[y])).rows[0];
  assert.equal(r.status,'pending');
  await assert.rejects(c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('cabinet',$1,'therapist:проба','Проба','f1','{}')",[y]),/form_replies_fingerprint_key/,'the same file twice is one answer');
  await assert.rejects(c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('lesson',$1,'x:yz','X','f2','{}')",[y]),/form_replies_kind_check/);
  await assert.rejects(c.query("INSERT INTO form_reply_decisions(reply_id,item_key,decision,decided_by) VALUES($1,'block:x','maybe','a')",[r.id]),/form_reply_decisions_decision_check/);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('041 lets a teacher\'s own week be a form answer, on a database at 040', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`teacher_forms_test_${process.pid}`,backup=`mtb_workspace_recovery_teacher_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=40).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1992/1993-teach','1992-09-01','1993-08-31',false) RETURNING id")).rows[0].id;
  await c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('class',$1,'class:ii-б','II-б','t0','{}')",[y]);
  await assert.rejects(c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('teacher',$1,'teacher:проба','Проба','t1','{}')",[y]),/form_replies_kind_check/,'040 alone has no teacher answers');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM form_replies')).rows[0].n,1,'no existing row is touched');
  await c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('teacher',$1,'teacher:проба','Проба','t1','{}')",[y]);
  await assert.rejects(c.query("INSERT INTO form_replies(kind,school_year_id,about_key,about_name,fingerprint,reply) VALUES('lesson',$1,'x:yz','X','t2','{}')",[y]),/form_replies_kind_check/);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('042 adds the colleague accounts, sessions and clash notices, locked away from the REST roles, on a database at 041', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`staff_accounts_test_${process.pid}`,backup=`mtb_workspace_recovery_staff_accounts_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=41).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const e=(await c.query("INSERT INTO employees(name) VALUES('Пробен Вработен Сметка') RETURNING id")).rows[0].id;
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1993/1994-acct','1993-09-01','1994-08-31',false) RETURNING id")).rows[0].id;
  assert.equal((await c.query("SELECT to_regclass('staff_accounts') AS t")).rows[0].t,null,'041 alone has no accounts');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM employees WHERE id=$1',[e])).rows[0].n,1,'no existing row is touched');
  for(const t of ['staff_accounts','staff_sessions','schedule_notices'])
   assert.equal((await c.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[t])).rows[0].relrowsecurity,true,t);
  await c.query('INSERT INTO staff_accounts(employee_id) VALUES($1)',[e]);
  await assert.rejects(c.query("UPDATE staff_accounts SET password_hash='x' WHERE employee_id=$1",[e]),/staff_accounts_check/,'a hash without its salt is refused');
  await c.query("INSERT INTO staff_sessions(token_hash,employee_id,expires_at) VALUES('h',$1,now()+interval '1 day')",[e]);
  await c.query("INSERT INTO schedule_notices(school_year_id,author_name,recipient_employee_id,kind,day,slot,about,sentence) VALUES($1,'А',$2,'lesson','понеделник','2','class:ПФ','x')",[y,e]);
  await assert.rejects(c.query("INSERT INTO schedule_notices(school_year_id,author_name,recipient_employee_id,kind,day,slot,about,sentence) VALUES($1,'А',$2,'room','понеделник','2','x','x')",[y,e]),/schedule_notices_kind_check/);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('043 adds the duty rota, locked away from the REST roles, on a database at 042', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`duty_rota_test_${process.pid}`,backup=`mtb_workspace_recovery_duty_rota_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=42).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const e=(await c.query("INSERT INTO employees(name) VALUES('Пробен Дежурен Вработен') RETURNING id")).rows[0].id;
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1994/1995-duty','1994-09-01','1995-08-31',false) RETURNING id")).rows[0].id;
  assert.equal((await c.query("SELECT to_regclass('duty_members') AS t")).rows[0].t,null,'042 alone has no rota');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,43);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM employees WHERE id=$1',[e])).rows[0].n,1,'no existing row is touched');
  for(const t of ['duty_settings','duty_members','duty_days','duty_absences'])
   assert.equal((await c.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[t])).rows[0].relrowsecurity,true,t);
  await c.query('INSERT INTO duty_members(school_year_id,employee_id,position) VALUES($1,$2,1)',[y,e]);
  await assert.rejects(c.query("INSERT INTO duty_days(school_year_id,day,closed,assigned_employee_id) VALUES($1,'1994-09-05',true,$2)",[y,e]),
   /duty_days_check/,'a closed day cannot also be given to somebody');
  await assert.rejects(c.query("UPDATE duty_members SET joined_on='1994-10-01',left_on='1994-09-01' WHERE employee_id=$1",[e]),
   /duty_members_check/,'nobody leaves before they come');
  await c.query("INSERT INTO duty_absences(school_year_id,day,employee_id,marked_by) VALUES($1,'1994-09-05',$2,'x')",[y,e]);
  await c.query('DELETE FROM school_years WHERE id=$1',[y]);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM duty_members')).rows[0].n,0,'a year takes its rota with it');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
