import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { mergeStudents } from '../src/lib/student-merge.js';

test('a duplicate merge waits for a diary save before locking its pupils', async () => {
    const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    assert.ok(base, 'configure a test database connection');
    const schema = `merge_lock_test_${process.pid}`;
    const admin = new pg.Client({ connectionString: base });
    const scoped = new URL(base);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const writer = new pg.Client({ connectionString: scoped.href });
    const merger = new pg.Client({ connectionString: scoped.href });
    let merging: Promise<unknown> | undefined;
    try {
        await admin.connect();
        await admin.query(`CREATE SCHEMA ${schema}`);
        await writer.connect(); await merger.connect();
        const dir = resolve(import.meta.dirname, '../../database/migrations');
        for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await writer.query(readFileSync(resolve(dir, f), 'utf8'));
        await writer.query("INSERT INTO students(public_id,name) VALUES ('merge-keep','Invented Keep'),('merge-fold','Invented Fold')");
        await writer.query("INSERT INTO app_state(app,version,payload) VALUES ('sdnevnik',1,'{}')");
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const mergerPid = (await merger.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

        // Exactly the ordinary diary save's locks, before it projects pupils.
        await writer.query('BEGIN');
        await writer.query("SELECT pg_advisory_xact_lock(hashtext('app_state:sdnevnik'))");
        await writer.query("SELECT version FROM app_state WHERE app='sdnevnik' FOR UPDATE");
        await merger.query('BEGIN');
        merging = mergeStudents(merger, 'merge-keep', 'merge-fold', 'isolated regression').then(() => null, e => e);
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
            waiting = (await admin.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS waiting', [writerPid, mergerPid])).rows[0].waiting;
            if (!waiting) await new Promise(r => setTimeout(r, 10));
        }
        assert.ok(waiting, 'the merge reached a lock held by the diary save');
        await writer.query("SET LOCAL lock_timeout='250ms'");
        // Old order: the merge already holds both pupils, so this times out.
        await writer.query("UPDATE students SET updated_at=now() WHERE public_id='merge-keep'");
        await writer.query('COMMIT');
        assert.equal(await merging, null, 'the waiting merge completes too');
    } finally {
        await writer.query('ROLLBACK').catch(() => {});
        if (merging) await merging;
        await merger.query('ROLLBACK').catch(() => {});
        await writer.end().catch(() => {}); await merger.end().catch(() => {});
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
    }
});
