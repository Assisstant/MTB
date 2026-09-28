// Broader acceptance on an isolated schema and loopback server, never the live installation.
import pg from 'pg';
import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const schema = `attendance_regressions_${process.pid}`;
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw Error('Configure DATABASE_URL; only an isolated schema will be used.');
const db = new pg.Client({connectionString}); await db.connect();
const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
const env = {...process.env,DATABASE_URL:url.href,TEST_DATABASE_URL:url.href,API:'http://127.0.0.1:3998',PORT:'3998',HOST:'127.0.0.1',
    MTB_CLOUD_AUTH:'off',MTB_REQUIRE_SIGNIN:'0',MTB_MIRROR_MODE:'off',SYNC_NAME:'attendance-test'};
let server;
try {
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path=${schema}`);
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s,schema);
    const dir=resolve(import.meta.dirname,'../../database/migrations');
    await db.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()){
        await db.query(await readFile(resolve(dir,file),'utf8'));
        await db.query('INSERT INTO schema_migrations(filename) VALUES($1)',[file]);
    }
    server=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:resolve(import.meta.dirname,'..'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
    let healthy=false;
    for(let n=0;n<60;n++){
        if(server.exitCode!==null)throw Error('Scratch server exited: '+log);
        try{healthy=(await fetch(env.API+'/healthz')).ok;}catch{}
        if(healthy)break;await new Promise(r=>setTimeout(r,250));
    }
    assert.ok(healthy,'scratch server must start');
    for(const path of ['/kolegi','/Kolega.html'])assert.equal((await fetch(env.API+path)).status,200);
    for(const path of ['/server/.env','/.git/config','/database/migrations/049_cabinet_attendance.sql'])assert.equal((await fetch(env.API+path)).status,404);
    console.log('PASS: live HTTP shell and private-path smoke checks');
    for(const file of ['roster-purge.e2e.ts','colleague.e2e.ts','fusion-schedule.e2e.ts','fusion.browser.mjs','app-navigation.browser.mjs']){
        const child=spawn(process.execPath,['--import','tsx','test/'+file],{cwd:resolve(import.meta.dirname,'..'),env,windowsHide:true,stdio:'inherit'});
        const [code]=await once(child,'exit');assert.equal(code,0,file);
    }
}finally{
    if(server && server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end();
}
