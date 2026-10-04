import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// A child who still has a term with a therapist is not taken off that
// therapist's list (4 Oct 2026) — from Кабинети and Податоци too, as the pupil
// form, Администрација and Колега already refused. Own schema, invented people.
const schema = `caseload_booked_test_${process.pid}`, YEAR = '1941/1942-case';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw Error('Configure a test database connection.');
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>, year: number, therapist: number, pupil: number;
const T = 'Измислен Терапевт Листа', P = 'case-booked-pupil';
const unlink = () => app.inject({ method: 'DELETE', url: `/api/therapists/${encodeURIComponent(T)}/students/${P}?year=${encodeURIComponent(YEAR)}` });
const linked = async () => (await db.query('SELECT count(*)::int AS n FROM therapist_students WHERE therapist_id = $1 AND student_id = $2', [therapist, pupil])).rows[0].n;

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    delete process.env.MTB_REQUIRE_SIGNIN;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
    year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1941-09-01','1942-08-31',false) RETURNING id", [YEAR])).rows[0].id;
    therapist = (await db.query('INSERT INTO therapists(name) VALUES($1) RETURNING id', [T])).rows[0].id;
    await db.query('INSERT INTO therapist_years(school_year_id,therapist_id,active) VALUES($1,$2,true)', [year, therapist]);
    pupil = (await db.query("INSERT INTO students(public_id,name,grade) VALUES($1,'Измислено Дете Листа',NULL) RETURNING id", [P])).rows[0].id;
    await db.query("INSERT INTO student_enrollments(student_id,school_year_id,grade,kind) VALUES($1,$2,NULL,'external')", [pupil, year]);
    await db.query('INSERT INTO therapist_students(school_year_id,therapist_id,student_id) VALUES($1,$2,$3)', [year, therapist, pupil]);
    await db.query("INSERT INTO schedule_slots(school_year_id,day,day_order,time_slot,therapist_id,student_id,source) VALUES($1,'среда',3,'08:00-08:40',$2,$3,'api')", [year, therapist, pupil]);
    app = Fastify();
    await app.register((await import('../src/routes/roster-write.js')).rosterWriteRoutes);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('a child with a term here stays on the list, and the refusal says which term', async () => {
    const res = await unlink();
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json().booked, ['среда 08:00-08:40']);
    assert.match(res.json().error, /Прво ослободете го терминот/);
    assert.equal(await linked(), 1, 'nothing was taken away');
});

test('once the term is freed, the child can leave the list', async () => {
    await db.query('DELETE FROM schedule_slots WHERE therapist_id = $1 AND student_id = $2', [therapist, pupil]);
    const res = await unlink();
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await linked(), 0);
});
