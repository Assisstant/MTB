import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {workspaceRelease} from '../src/lib/workspace-release.js';
import {migrationBody} from '../src/lib/migrations.js';
import {MIRROR_EXCLUDED_TABLES} from '../src/lib/mirror.js';
import 'dotenv/config';
// Every migration in the folder: a release applies whatever is pending, so the
// count after one is the whole folder, and a new batch must not edit it here.
const ALL=(await readdir(resolve(import.meta.dirname,'../../database/migrations'))).filter(f=>f.endsWith('.sql')).length;
test('056 guards merged pupils when upgrading 055 without rewriting existing history', async () => {
 const c=new pg.Client({connectionString:process.env.TEST_DATABASE_URL||process.env.DATABASE_URL});await c.connect();
 const schema=`merged_release_test_${process.pid}`,backup=`mtb_workspace_recovery_merged_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=55).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const id=(await c.query("INSERT INTO students(public_id,name,active,left_reason) VALUES('release-alias','Invented Alias',false,'merged:release-kept') RETURNING id")).rows[0].id;
  await c.query("INSERT INTO attendance(student_id,date,slot_key,status) VALUES($1,'1941-10-06','monday-0','present')",[id]);
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM attendance WHERE student_id=$1',[id])).rows[0].n,1,'upgrade preserves even pre-existing stale history for explicit review');
  await assert.rejects(c.query("INSERT INTO attendance(student_id,date,slot_key,status) VALUES($1,'1941-10-07','tuesday-0','present')",[id]),(e:any)=>e.constraint==='students_merged_reference');
  await workspaceRelease(c,dir,()=>{},backup);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('048 persists duty capabilities privately, upgrading 047 without changing existing data', async () => {
 const c=new pg.Client({connectionString:process.env.TEST_DATABASE_URL||process.env.DATABASE_URL});await c.connect();
 const schema=`duty_links_release_test_${process.pid}`,backup=`mtb_workspace_recovery_duty_links_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=47).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='duty_admin_links'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM duty_admin_links')).rows[0].n,0,'deploy creates no admin credential');
  for(const role of ['anon','authenticated']){
   if((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount){
    assert.equal((await c.query("SELECT has_table_privilege($1, 'duty_admin_links', 'SELECT,INSERT,UPDATE,DELETE') AS allowed",[role])).rows[0].allowed,false);
   }
  }
  assert.ok(MIRROR_EXCLUDED_TABLES.includes('duty_admin_links'),'credentials never enter a mirror');
  await workspaceRelease(c,dir,()=>{},backup); // repeated deploy is a no-op
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
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

test('044 adds duty swaps, locked away from the REST roles, on a database at 043', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`duty_swaps_test_${process.pid}`,backup=`mtb_workspace_recovery_duty_swaps_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=43).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const [a,b]=(await c.query("INSERT INTO employees(name) VALUES('Пробна Замена Прва'),('Пробна Замена Втора') RETURNING id")).rows.map(r=>r.id);
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1995/1996-swap','1995-09-01','1996-08-31',false) RETURNING id")).rows[0].id;
  await c.query("INSERT INTO duty_members(school_year_id,employee_id,position) VALUES($1,$2,1)",[y,a]);
  assert.equal((await c.query("SELECT to_regclass('duty_swaps') AS t")).rows[0].t,null,'043 alone has no swaps');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM duty_members')).rows[0].n,1,'no existing row is touched');
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='duty_swaps'::regclass")).rows[0].relrowsecurity,true);
  await c.query("INSERT INTO duty_swaps(school_year_id,first_day,first_employee_id,second_day,second_employee_id) VALUES($1,'1995-09-04',$2,'1995-09-06',$3)",[y,a,b]);
  // 054, in the same run: a day may be in more than one swap, applied in the order made.
  await c.query("INSERT INTO duty_swaps(school_year_id,first_day,first_employee_id,second_day,second_employee_id) VALUES($1,'1995-09-04',$2,'1995-09-08',$3)",[y,b,a]);
  assert.ok(!/UNIQUE/i.test((await c.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='duty_swaps_first_day'")).rows[0].indexdef),'the index stays, no longer unique');
  await assert.rejects(c.query("INSERT INTO duty_swaps(school_year_id,first_day,first_employee_id,second_day,second_employee_id) VALUES($1,'1995-09-12',$2,'1995-09-11',$3)",[y,a,b]),
   /duty_swaps_check/,'the first day comes first');
  await assert.rejects(c.query("INSERT INTO duty_swaps(school_year_id,first_day,first_employee_id,second_day,second_employee_id) VALUES($1,'1995-09-11',$2,'1995-09-12',$2)",[y,a]),
   /duty_swaps_check/,'nobody swaps with themselves');
  await c.query('DELETE FROM school_years WHERE id=$1',[y]);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM duty_swaps')).rows[0].n,0,'a year takes its swaps with it');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('045 adds a per-year alias and the year\'s class count, touching no existing row, on a database at 044', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`class_alias_test_${process.pid}`,backup=`mtb_workspace_recovery_class_alias_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=44).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1996/1997-alias','1996-09-01','1997-08-31',false) RETURNING id")).rows[0].id;
  const k=(await c.query("INSERT INTO school_classes(label,sort_key) VALUES('Пробна-а','zz') RETURNING id")).rows[0].id;
  await c.query("INSERT INTO class_years(school_year_id,class_id,active,description) VALUES($1,$2,true,'пробен опис')",[y,k]);
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  const row=(await c.query('SELECT alias,description FROM class_years WHERE school_year_id=$1 AND class_id=$2',[y,k])).rows[0];
  assert.deepEqual(row,{alias:null,description:'пробен опис'},'an existing year keeps its description and has no alias until one is written');
  await c.query("UPDATE class_years SET alias='Пробна-а – пробни ученици' WHERE school_year_id=$1",[y]);
  await c.query('UPDATE school_years SET class_count=17 WHERE id=$1',[y]);
  await assert.rejects(c.query('UPDATE school_years SET class_count=-1 WHERE id=$1',[y]),/school_years_class_count_check/,'a count is never negative');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('046 adds the watermark\'s look, one row at most, locked away from the REST roles, on a database at 045', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`credit_look_test_${process.pid}`,backup=`mtb_workspace_recovery_credit_look_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=45).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  assert.equal((await c.query("SELECT to_regclass('credit_look') AS t")).rows[0].t,null,'045 alone has no look');
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='credit_look'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM credit_look')).rows[0].n,0,'no look is written until the administrator saves one');
  await c.query(`INSERT INTO credit_look(look) VALUES('{"size":11}')`);
  await assert.rejects(c.query(`INSERT INTO credit_look(look) VALUES('{"size":12}')`),/credit_look_pkey/,'one look for everybody');
  await assert.rejects(c.query(`INSERT INTO credit_look(id,look) VALUES(false,'{}')`),/credit_look_id_check/,'and never a second one beside it');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('047 adds the administrator\'s bookmarks, one versioned document, locked away from the REST roles, on a database at 046', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`bookmarks_test_${process.pid}`,backup=`mtb_workspace_recovery_bookmarks_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=46).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='bookmark_state'::regclass")).rows[0].relrowsecurity,true);
  await c.query(`INSERT INTO bookmark_state(doc,revision) VALUES('{}',1)`);
  await assert.rejects(c.query(`INSERT INTO bookmark_state(doc,revision) VALUES('{}',1)`),/bookmark_state_pkey/,'one document');
  await assert.rejects(c.query(`UPDATE bookmark_state SET revision=0`),/bookmark_state_revision_check/,'a stored revision starts at 1');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('051 records who actually served a duty day, touching no existing day, on a database at 050', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`duty_served_test_${process.pid}`,backup=`mtb_workspace_recovery_duty_served_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=50).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const [a,b]=(await c.query("INSERT INTO employees(name) VALUES('Пробна Дежурна Прва'),('Пробна Дежурна Втора') RETURNING id")).rows.map(r=>r.id);
  const y=(await c.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES('1996/1997-served','1996-09-01','1997-08-31',false) RETURNING id")).rows[0].id;
  await c.query("INSERT INTO duty_days(school_year_id,day,closed,note) VALUES($1,'1996-09-02',false,'белешка')",[y]);
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.equal((await c.query('SELECT served_employee_id FROM duty_days WHERE school_year_id=$1',[y])).rows[0].served_employee_id,null,'an existing day keeps its rota person');
  await c.query("INSERT INTO duty_days(school_year_id,day,closed,served_employee_id) VALUES($1,'1996-09-03',false,$2)",[y,a]);
  await assert.rejects(c.query("INSERT INTO duty_days(school_year_id,day,closed,served_employee_id) VALUES($1,'1996-09-04',true,$2)",[y,b]),
   /duty_days_served_open/,'nobody serves on a closed day');
  await c.query('DELETE FROM school_years WHERE id=$1',[y]);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});

test('052 puts the door under the owner\'s control without changing one account, on a database at 051', async () => {
 const url=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
 const c=new pg.Client({connectionString:url});await c.connect();
 const schema=`portal_security_release_test_${process.pid}`,backup=`mtb_workspace_recovery_portal_security_test_${process.pid}`;
 const dir=resolve(import.meta.dirname,'../../database/migrations');
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path=${schema}`);
 try{
  await c.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=51).sort()){
   await c.query(migrationBody(await readFile(resolve(dir,f),'utf8')));await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);
  }
  const [a,b]=(await c.query("INSERT INTO employees(name) VALUES('Пробна Врата Прва'),('Пробна Врата Втора') RETURNING id")).rows.map(r=>r.id);
  await c.query('INSERT INTO staff_accounts(employee_id,read_only) VALUES($1,true)',[a]);
  await workspaceRelease(c,dir,()=>{},backup);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,ALL);
  assert.deepEqual((await c.query('SELECT read_only,locked,tester,owner FROM staff_accounts WHERE employee_id=$1',[a])).rows[0],
   {read_only:true,locked:false,tester:false,owner:false},'an existing account is neither locked nor exempt');
  for(const table of ['portal_security','portal_links','portal_security_log']){
   assert.equal((await c.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table);
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,'deploy closes nothing and makes no link');
   assert.ok(MIRROR_EXCLUDED_TABLES.includes(table as any),'authorization never enters a mirror');
   for(const role of ['anon','authenticated']) if((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)
    assert.equal((await c.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed",[role,table])).rows[0].allowed,false);
  }
  await c.query('UPDATE staff_accounts SET owner=true WHERE employee_id=$1',[a]);
  await assert.rejects(c.query('UPDATE staff_accounts SET locked=true WHERE employee_id=$1',[a]),/staff_accounts_owner_unlocked/,'the owner is never locked');
  await assert.rejects(c.query('INSERT INTO staff_accounts(employee_id,owner) VALUES($1,true)',[b]),/staff_accounts_one_owner/,'one owner');
  await c.query("INSERT INTO portal_links(code) VALUES('abcd-2345')");
  await assert.rejects(c.query("INSERT INTO portal_links(code) VALUES('efgh-6789')"),/portal_links_one_current/,'one current link');
  // 053, in the same run: an archived link may be allowed again, the current one has no such mark.
  await assert.rejects(c.query("UPDATE portal_links SET allowed=true WHERE code='abcd-2345'"),/portal_links_allowed_archived/);
  await c.query("UPDATE portal_links SET retired_at=now(),allowed=true WHERE code='abcd-2345'");
  await assert.rejects(c.query("INSERT INTO portal_security(id) VALUES(false)"),/portal_security_id_check/,'one row');
  // 055, in the same run: a sign-in may name the link it came in through; none has to.
  const link=(await c.query("SELECT id FROM portal_links WHERE code='abcd-2345'")).rows[0].id;
  await c.query("INSERT INTO staff_sessions(token_hash,employee_id,expires_at) VALUES('plain',$1,now()+interval '1 day')",[b]);
  await c.query("INSERT INTO staff_sessions(token_hash,employee_id,expires_at,link_id) VALUES('through',$1,now()+interval '1 day',$2)",[b,link]);
  assert.equal((await c.query("SELECT link_id FROM staff_sessions WHERE token_hash='plain'")).rows[0].link_id,null);
  await assert.rejects(c.query("UPDATE staff_sessions SET link_id=-1 WHERE token_hash='plain'"),/staff_sessions_link_id_fkey/,'only a real link');
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
