/** A real clinical endpoint racing a merge; only run with test:scratch. */
import pg from 'pg';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mergeStudents } from '../src/lib/student-merge.js';

assert.equal(process.env.MTB_SCRATCH_DB,'1','run with npm run test:scratch -- test/merged-pupil-writes.e2e.ts');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL});
const client=await db.connect();
const api=process.env.API!;
let sending: Promise<Response> | undefined;
try {
    const pupils=(await db.query("INSERT INTO students(public_id,name) VALUES('clinical-race-keep','Invented Clinical Kept'),('clinical-race-fold','Invented Clinical Old') RETURNING id,public_id")).rows;
    const [keep,fold]=pupils;
    const mergerPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await client.query('BEGIN');
    await mergeStudents(client,keep.public_id,fold.public_id,'isolated endpoint regression');
    const body={audiogram:{subjectName:'Invented Clinical Old',date:'1941-10-06',recordType:'test',rightAir:{1000:20}}};
    const send=()=>fetch(api+'/api/diary/record/audiogram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    sending=send();
    let waiting=false;
    for(let n=0;n<200&&!waiting;n++){
        waiting=(await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes',[mergerPid])).rows[0].yes;
        if(!waiting)await new Promise(r=>setTimeout(r,10));
    }
    assert.ok(waiting,'the clinical endpoint reached the pending merge');
    await client.query('COMMIT');
    const refused=await sending;
    assert.equal(refused.status,409);
    assert.equal((await refused.json() as any).mergedPupil,true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audiograms WHERE student_id=ANY($1)',[pupils.map(p=>p.id)])).rows[0].n,0);
    const retried=await send();
    assert.equal(retried.status,200);
    assert.deepEqual((await db.query("SELECT student_id FROM audiograms WHERE subject_name='Invented Clinical Old'")).rows,[{student_id:keep.id}]);
    console.log('PASS clinical save waits, refuses stale identity with HTTP 409, then safely retries on the kept pupil');
} finally {
    await client.query('ROLLBACK');
    if(sending) await sending.catch(()=>{});
    await db.query("DELETE FROM audiograms WHERE subject_name='Invented Clinical Old'");
    await db.query("DELETE FROM students WHERE public_id IN ('clinical-race-keep','clinical-race-fold')");
    client.release(); await db.end();
}
