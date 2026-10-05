import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { mergeStudents } from '../src/lib/student-merge.js';

const schema = `merged_writers_test_${process.pid}`;
const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
assert.ok(base, 'configure a test database connection');
const admin = new pg.Client({ connectionString: base });
const scoped = new URL(base); scoped.searchParams.set('options', `-c search_path=${schema}`);
const db = new pg.Pool({ connectionString: scoped.href });
let serial = 0;
before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
});
after(async () => {
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
async function pair() {
    const prefix = `merge-writer-${++serial}`;
    const { rows } = await db.query("INSERT INTO students(public_id,name) VALUES($1,'Invented Keep'),($2,'Invented Fold') RETURNING id,public_id", [prefix+'-keep',prefix+'-fold']);
    return { keep: rows[0], fold: rows[1] };
}
async function waitForBlock(waiter: number, blocker: number) {
    for (let n=0; n<200; n++) {
        if ((await admin.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS yes', [blocker,waiter])).rows[0].yes) return;
        await new Promise(r=>setTimeout(r,10));
    }
    assert.fail('the concurrent operation did not reach the expected database lock');
}
const pid = async (c: pg.PoolClient) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const mark = (c: pg.PoolClient, id: number) => c.query("INSERT INTO attendance(student_id,date,slot_key,status) VALUES($1,'1941-10-06','monday-0','present')",[id]);

test('a write that read the old id before a merge cannot attach history to the retired row', async () => {
    const {keep,fold}=await pair(), writer=await db.connect(), merger=await db.connect();
    const writerPid=await pid(writer), mergerPid=await pid(merger);
    let writing: Promise<any> | undefined;
    let error: any;
    try {
        await writer.query('BEGIN');
        const staleId=(await writer.query('SELECT id FROM students WHERE public_id=$1',[fold.public_id])).rows[0].id;
        await merger.query('BEGIN');
        await mergeStudents(merger,keep.public_id,fold.public_id,'isolated regression');
        writing=mark(writer,staleId).then(()=>null,e=>e);
        await waitForBlock(writerPid,mergerPid);
    } finally {
        await merger.query('COMMIT').catch(()=>{});
        error=writing ? await writing : null;
        await writer.query('ROLLBACK');
        writer.release(); merger.release();
    }
    assert.equal(error?.constraint,'students_merged_reference','stale write must be refused after the merge commits');
});

test('a write already accepted before merging is moved, with no lost history', async () => {
    const {keep,fold}=await pair(), writer=await db.connect(), merger=await db.connect();
    const writerPid=await pid(writer), mergerPid=await pid(merger);
    let merging: Promise<any> | undefined;
    try {
        await writer.query('BEGIN'); await mark(writer,fold.id);
        await merger.query('BEGIN');
        merging=mergeStudents(merger,keep.public_id,fold.public_id,'isolated regression').then(()=>null,e=>e);
        await waitForBlock(mergerPid,writerPid);
        await writer.query('COMMIT');
        assert.equal(await merging,null);
        await merger.query('COMMIT');
        assert.deepEqual((await db.query('SELECT student_id FROM attendance WHERE student_id=ANY($1)',[[keep.id,fold.id]])).rows,[{student_id:keep.id}]);
    } finally {
        await writer.query('ROLLBACK'); if(merging) await merging;
        await merger.query('ROLLBACK'); writer.release(); merger.release();
    }
});

test('every pupil foreign key has the write guard, including updates with an unchanged id', async () => {
    const missing = await db.query(`SELECT c.conrelid::regclass::text AS table_name
        FROM pg_constraint c
        WHERE c.contype='f' AND c.confrelid='students'::regclass
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid=c.conrelid AND t.tgfoid='guard_merged_pupil_reference()'::regprocedure
                AND t.tgenabled='O' AND t.tgtype=23)`);
    assert.deepEqual(missing.rows, [], 'new referencing tables need the same boundary');
});

test('a stale identity cannot revive or retarget a merged pupil, or merge it a second time', async () => {
    const {keep,fold}=await pair(), client=await db.connect();
    try {
        await client.query('BEGIN');
        await mergeStudents(client,keep.public_id,fold.public_id,'isolated regression');
        await client.query('COMMIT');
        for (const assignment of ['active=true', 'sdnevnik_id=991991', "left_reason=NULL", "public_id='different-alias'"]) {
            await assert.rejects(db.query(`UPDATE students SET ${assignment} WHERE id=$1`,[fold.id]),
                (e:any)=>e.constraint==='students_merged_reference');
        }
        await client.query('BEGIN');
        await assert.rejects(mergeStudents(client,keep.public_id,fold.public_id,'isolated regression'), /веќе е споен/);
    } finally { await client.query('ROLLBACK'); client.release(); }
});

test('ordinary archived pupils still accept their history, and unlinked audiograms remain valid', async () => {
    const {fold}=await pair(), client=await db.connect();
    try {
        await client.query("UPDATE students SET active=false,left_reason='ordinary archive' WHERE id=$1",[fold.id]);
        await mark(client,fold.id);
        await client.query("INSERT INTO audiograms(sdnevnik_id,subject_name,student_id) VALUES('merge-test-audio','Invented Unlinked',NULL)");
        assert.equal((await client.query('SELECT count(*)::int AS n FROM attendance WHERE student_id=$1',[fold.id])).rows[0].n,1);
    } finally { client.release(); }
});
