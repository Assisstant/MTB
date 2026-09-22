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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,38);
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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,38);
  assert.equal((await c.query(`SELECT id FROM ${oldBackup}.probe`)).rows[0].id,1);
  await workspaceRelease(c,dir,()=>{},backup);
  // The NEXT reviewed batch must not be handed this batch's recovery name:
  // it would overwrite the snapshot taken before this upgrade. A deploy log
  // meets this as duplicate_schema, so the refusal has to name the schema.
  const last=(await c.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0].filename;
  await c.query('DELETE FROM schema_migrations WHERE filename=$1',[last]);
  await assert.rejects(workspaceRelease(c,dir,()=>{},backup),new RegExp(`recovery schema ${backup} already exists`));
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,37,'the refusal must roll back');
  await c.query('INSERT INTO schema_migrations(filename) VALUES($1)',[last]);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${oldBackup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
