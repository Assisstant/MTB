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
  assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,36);
  assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${backup}.teachers`)).rows[0].n,1);
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='employees'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM employees')).rows[0].n,1);
  await workspaceRelease(c,dir,()=>{},backup);
 }finally{await c.query(`DROP SCHEMA IF EXISTS ${backup} CASCADE`);await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
