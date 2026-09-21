/** Run integration suites against an isolated schema, never the live tables. */
import 'dotenv/config';
import pg from 'pg';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const cwd=resolve(import.meta.dirname,'..');
const database=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
if(!database)throw Error('An explicit local test connection is required');
const schema=`release_qa_${process.pid}`;
const original=new pg.Client({connectionString:database});await original.connect();
async function fingerprint(){
 const tables=(await original.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 const out={};for(const {tablename} of tables){if(!/^[a-z_]+$/.test(tablename))throw Error('Unexpected table');out[tablename]=(await original.query(`SELECT count(*)::int AS n,md5(string_agg(t::text,'|' ORDER BY t::text)) AS hash FROM public."${tablename}" t`)).rows[0];}
 return out;
}
const before=await fingerprint();let service;
await original.query(`CREATE SCHEMA "${schema}"`);
const scoped=new URL(database);scoped.searchParams.set('options',`-c search_path=${schema}`);
const env={...process.env,DATABASE_URL:scoped.href,PORT:'3138',HOST:'127.0.0.1',API:'http://127.0.0.1:3138',MTB_CLOUD_AUTH:'off',MTB_REQUIRE_SIGNIN:'',MTB_MIRROR_MODE:'off',MTB_API_WRITES:'1',MTB_DIARY_WRITES:'1'};
async function run(file){
 await new Promise((done,reject)=>{const child=spawn(process.execPath,['--import','tsx',file],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>{if(code===0){console.log('PASS '+file);done();}else{console.error(output);reject(Error(`${file} exited ${code}`));}});});
}
try{
 const p=new pg.Client({connectionString:scoped.href});await p.connect();
 try{await p.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');const dir=resolve(cwd,'../database/migrations');for(const f of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort()){await p.query(await readFile(resolve(dir,f),'utf8'));await p.query('INSERT INTO schema_migrations(filename) VALUES($1)',[f]);}}finally{await p.end();}
 service=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd,env,windowsHide:true,stdio:'ignore'});
 let ready=false;for(let n=0;n<50;n++){try{ready=(await fetch(env.API+'/healthz')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 if(!ready)throw Error('Isolated server did not start');
 for(const file of ['MTB-Workspace.html','workspace-admin.js','workspace-admin.css'])assert.equal((await fetch(env.API+'/'+file)).status,200);
 for(const file of ['server/.env','.git/config','database/migrations/035_staff_identity.sql'])assert.equal((await fetch(env.API+'/'+file)).status,404);
 for(const file of ['test/fusion-schedule.e2e.ts','test/fusion.browser.mjs','test/app-navigation.browser.mjs','test/workspace.browser.mjs','test/podatoci.browser.mjs','test/sdnevnik-compat.browser.mjs','test/colleague.e2e.ts'])await run(file);
}finally{
 if(service){service.kill();await new Promise(r=>service.once('exit',r));}
 await original.query(`DROP SCHEMA "${schema}" CASCADE`);
 assert.deepEqual(await fingerprint(),before,'Live public tables must remain byte-content identical');
 await original.end();console.log('PASS live-table fingerprints unchanged; disposable schema removed');
}
