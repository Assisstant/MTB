/** One reviewed additive upgrade, with a private in-database recovery snapshot.
 * Nothing is exported, logged or sent to a new service. A failed check rolls
 * back the backup, migrations and ledger together. Repeated starts are no-ops. */
import type {Client} from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {migrationBody} from './migrations.js';
const ident=(s:string)=>'"'+s.replace(/"/g,'""')+'"';
// The recovery schema names ONE reviewed batch, and the run refuses to reuse
// it — a second batch writing into it would overwrite the snapshot taken
// before the first. So a new batch gets a new name here, and the old snapshots
// stay where they are. 20260921: 033-036. staff_20260922: 037. order_20260922:
// 038 (roster_order). caseload_order_20260924: 039 (a therapist's own order).
// form_replies_20260924: 040 (the review queue for offline form answers), and
// 039 with it wherever 039 had not been deployed yet. teacher_forms_20260924:
// 041 (a teacher's own week as a third kind of answer).
export async function workspaceRelease(client:Client,directory:string,log=console.log,recoverySchema='mtb_workspace_recovery_teacher_forms_20260924'){
 if(!/^mtb_workspace_recovery_[a-z0-9_]+$/.test(recoverySchema))throw Error('Invalid recovery schema');
 await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 try{
  await client.query("SET LOCAL lock_timeout='15s'");await client.query("SET LOCAL statement_timeout='120s'");
  await client.query('SELECT pg_advisory_xact_lock(716284,1)');
  const schema=(await client.query('SELECT current_schema() AS name')).rows[0].name;
  const files=(await readdir(directory)).filter(f=>/^\d+_[\w-]+\.sql$/.test(f)).sort();
  const applied=new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map(r=>r.filename));
  if(files.some(f=>Number(f.slice(0,3))<=32&&!applied.has(f))||[...applied].some(f=>!files.includes(f)))throw Error('Unexpected migration baseline');
  const pending=files.filter(f=>!applied.has(f));
  if(pending.some(f=>!/^0(33|34|35|36|37|38|39|40|41)_/.test(f)))throw Error('Unreviewed migration in release');
  if(!pending.length){await client.query('COMMIT');log('Workspace schema already current');return;}
  const tables=(await client.query(`SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`,[schema])).rows;
  // The recovery schema must be absent. Never overwrite an earlier backup.
  await client.query(`CREATE SCHEMA ${ident(recoverySchema)}`);
  await client.query(`REVOKE ALL ON SCHEMA ${ident(recoverySchema)} FROM PUBLIC`);
  for(const role of ['anon','authenticated'])if((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await client.query(`REVOKE ALL ON SCHEMA ${ident(recoverySchema)} FROM ${ident(role)}`);
  await client.query('LOCK TABLE '+tables.map(t=>`${ident(schema)}.${ident(t.name)}`).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
  const checks=[];
  for(const {name} of tables){
   await client.query(`CREATE TABLE ${ident(recoverySchema)}.${ident(name)} AS TABLE ${ident(schema)}.${ident(name)}`);
   await client.query(`REVOKE ALL ON ${ident(recoverySchema)}.${ident(name)} FROM PUBLIC`);
   const cols=(await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',[schema,name])).rows.map(r=>r.column_name);
   // Project only pre-upgrade columns, so additive fields cannot mask a change.
   const projection=cols.map(ident).join(',');
   const hash=async (s:string)=>(await client.query(`SELECT count(*)::int AS n,md5(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text)) AS hash FROM (SELECT ${projection} FROM ${ident(s)}.${ident(name)}) t`)).rows[0];
   checks.push({name,hash,before:await hash(recoverySchema)});
  }
  // Recovery stores sequence values too; copying rows alone is not a full
  // restore recipe. Constraints and functions remain versioned in Git.
  await client.query(`CREATE TABLE ${ident(recoverySchema)}.sequence_values AS SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1`,[schema]);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(recoverySchema)} FROM PUBLIC`);
  for(const role of ['anon','authenticated'])if((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(recoverySchema)} FROM ${ident(role)}`);
  for(const file of pending){
   await client.query(migrationBody(await readFile(join(directory,file),'utf8')));
   // Finish deferred backfill checks before the next migration alters a table.
   await client.query('SET CONSTRAINTS ALL IMMEDIATE');
   await client.query('INSERT INTO schema_migrations(filename) VALUES($1)',[file]);
  }
  for(const check of checks){if(check.name==='schema_migrations')continue;if(JSON.stringify(await check.hash(schema))!==JSON.stringify(check.before))throw Error('Existing table content changed: '+check.name);}
  await client.query('COMMIT');log(`Workspace upgrade verified: ${pending.length} migrations; ${checks.length-1} original tables unchanged; private recovery snapshot retained`);
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  const code=(error as {code?:string}).code||'verification';
  // duplicate_schema is the one refusal a deploy log will actually meet, and
  // "42P06" says nothing about what to do. It means this batch was given a
  // recovery name an earlier batch already used.
  if(code==='42P06')throw Error(`Workspace upgrade refused: recovery schema ${recoverySchema} already exists, so this batch would overwrite the snapshot an earlier one took. Give the new batch its own recovery schema name; transaction rolled back`,{cause:error});
  throw Error(`Workspace upgrade refused (${code}); transaction rolled back`,{cause:error});
 }
}
