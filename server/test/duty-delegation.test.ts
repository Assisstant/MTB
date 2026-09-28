import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
    acceptDutyAdminLink, createDutyAdminLink,
    dutyAdminLinks, revokeDutyAdminLinks
} from '../src/lib/duty-delegation.js';

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
async function withStore(run: (db: pg.Client, schema: string) => Promise<void>) {
    const db = new pg.Client({ connectionString });
    const schema = `duty_links_test_${process.pid}_${randomBytes(4).toString('hex')}`;
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    try {
        await db.query(`SET search_path=${schema}`);
        await db.query(await readFile(new URL('../../database/migrations/048_duty_admin_links.sql', import.meta.url), 'utf8'));
        await run(db, schema);
    } finally {
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        await db.end();
    }
}

test('a permanent duty link is hashed, survives a new connection and stays revocable', async () => {
    await withStore(async (db, schema) => {
        const made = await createDutyAdminLink(db);
        assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(made.expiresAt, null);
        const entries = await dutyAdminLinks(db);
        assert.equal(JSON.stringify(entries).includes(made.token), false);
        const stored = (await db.query('SELECT * FROM duty_admin_links')).rows;
        assert.equal(JSON.stringify(stored).includes(made.token), false);
        assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);
        assert.equal(await acceptDutyAdminLink(db, 'not-a-token'), null);
        assert.equal(await acceptDutyAdminLink(db, 'x'.repeat(43)), null);
        // No shared in-memory state: another server connection sees the same
        // capability and immediately sees revocation by the first connection.
        const reopened = new pg.Client({ connectionString, options: `-c search_path=${schema}` });
        await reopened.connect();
        try {
            assert.deepEqual(await acceptDutyAdminLink(reopened, made.token), entries[0]);
            assert.equal(await revokeDutyAdminLinks(db), 1);
            assert.equal(await acceptDutyAdminLink(reopened, made.token), null);
        } finally { await reopened.end(); }
    });
});

test('optional temporary links still expire, without expiring the permanent ones', async () => {
    await withStore(async (db) => {
        const temporary = await createDutyAdminLink(db, 2);
        const permanent = await createDutyAdminLink(db);
        assert.equal(new Date(temporary.expiresAt!).getTime() - new Date(temporary.createdAt).getTime(), 7200000);
        assert.ok(await acceptDutyAdminLink(db, temporary.token));
        await db.query("UPDATE duty_admin_links SET expires_at=now() - interval '1 second' WHERE id=$1", [temporary.id]);
        assert.equal(await acceptDutyAdminLink(db, temporary.token), null);
        assert.deepEqual((await dutyAdminLinks(db)).map((link) => link.id), [permanent.id]);
        assert.ok(await acceptDutyAdminLink(db, permanent.token));
    });
});
