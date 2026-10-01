import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// A swapped duty day swapped again (054), through the routes and a database
// that has every migration. Its own schema and an invented year: no live row.
const schema = `duty_chain_test_${process.pid}`, label = '1933/1934-chain';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>;
const owner = { 'x-mtb-service-key': 'duty-chain-owner-service-key-1234567890' };
const emp: Record<string, number> = {};
const [A, B, C] = ['Измислена Прва Синџир', 'Измислена Втора Синџир', 'Измислена Трета Синџир'];
// Two turns of a list of three: Mon 4 – Fri 8 September 1933, then Mon 11.
const days = ['1933-09-04', '1933-09-05', '1933-09-06', '1933-09-07', '1933-09-08', '1933-09-11'];
const call = async (method: any, url: string, payload?: any) => {
    const res = await app.inject({ method, url, headers: owner, payload });
    return { status: res.statusCode, body: res.json() };
};
const month = async () => (await call('GET', `/api/duty?year=${encodeURIComponent(label)}&month=1933-09`)).body;
const names = (m: any) => m.days.filter((d: any) => d.date >= days[0]).slice(0, 6).map((d: any) => d.name);
const swap = (first: [string, string], second: [string, string], note = '') => call('PUT', '/api/duty/swap', { year: label, note,
    first: { date: first[0], employeeId: emp[first[1]] }, second: { date: second[0], employeeId: emp[second[1]] } });

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, file), 'utf8'));
    const year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1933-09-01','1934-08-31',false) RETURNING id", [label])).rows[0].id;
    for (const name of [A, B, C]) {
        const t = (await db.query('INSERT INTO therapists(name) VALUES($1) RETURNING id,employee_id', [name])).rows[0];
        await db.query('INSERT INTO therapist_years(therapist_id,school_year_id,active) VALUES($1,$2,true)', [t.id, year]);
        emp[name] = t.employee_id;
    }
    process.env.MTB_REQUIRE_SIGNIN = '1'; process.env.MTB_SERVICE_KEY = owner['x-mtb-service-key'];
    app = Fastify();
    (await import('../src/lib/colleague.js')).installColleagueBoundary(app);
    await app.register((await import('../src/routes/duty.js')).dutyRoutes, { year: label });
    const setup = await call('PUT', '/api/duty/setup', { year: label, startsOn: days[0], members: [A, B, C].map((n) => ({ employeeId: emp[n] })) });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('a day already swapped is swapped again, across cycles, and every step is on record', async () => {
    assert.deepEqual(names(await month()), [A, B, C, A, B, C]);
    // C served B's day of the second cycle; B takes C's day of the first.
    const first = await swap([days[2], C], [days[4], B], 'прва');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(names(await month()), [A, B, B, A, C, C]);
    // Then B trades the day she got (06.09) with A's day of the second cycle.
    const stale = await swap([days[2], C], [days[3], A]);
    assert.equal(stale.status, 409, 'the names are checked against the rota as the first swap left it');
    const second = await swap([days[2], B], [days[3], A], 'втора');
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const m = await month();
    assert.deepEqual(names(m), [A, B, A, B, C, C]);
    const day = m.days.find((d: any) => d.date === days[2]);
    assert.deepEqual(day.swaps.map((s: any) => [s.name, s.date, s.cycle, s.note]), [[C, days[4], 2, 'прва'], [B, days[3], 2, 'втора']]);
    assert.equal(day.swap.id, second.body.id, 'the day shows its last swap, and keeps the first');
    assert.equal(day.turnInCycle, 2, 'the second duty of that person in the cycle');
    assert.deepEqual(m.swapLog.map((s: any) => [s.cross, s.first.name, s.first.date, s.first.cycle, s.second.name, s.second.date, s.second.cycle, s.note]), [
        [true, B, days[2], 1, C, days[4], 2, 'прва'],
        [true, A, days[2], 1, B, days[3], 2, 'втора']
    ]);
    assert.deepEqual(m.cycleCounts.map((c: any) => [c.cycle, c.people.map((p: any) => [p.name, p.count])]),
        [[1, [[A, 2], [C, 0]]], [2, [[C, 2], [A, 0]]]], 'per cycle: who has two, and whose turn moved out');
});

test('a chain is taken back from its last step', async () => {
    const m = await month();
    const [first, second] = m.swapLog.map((s: any) => s.id);
    const early = await call('POST', '/api/duty/swap/remove', { year: label, id: first });
    assert.equal(early.status, 409); assert.match(early.body.error, /подоцнежна замена/);
    assert.equal((await call('POST', '/api/duty/swap/remove', { year: label, id: second })).status, 200);
    assert.deepEqual(names(await month()), [A, B, B, A, C, C]);
    assert.equal((await call('POST', '/api/duty/swap/remove', { year: label, id: first })).status, 200);
    const end = await month();
    assert.deepEqual([names(end), end.swapLog, end.cycleCounts], [[A, B, C, A, B, C], [], []]);
});
