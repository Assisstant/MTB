/**
 * Присуство по паралелка, по ден (057), against a disposable schema with
 * invented people. What it holds the feature to:
 *   - the homeroom teacher marks any working day; a subject teacher only on a
 *     weekday they have a lesson in that class; nobody else, ever;
 *   - a mark is written only if it is still what the caller saw, and a day's
 *     batch („✓ Сите присутни") is all or nothing;
 *   - closed days, the future and pupils of another class are refused;
 *   - the kitchen's count is numbers per class and in total, for readers and
 *     the owner only, and unmarked is never counted as absent;
 *   - the transport report does not read it (owner, 5 Oct 2026).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

const schema = `class_attendance_test_${process.pid}`, label = '1921/1922-class-att';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw Error('Configure a test database connection.');
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>, year: number, classA: number, classB: number;
let homeroom: string, subject: string, stranger: string, reader: string;
const pupils: Record<string, number> = {};
const owner = { 'x-mtb-service-key': 'class-attendance-test-owner-key-1234567890' };
// 1921-09-05 is a Monday; the subject teacher teaches class A on Tuesdays only.
const MON = '1921-09-05', TUE = '1921-09-06', SAT = '1921-09-10';

const call = async (method: any, url: string, token = '', payload?: any, headers: any = {}) => {
    const r = await app.inject({ method, url, headers: { ...(token ? { 'x-mtb-portal-token': token } : {}), ...headers }, payload });
    return { status: r.statusCode, body: r.body ? r.json() : null };
};
const read = (token: string, classId: number, from: string, to = from) =>
    call('GET', `/api/portal/class-attendance?classId=${classId}&from=${from}&to=${to}`, token);
const put = (token: string, classId: number, date: string, marks: any[]) =>
    call('PUT', '/api/portal/class-attendance', token, { classId, date, marks });

before(async () => {
    pg.types.setTypeParser(1082, v => v);
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
    year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1921-09-01','1922-08-31',false) RETURNING id", [label])).rows[0].id;
    const cls = async (name: string) => {
        const id = (await db.query('INSERT INTO school_classes(label,sort_key) VALUES($1,$1) RETURNING id', [name])).rows[0].id;
        await db.query('INSERT INTO class_years(school_year_id,class_id,active) VALUES($1,$2,true)', [year, id]);
        return id;
    };
    classA = await cls('ИЗМ-А'); classB = await cls('ИЗМ-Б');
    const teacher = async (name: string, kind: string) => {
        const t = (await db.query('INSERT INTO teachers(name,kind) VALUES($1,$2) RETURNING id, employee_id', [name, kind])).rows[0];
        await db.query('INSERT INTO teacher_years(school_year_id,teacher_id,active) VALUES($1,$2,true)', [year, t.id]);
        return t;
    };
    const h = await teacher('Измислена Раководителка Алфа', 'odd');
    const s = await teacher('Измислен Предметен Бета', 'pred');
    const x = await teacher('Измислен Туѓ Гама', 'pred');
    const r = await teacher('Измислен Читач Делта', 'pred');
    await db.query("INSERT INTO teacher_classes(school_year_id,teacher_id,class_id,role) VALUES($1,$2,$3,'homeroom')", [year, h.id, classA]);
    await db.query("INSERT INTO lessons(school_year_id,day,day_order,ordinal,class_id,teacher_id,subject) VALUES($1,'вторник',2,1,$2,$3,'Изм. предмет')", [year, classA, s.id]);
    await db.query("INSERT INTO lessons(school_year_id,day,day_order,ordinal,class_id,teacher_id,subject) VALUES($1,'понеделник',1,1,$2,$3,'Изм. предмет')", [year, classB, x.id]);
    await db.query('INSERT INTO staff_accounts(employee_id,read_only) VALUES($1,true)', [r.employee_id]);
    for (const [pid, name, grade, type] of [['ca-1', 'Измислен Ученик Еден', 'ИЗМ-А', 'internal'], ['ca-2', 'Измислен Ученик Два', 'ИЗМ-А', 'external'],
        ['ca-3', 'Измислен Ученик Три', 'ИЗМ-А', 'internal'], ['ca-4', 'Измислен Ученик Четири', 'ИЗМ-Б', 'internal']]) {
        pupils[pid] = (await db.query('INSERT INTO students(public_id,name,grade) VALUES($1,$2,$3) RETURNING id', [pid, name, grade])).rows[0].id;
        await db.query('INSERT INTO student_enrollments(student_id,school_year_id,grade,enrollment_type) VALUES($1,$2,$3,$4)', [pupils[pid], year, grade, type]);
    }
    process.env.MTB_REQUIRE_SIGNIN = '1'; process.env.MTB_SERVICE_KEY = owner['x-mtb-service-key'];
    app = Fastify();
    (await import('../src/lib/colleague.js')).installColleagueBoundary(app);
    await app.register((await import('../src/routes/portal.js')).portalRoutes, { year: label });
    const login = async (username: string) => (await call('POST', '/api/portal/login', '', { username, password: 'ResursenCentar' })).body.token;
    homeroom = await login('Измислена Раководителка Алфа'); subject = await login('Измислен Предметен Бета');
    stranger = await login('Измислен Туѓ Гама'); reader = await login('Измислен Читач Делта');
    assert.ok(homeroom && subject && stranger && reader);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('the tables are private and carry the merged-pupil guard', async () => {
    for (const table of ['class_attendance', 'class_attendance_changes']) {
        assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [table])).rows[0].relrowsecurity, true, table);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname LIKE 'guard_merged_pupil_%'", [table])).rows[0].n, 1, table);
    }
});

test('who sees which class: homeroom, a lesson, nobody else', async () => {
    assert.equal((await call('GET', '/api/portal/class-attendance/classes')).status, 401);
    const mine = (await call('GET', '/api/portal/class-attendance/classes', homeroom)).body.classes;
    assert.deepEqual(mine.map((c: any) => [c.label, c.homeroom]), [['ИЗМ-А', true]]);
    const theirs = (await call('GET', '/api/portal/class-attendance/classes', subject)).body.classes;
    assert.deepEqual(theirs.map((c: any) => [c.label, c.homeroom, c.weekdays]), [['ИЗМ-А', false, ['вторник']]]);
    assert.equal((await read(stranger, classA, MON)).status, 403, 'a teacher of another class cannot read this one');
    const all = (await call('GET', '/api/portal/class-attendance/classes', reader)).body;
    assert.equal(all.readOnly, true); assert.equal(all.classes.length, 2);
    const seen = (await read(reader, classA, MON)).body;
    assert.equal(seen.days[0].mayMark, false, 'a reader never marks');
    assert.equal((await put(reader, classA, MON, [{ studentId: pupils['ca-1'], status: 'present', expected: null }])).status, 403);
});

test('a subject teacher marks only on their lesson day; the homeroom on any working day', async () => {
    const monday = (await read(subject, classA, MON)).body;
    assert.equal(monday.days[0].mayMark, false);
    { const r = await put(subject, classA, MON, [{ studentId: pupils['ca-1'], status: 'present', expected: null }]); assert.equal(r.status, 403, JSON.stringify(r.body)); }
    assert.equal((await read(subject, classA, TUE)).body.days[0].mayMark, true);
    assert.equal((await put(subject, classA, TUE, [{ studentId: pupils['ca-1'], status: 'present', expected: null }])).status, 200);
    assert.equal((await put(homeroom, classA, MON, [{ studentId: pupils['ca-1'], status: 'absent', expected: null }])).status, 200);
    assert.equal((await put(homeroom, classA, SAT, [{ studentId: pupils['ca-1'], status: 'present', expected: null }])).status, 400, 'weekend');
    assert.equal((await put(homeroom, classA, '2999-09-06', [{ studentId: pupils['ca-1'], status: 'present', expected: null }])).status, 400, 'future');
    assert.equal((await put(homeroom, classA, MON, [{ studentId: pupils['ca-4'], status: 'present', expected: null }])).status, 403, 'pupil of another class');
    const row = (await db.query('SELECT marked_by FROM class_attendance WHERE day=$1 AND student_id=$2', [TUE, pupils['ca-1']])).rows[0];
    assert.equal(row.marked_by, 'Измислен Предметен Бета', 'the author is recorded');
});

test('a mark is written only over what the caller saw, and a day is all or nothing', async () => {
    // „✓ Сите присутни" from a stale tab: ca-1 was marked absent meanwhile.
    const stale = await put(homeroom, classA, MON, [
        { studentId: pupils['ca-2'], status: 'present', expected: null },
        { studentId: pupils['ca-1'], status: 'present', expected: null }]);
    assert.equal(stale.status, 409);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM class_attendance WHERE day=$1 AND student_id=$2', [MON, pupils['ca-2']])).rows[0].n, 0, 'rolled back');
    const day = (await read(homeroom, classA, MON)).body.days[0];
    assert.equal(day.marks[pupils['ca-1']], 'absent');
    const fresh = await put(homeroom, classA, MON, [
        { studentId: pupils['ca-2'], status: 'present', expected: null },
        { studentId: pupils['ca-1'], status: 'present', expected: 'absent' }]);
    assert.equal(fresh.status, 200); assert.equal(fresh.body.written, 2);
    assert.equal((await put(homeroom, classA, MON, [{ studentId: pupils['ca-1'], status: null, expected: 'absent' }])).status, 409);
    assert.equal((await put(homeroom, classA, MON, [{ studentId: pupils['ca-1'], status: null, expected: 'present' }])).status, 200, 'cleared');
    assert.equal((await put(homeroom, classA, MON, [{ studentId: pupils['ca-1'], status: 'absent', expected: null }])).status, 200);
    const log = (await db.query('SELECT count(*)::int AS n FROM class_attendance_changes WHERE day=$1', [MON])).rows[0].n;
    assert.equal(log, 5, 'every change is in the log, the refused ones are not');
});

test('the kitchen count: per class and in total, unmarked is not absent, readers and owner only', async () => {
    const path = `/api/portal/read-only/class-summary?date=${MON}`;
    assert.equal((await call('GET', path, homeroom)).status, 403);
    const sum = (await call('GET', path, reader)).body;
    const a = sum.classes.find((c: any) => c.label === 'ИЗМ-А');
    assert.deepEqual([a.pupils, a.present, a.absent, a.unmarked], [3, 1, 1, 1]);
    assert.deepEqual(sum.totals, { pupils: 4, present: 1, absent: 1, unmarked: 2 });
    assert.equal(JSON.stringify(sum).includes('Измислен Ученик'), false, 'numbers only, no pupil names');
    assert.equal((await call('GET', `/api/attendance/class-summary?date=${MON}`, '')).status >= 400, true);
    const asOwner = await call('GET', `/api/attendance/class-summary?date=${MON}`, '', undefined, owner);
    assert.equal(asOwner.status, 200); assert.deepEqual(asOwner.body.totals, sum.totals);
});

test('the transport report does not read class attendance', async () => {
    const { transportAttendance } = await import('../src/lib/transport-attendance.js');
    const y = (await db.query('SELECT id,label,starts_on,ends_on FROM school_years WHERE id=$1', [year])).rows[0];
    const report = await transportAttendance(db, y, '1921-09');
    const external = report.pupils.find((p: any) => p.publicId === 'ca-2');
    assert.ok(external); assert.equal(external.daysPresent, 0, 'present in class is not a transport day');
});
