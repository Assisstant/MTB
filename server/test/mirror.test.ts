/** Full mirror regression in three disposable PostgreSQL schemas. */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
    applyMirrorSnapshot,
    createMirrorSnapshot,
    planMirror,
    sha256,
    validateMirrorSnapshot,
    type MirrorSnapshot
} from '../src/lib/mirror.js';

pg.types.setTypeParser(1082, (value) => value);
const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ||
    'postgres://therapy:therapy_local@localhost:5432/therapy_dev';
const BASE = `mirror_test_${process.pid}`;
const SCHEMAS = [`${BASE}_source`, `${BASE}_one`, `${BASE}_two`];
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'database', 'migrations');
const pools: pg.Pool[] = [];

function isolatedUrl(schema: string): string {
    const url = new URL(TEST_URL);
    const inherited = url.searchParams.get('options') || '';
    url.searchParams.set('options', `${inherited} -c search_path=${schema}`.trim());
    return url.href;
}

function observedLater(snapshot: MirrorSnapshot, milliseconds: number): MirrorSnapshot {
    const copy = JSON.parse(JSON.stringify(snapshot)) as MirrorSnapshot;
    copy.source.snapshotAt = new Date(Date.parse(copy.source.snapshotAt) + milliseconds).toISOString();
    copy.payloadHash = sha256({
        format: copy.format,
        formatVersion: copy.formatVersion,
        source: copy.source,
        scope: copy.scope,
        schemaMigrations: copy.schemaMigrations,
        tables: copy.tables
    });
    const stamp = copy.source.snapshotAt.replace(/[-:.TZ]/g, '').slice(0, 14);
    copy.snapshotId = `${copy.source.id}-${stamp}-${copy.payloadHash.slice(0, 16)}`;
    return validateMirrorSnapshot(copy);
}

before(async () => {
    const setup = new pg.Client({ connectionString: TEST_URL });
    await setup.connect();
    for (const schema of SCHEMAS) {
        await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await setup.query(`CREATE SCHEMA "${schema}"`);
    }
    await setup.end();
    for (const schema of SCHEMAS) {
        const pool = new pg.Pool({ connectionString: isolatedUrl(schema), max: 1 });
        pools.push(pool);
        await pool.query(`CREATE TABLE schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )`);
        for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
            await pool.query(readFileSync(resolve(migrationsDir, file), 'utf8'));
            await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
        }
    }
    const source = pools[0];
    const year = (await source.query(`SELECT id FROM school_years WHERE label='2025/2026'`)).rows[0].id;
    const student = (await source.query(
        `INSERT INTO students(public_id, sdnevnik_id, name, grade) VALUES('mirror-pupil-a', 900001, 'Измислен Ученик А', 'IV-а') RETURNING id`
    )).rows[0].id;
    const therapist = (await source.query(
        `INSERT INTO therapists(name) VALUES('Измислен Терапевт А') RETURNING id`
    )).rows[0].id;
    await source.query(`INSERT INTO student_enrollments(student_id, school_year_id, grade, kind) VALUES($1,$2,'IV-а','internal')`, [student, year]);
    await source.query(`INSERT INTO therapist_years(school_year_id, therapist_id) VALUES($1,$2)`, [year, therapist]);
    await source.query(`INSERT INTO therapist_students(school_year_id, therapist_id, student_id) VALUES($1,$2,$3)`, [year, therapist, student]);
    await source.query(`INSERT INTO app_state(app, payload, updated_by) VALUES('sdnevnik', '{"students":[]}'::jsonb, 'mirror test')`);
});

after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    const cleanup = new pg.Client({ connectionString: TEST_URL });
    await cleanup.connect();
    for (const schema of SCHEMAS) await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
});

test('one consistent snapshot reaches two mirrors, updates/deletes safely, and refuses rollback', async () => {
    const [source, one, two] = pools;
    const first = await createMirrorSnapshot(source, 'cloud-test');
    assert.equal(validateMirrorSnapshot(JSON.parse(JSON.stringify(first))).snapshotId, first.snapshotId);
    const corrupted = JSON.parse(JSON.stringify(first)) as MirrorSnapshot;
    corrupted.tables[0].rows.push({ app: 'tampered' });
    assert.throws(() => validateMirrorSnapshot(corrupted), /integrity check/);

    for (const target of [one, two]) {
        const plan = await planMirror(target, first);
        const result = await applyMirrorSnapshot(target, first, {
            expectedSnapshotId: first.snapshotId,
            expectedPlanHash: plan.planHash,
            allowedLargeDeleteCount: plan.totals.deleted
        });
        assert.equal(result.applied, true);
        assert.equal((await target.query(`SELECT count(*)::int AS n FROM students WHERE public_id='mirror-pupil-a'`)).rows[0].n, 1);
    }

    const repeatPlan = await planMirror(one, first);
    assert.deepEqual(repeatPlan.totals, { sourceRows: repeatPlan.totals.sourceRows,
        localRows: repeatPlan.totals.sourceRows, added: 0, changed: 0, deleted: 0 });
    assert.equal((await applyMirrorSnapshot(one, first, {
        expectedSnapshotId: first.snapshotId,
        expectedPlanHash: repeatPlan.planHash
    })).applied, false);

    // With no intervening source write PostgreSQL may legitimately reuse the
    // same txid watermark. A later observation of identical business content
    // must remain a no-op rather than a false safety error.
    const sameVersion = observedLater(first, 1000);
    const sameVersionPlan = await planMirror(one, sameVersion);
    assert.equal(sameVersionPlan.alreadyApplied, true);
    assert.equal((await applyMirrorSnapshot(one, sameVersion, {
        expectedSnapshotId: sameVersion.snapshotId,
        expectedPlanHash: sameVersionPlan.planHash
    })).applied, false);
    const earlierObservationPlan = await planMirror(one, first);
    assert.equal(earlierObservationPlan.olderThanApplied, true);
    await assert.rejects(applyMirrorSnapshot(one, first, {
        expectedSnapshotId: first.snapshotId,
        expectedPlanHash: earlierObservationPlan.planHash
    }), /Older mirror snapshot refused/);

    // These schemas share a test cluster, so target activity may advance the
    // global txid watermark even though source business content did not move.
    // That newer, content-identical observation is a no-op too.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const idle = await createMirrorSnapshot(source, 'cloud-test');
    assert.ok(BigInt(idle.source.version) >= BigInt(first.source.version));
    assert.equal(idle.contentHash, first.contentHash);
    assert.notEqual(idle.snapshotId, first.snapshotId);
    const idlePlan = await planMirror(one, idle);
    assert.equal(idlePlan.alreadyApplied, true);
    assert.deepEqual(idlePlan.totals, { sourceRows: idlePlan.totals.sourceRows,
        localRows: idlePlan.totals.sourceRows, added: 0, changed: 0, deleted: 0 });
    assert.equal((await applyMirrorSnapshot(one, idle, {
        expectedSnapshotId: idle.snapshotId,
        expectedPlanHash: idlePlan.planHash
    })).applied, false);
    assert.equal((await one.query(`SELECT snapshot_id FROM mirror_sync_state WHERE source_id='cloud-test'`)).rows[0].snapshot_id,
        idle.snapshotId, 'an idle pull records the later verified snapshot without rewriting business tables');

    const originalId = (await source.query(`SELECT id FROM students WHERE public_id='mirror-pupil-a'`)).rows[0].id;
    await source.query(`UPDATE students SET grade='V-б', updated_at=now() WHERE id=$1`, [originalId]);
    await source.query(`DELETE FROM therapist_students WHERE student_id=$1`, [originalId]);
    await source.query(`INSERT INTO students(public_id, sdnevnik_id, name, grade) VALUES('mirror-pupil-b',900002,'Измислен Ученик Б','I')`);
    const second = await createMirrorSnapshot(source, 'cloud-test');
    const secondPlan = await planMirror(one, second);
    assert.ok(secondPlan.totals.added >= 1);
    assert.ok(secondPlan.totals.changed >= 1);
    assert.ok(secondPlan.totals.deleted >= 1);
    await applyMirrorSnapshot(one, second, {
        expectedSnapshotId: second.snapshotId,
        expectedPlanHash: secondPlan.planHash,
        allowedLargeDeleteCount: secondPlan.totals.deleted
    });
    assert.equal((await one.query(`SELECT grade FROM students WHERE public_id='mirror-pupil-a'`)).rows[0].grade, 'V-б');
    assert.equal((await one.query(`SELECT count(*)::int AS n FROM therapist_students`)).rows[0].n, 0);

    const oldPlan = await planMirror(one, first);
    assert.equal(oldPlan.olderThanApplied, true);
    await assert.rejects(applyMirrorSnapshot(one, first, {
        expectedSnapshotId: first.snapshotId,
        expectedPlanHash: oldPlan.planHash,
        allowedLargeDeleteCount: oldPlan.totals.deleted
    }), /Older mirror snapshot refused/);

    // A target constraint failure happens after deletion starts, but the whole
    // transaction rolls back to the previously applied snapshot.
    await one.query(`ALTER TABLE students ADD CONSTRAINT mirror_name_guard CHECK (name <> 'Измислен Забранет')`);
    await source.query(`INSERT INTO students(public_id, name) VALUES('mirror-broken','Измислен Забранет')`);
    const broken = await createMirrorSnapshot(source, 'cloud-test');
    const brokenPlan = await planMirror(one, broken);
    await assert.rejects(applyMirrorSnapshot(one, broken, {
        expectedSnapshotId: broken.snapshotId,
        expectedPlanHash: brokenPlan.planHash,
        allowedLargeDeleteCount: brokenPlan.totals.deleted
    }));
    assert.equal((await one.query(`SELECT count(*)::int AS n FROM students WHERE public_id='mirror-pupil-b'`)).rows[0].n, 1,
        'failed apply must leave the preceding complete snapshot in place');
    assert.equal((await one.query(`SELECT snapshot_id FROM mirror_sync_state WHERE source_id='cloud-test'`)).rows[0].snapshot_id,
        second.snapshotId, 'failed apply must not record success');
});
