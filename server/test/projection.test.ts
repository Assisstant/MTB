/**
 * Tests for projecting app state into the tables, against a real PostgreSQL.
 *
 * These exist because of an actual incident: a save from an app that had not
 * pulled yet replaced a full week's schedule with nothing. Row counts alone
 * would not have caught it, so the safeguards are asserted directly.
 *
 * Uses a throwaway database (therapy_test) created and dropped per run, so it
 * never touches therapy_dev.
 *
 * Run: npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { projectPayload } from '../src/lib/import-core.js';

pg.types.setTypeParser(1082, (v) => v);   // DATE as 'YYYY-MM-DD', as in src/db.ts

const ADMIN_URL = process.env.TEST_ADMIN_URL || 'postgres://therapy:therapy_local@localhost:5432/postgres';
const TEST_DB = 'therapy_test';
const TEST_URL = ADMIN_URL.replace(/\/postgres$/, '/' + TEST_DB);

let pool: pg.Pool;

const migrationsDir = resolve(import.meta.dirname, '..', '..', 'database', 'migrations');

before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: TEST_URL });
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
        await pool.query(readFileSync(resolve(migrationsDir, file), 'utf8'));
    }
});

after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.end();
});

/** Runs a projection in its own transaction, like the API does. */
async function project(payload: any) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await projectPayload(client, payload);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM students) AS students,
            (SELECT count(*)::int FROM schedule_slots) AS slots,
            (SELECT count(*)::int FROM therapist_students) AS links`
)).rows[0];

/** A small but complete Rasporedi payload. */
function fullPayload(studentCount = 12) {
    const students = Array.from({ length: studentCount }, (_, i) => `I-а - Ученик ${i + 1}`);
    const studentMeta: Record<string, any> = {};
    students.forEach((n, i) => { studentMeta[n] = { studentId: `RS-test-${i + 1}`, grade: 'I-а' }; });
    return {
        students: ['Избери Ученик', ...students],
        therapists: ['Терапевт А', 'Терапевт Б'],
        therapistStudents: { 'Терапевт А': students.slice(0, 6), 'Терапевт Б': students.slice(6) },
        studentMeta,
        schedule: [
            { day: 'понеделник', time: '08:00-08:20', assignments: { 'Терапевт А': students[0], 'Терапевт Б': students[6] } },
            { day: 'вторник', time: '09:00-09:20', assignments: { 'Терапевт А': students[1] } }
        ]
    };
}

test('a full payload lands in the tables', async () => {
    const result = await project(fullPayload());
    assert.equal(result.kind, 'rasporedi');
    assert.deepEqual(result.report.problems, []);

    const c = await counts();
    assert.equal(c.students, 12);
    assert.equal(c.slots, 3);
    assert.equal(c.links, 12);

    // The roster is enrolled in the current school year.
    const enrolled = await pool.query(
        `SELECT count(*)::int AS n FROM student_enrollments e
         JOIN school_years y ON y.id = e.school_year_id WHERE y.is_current`
    );
    assert.equal(enrolled.rows[0].n, 12);
});

test('re-projecting the same payload changes nothing', async () => {
    const before = await counts();
    await project(fullPayload());
    assert.deepEqual(await counts(), before);
});

test('an empty schedule does not erase the week', async () => {
    // The real incident: an app that had not pulled yet saved its blank state.
    const payload = fullPayload();
    payload.schedule = [];

    const result = await project(payload);
    const c = await counts();
    assert.equal(c.slots, 3, 'existing slots survive');
    assert.ok(
        result.report.problems.some((p) => p.includes('empty schedule')),
        'and the caller is told why nothing changed'
    );
});

test('a drastically smaller roster skips projection entirely', async () => {
    const before = await counts();
    const result = await project(fullPayload(2));   // 2 students vs 12 stored

    assert.equal(result.kind, 'rasporedi (skipped)');
    assert.deepEqual(await counts(), before, 'nothing is touched');
    assert.ok(result.report.problems.some((p) => p.includes('safeguard')));
});

test('a genuinely grown roster is accepted', async () => {
    const result = await project(fullPayload(14));
    assert.equal(result.kind, 'rasporedi');
    assert.equal((await counts()).students, 14);
});

test('an unrecognized payload is refused rather than half-applied', async () => {
    const before = await counts();
    const result = await project({ something: 'else' });
    assert.equal(result.kind, 'unknown');
    assert.deepEqual(await counts(), before);
});

test('diary data attaches to students already on the roster', async () => {
    // Link one student to a diary id first.
    const payload: any = fullPayload(14);
    payload.sdnevnik = {
        students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', rasporediStudentId: 'RS-test-1' }]
    };
    await project(payload);

    const diary = {
        students: [{ id: 5001, name: 'Ученик 1', grade: 'I-а', planId: 7 }],
        plans: [{ id: 7, name: 'Тест план', activities: ['Прва', 'Втора', 'Трета'] }],
        studentProgress: { '5001': { '7': [{ index: 0, date: '2026-03-02', time: '08:00' }] } },
        attendance: { '2026-03-02': { '5001': { 'monday-0': 'present', 'monday-1': '' } } },
        audiograms: []
    };
    const result = await project(diary);
    assert.equal(result.kind, 'sdnevnik');

    const rows = (await pool.query(
        `SELECT (SELECT count(*)::int FROM plans) AS plans,
                (SELECT count(*)::int FROM plan_activities) AS activities,
                (SELECT count(*)::int FROM student_plan_progress) AS progress,
                (SELECT count(*)::int FROM attendance) AS attendance`
    )).rows[0];
    assert.equal(rows.plans, 1);
    assert.equal(rows.activities, 3);
    assert.equal(rows.progress, 1);
    assert.equal(rows.attendance, 1, 'the blank mark is skipped, the real one is kept');

    // The date must survive unchanged — an earlier bug shifted every date by a day.
    const when = await pool.query('SELECT date FROM attendance LIMIT 1');
    assert.equal(String(when.rows[0].date), '2026-03-02');
});
