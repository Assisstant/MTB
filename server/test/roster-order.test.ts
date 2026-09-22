import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { arrange, arrangementAvailable, readArrangement, ORDER_LISTS } from '../src/lib/roster-order.js';
import 'dotenv/config';

test('an arrangement moves the placed rows and keeps the reader order underneath', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const key = (row: { id: string }) => row.id;
    assert.deepEqual(arrange(rows, key), rows, 'no arrangement must not reorder anything');
    assert.deepEqual(arrange(rows, key, new Map()).map(key), ['a', 'b', 'c', 'd']);
    // Only two of the four are placed. The other two keep the order the query
    // gave them and follow, because absent means "not arranged yet".
    assert.deepEqual(arrange(rows, key, new Map([['c', 0], ['a', 1]])).map(key), ['c', 'a', 'b', 'd']);
    assert.deepEqual(rows.map(key), ['a', 'b', 'c', 'd'], 'the caller’s array must not be sorted in place');
});

test('a database without migration 038 reads every list in the reader order instead of failing', async () => {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
        || 'postgres://therapy:therapy_local@localhost:5432/therapy_dev';
    const schema = `roster_order_absent_${process.pid}`;
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    // `to_regclass` must answer for the schema the query would actually
    // resolve in, not for the name anywhere in the cluster — public.roster_order
    // can exist on a machine whose own installation is older.
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: scoped.href });
    try {
        assert.equal(await arrangementAvailable(pool), false);
        const arrangement = await readArrangement(pool, 1);
        for (const list of ORDER_LISTS) assert.equal(arrangement.get(list)?.size, 0);
    } finally {
        await pool.end();
        await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
        await setup.end();
    }
});
