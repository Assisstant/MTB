/**
 * Regression test for the state/projection transaction boundary.
 *
 * Run deliberately against a test/local server and database:
 *
 *     npm run start
 *     npm run test:state-atomicity
 *
 * The test installs a short-lived trigger which rejects one invented student
 * name. A PUT must fail and app_state must remain untouched. Before this fix,
 * the endpoint returned 200, kept the new blob, rolled back only the relational
 * projection, and allowed sync-peer to record a false agreement.
 */

import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { stableStudentIdForName } from '../src/lib/import-core.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const APP = 'atomic-projection-test';
const RACE_APP = 'atomic-first-save-race-test';
const BLOCKED = 'Тест Атомски';
const TRIGGER = 'test_reject_atomic_projection';
const FUNCTION = 'test_reject_atomic_projection_fn';
const DELAY_TRIGGER = 'test_delay_first_state';
const DELAY_FUNCTION = 'test_delay_first_state_fn';

let failures = 0;
function check(label: string, fn: () => void) {
    try { fn(); console.log(`  ok   ${label}`); }
    catch (err: any) { failures++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

async function call(method: string, path: string, body?: any) {
    const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* Fastify may send plain text */ }
    return { status: res.status, body: json };
}

async function cleanup(publicIds: string[] = []) {
    await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON students`);
    await pool.query(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
    await pool.query(`DROP TRIGGER IF EXISTS ${DELAY_TRIGGER} ON app_state`);
    await pool.query(`DROP FUNCTION IF EXISTS ${DELAY_FUNCTION}()`);
    await pool.query('DELETE FROM app_state WHERE app = ANY($1::text[])', [[APP, RACE_APP]]);
    if (publicIds.length) {
        await pool.query('DELETE FROM students WHERE public_id = ANY($1::text[])', [publicIds]);
    }
}

async function main() {
    const existing = Number((await pool.query('SELECT count(*)::int AS n FROM students')).rows[0].n);
    // Avoid the existing "near-empty roster" safeguard: this test must reach
    // the relational write where the trigger proves rollback of BOTH copies.
    const count = Math.max(1, Math.ceil(existing / 2));
    const students = Array.from({ length: count }, (_, i) => i === 0 ? BLOCKED : `${BLOCKED} ${i + 1}`);
    const publicIds = students.map(stableStudentIdForName);

    await cleanup(publicIds);
    try {
        await pool.query(`
            CREATE FUNCTION ${FUNCTION}() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.name = '${BLOCKED}' THEN
                    RAISE EXCEPTION 'forced projection failure for atomicity regression test';
                END IF;
                RETURN NEW;
            END $$
        `);
        await pool.query(`
            CREATE TRIGGER ${TRIGGER}
            BEFORE INSERT OR UPDATE OF name ON students
            FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}()
        `);
        await pool.query(`
            CREATE FUNCTION ${DELAY_FUNCTION}() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.app = '${RACE_APP}' THEN
                    PERFORM pg_sleep(0.25);
                END IF;
                RETURN NEW;
            END $$
        `);
        await pool.query(`
            CREATE TRIGGER ${DELAY_TRIGGER}
            BEFORE INSERT ON app_state
            FOR EACH ROW EXECUTE FUNCTION ${DELAY_FUNCTION}()
        `);

        console.log(`\nState atomicity — forced projection failure  (${BASE})\n`);
        const put = await call('PUT', `/api/state/${APP}`, {
            baseVersion: 0,
            payload: { students, therapists: [], schedules: {} },
            updated_by: 'state atomicity regression test'
        });

        const state = await pool.query('SELECT version FROM app_state WHERE app = $1', [APP]);
        const leaked = await pool.query('SELECT public_id FROM students WHERE public_id = ANY($1::text[])', [publicIds]);

        check('the API rejects the save when projection fails', () => {
            assert.ok(put.status >= 500, `expected 5xx, got ${put.status}: ${JSON.stringify(put.body)}`);
        });
        check('the blob update is rolled back with the projection', () => {
            assert.equal(state.rowCount, 0, 'app_state advanced even though its relational projection failed');
        });
        check('no partial relational rows escaped the transaction', () => {
            assert.equal(leaked.rowCount, 0);
        });

        console.log('\nState versioning — concurrent first save\n');
        const race = await Promise.all([
            call('PUT', `/api/state/${RACE_APP}`, {
                baseVersion: 0,
                payload: { probe: 'left' },
                updated_by: 'first-save race regression test'
            }),
            call('PUT', `/api/state/${RACE_APP}`, {
                baseVersion: 0,
                payload: { probe: 'right' },
                updated_by: 'first-save race regression test'
            })
        ]);
        const raceRow = await pool.query('SELECT version FROM app_state WHERE app = $1', [RACE_APP]);

        check('exactly one concurrent baseVersion 0 save succeeds', () => {
            assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
        });
        check('the winning first save leaves version 1', () => {
            assert.equal(raceRow.rows[0]?.version, 1);
        });
    } finally {
        await cleanup(publicIds);
        await pool.end();
    }

    if (failures) process.exit(1);
    console.log('\nAll state atomicity checks passed.\n');
}

main().catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* keep the original error */ }
    try { await pool.end(); } catch { /* already closed */ }
    process.exit(1);
});
