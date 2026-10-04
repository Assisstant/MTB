import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// Lessons with no subject (4 Oct 2026): a предметен teacher with ONE subject of
// their own fills theirs; everything else is left for a person. The write is
// exactly the lessons that were shown, or nothing. Its own schema and invented
// years and people: no live row.
const schema = `subject_fill_test_${process.pid}`, label = '1931/1932-fill', other = '1930/1931-fill';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw Error('Configure a test database connection.');
const admin = new pg.Client({ connectionString });
type Lib = typeof import('../src/lib/teaching-edit.js');
let db: pg.Pool, app: ReturnType<typeof Fastify>, lib: Lib;
let year: number, cls: number;
const id: Record<string, number> = {};
const subjectOf = async (lesson: number) => (await db.query('SELECT subject FROM lessons WHERE id = $1', [lesson])).rows[0].subject;
const call = async (method: any, url: string, payload?: any) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json() };
};
const shown = async () => lib.subjectFillLessons(await lib.subjectFillPlan(db, year));
const post = (lessons: Array<{ id: number; subject: string }>, y = label) => call('POST', '/api/teaching/subject-fill', { year: y, lessons });
const lesson = async (yearId: number, ordinal: number, teacher: number | null, subject: string | null) =>
    (await db.query(`INSERT INTO lessons(school_year_id,day,day_order,ordinal,class_id,teacher_id,subject)
        VALUES($1,'понеделник',1,$2,$3,$4,$5) RETURNING id`, [yearId, ordinal, cls, teacher, subject])).rows[0].id;

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    delete process.env.MTB_REQUIRE_SIGNIN;
    db = (await import('../src/db.js')).pool;
    lib = await import('../src/lib/teaching-edit.js');
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
    await db.query('UPDATE school_years SET is_current = false');
    year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1931-09-01','1932-08-31',true) RETURNING id", [label])).rows[0].id;
    const last = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1930-09-01','1931-08-31',false) RETURNING id", [other])).rows[0].id;
    cls = (await db.query("INSERT INTO school_classes(label) VALUES('ИЗМ-1') RETURNING id")).rows[0].id;
    for (const [key, name, kind, subject] of [
        ['one', 'Измислен Предметен Еден', 'pred', ' Ликовно '],
        ['two', 'Измислен Предметен Два', 'pred', 'Музичко, Ликовно'],
        ['none', 'Измислен Предметен Без', 'pred', null],
        ['odd', 'Измислен Одделенски', 'odd', 'Математика']
    ] as const) {
        id[key] = (await db.query('INSERT INTO teachers(name,kind,subject) VALUES($1,$2,$3) RETURNING id', [name, kind, subject])).rows[0].id;
    }
    id.empty1 = await lesson(year, 1, id.one, null);
    id.empty2 = await lesson(year, 2, id.one, '  ');
    id.chosen = await lesson(year, 3, id.one, 'Цртање');
    id.lessonTwo = await lesson(year, 4, id.two, null);
    id.lessonNone = await lesson(year, 5, id.none, null);
    id.lessonOdd = await lesson(year, 6, id.odd, null);
    id.nobody = await lesson(year, 7, null, null);
    id.archived = await lesson(last, 1, id.one, null);
    app = Fastify();
    await app.register((await import('../src/routes/teaching-edit.js')).teachingEditRoutes);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('the preview reports every lesson with no subject, and which lessons it would fill', async () => {
    const r = await lib.subjectFillPlan(db, year);
    assert.equal(r.empty, 6, 'a blank of spaces is empty too; another year is not counted');
    assert.deepEqual(r.filled.map((x) => [x.teacherId, x.subject, x.lessons, x.lessonIds]), [[id.one, 'Ликовно', 2, [id.empty1, id.empty2]]]);
    assert.deepEqual(r.homeroom.map((x) => [x.teacherId, x.lessons]), [[id.odd, 1]]);
    assert.deepEqual(r.unlisted.map((x) => [x.teacherId, x.lessons]), [[id.none, 1]]);
    assert.deepEqual(r.several.map((x) => x.subjects), [['Музичко', 'Ликовно']]);
    assert.equal(r.noTeacher, 1);
    const page = await call('GET', `/api/teaching/subject-fill?year=${encodeURIComponent(label)}`);
    assert.equal(page.status, 200);
    assert.deepEqual([page.body.current, page.body.empty, page.body.filled[0].lessonIds], [true, 6, [id.empty1, id.empty2]]);
    assert.equal(await subjectOf(id.empty1), null);
});

test('refused, and nothing written: an archived year, an empty list, anything that changed since it was shown', async () => {
    const was = await shown();
    assert.equal((await post([{ id: id.archived, subject: 'Ликовно' }], other)).status, 400, 'a teacher\'s list says what they teach now');
    assert.equal((await post([])).status, 400);

    await db.query("UPDATE lessons SET subject = 'Рачно' WHERE id = $1", [id.empty2]);
    const person = await post(was);
    assert.equal(person.status, 409, 'a person gave one of them a subject meanwhile');
    assert.equal(person.body.changed, 1);
    assert.equal(await subjectOf(id.empty1), null, 'and the other one was not written either');
    await db.query('UPDATE lessons SET subject = NULL WHERE id = $1', [id.empty2]);

    await db.query("UPDATE teachers SET subject = 'Музичко' WHERE id = $1", [id.one]);
    const list = await post(was);
    assert.equal(list.status, 409, 'the teacher\'s subject changed meanwhile');
    assert.equal(list.body.filled[0].subject, 'Музичко', 'the refusal carries the new preview');
    await db.query("UPDATE teachers SET subject = ' Ликовно ' WHERE id = $1", [id.one]);

    assert.equal((await post([{ id: id.lessonTwo, subject: 'Ликовно' }])).status, 409, 'a lesson the preview never offered');
    for (const key of ['empty1', 'empty2', 'lessonTwo']) assert.equal(await subjectOf(id[key]), null, key);
});

test('while a fill is being written, neither the teacher\'s list nor its lessons can change', async () => {
    const a = await db.connect(), b = await db.connect();
    try {
        await a.query('BEGIN');
        const done = await lib.applySubjectFill(a, year, await shown());
        assert.equal(done.ok && done.written, 2);
        const blocked = async (sql: string, args: unknown[]) => {
            await b.query('BEGIN'); await b.query("SET LOCAL lock_timeout = '300ms'");
            try { await b.query(sql, args); return 'written'; } catch (err: any) { return err.code; } finally { await b.query('ROLLBACK'); }
        };
        assert.equal(await blocked("UPDATE teachers SET subject = 'Музичко' WHERE id = $1", [id.one]), '55P03', 'the teacher waits');
        assert.equal(await blocked("UPDATE lessons SET subject = 'Рачно' WHERE id = $1", [id.empty1]), '55P03', 'and so does the lesson');
        await a.query('ROLLBACK');
    } finally { a.release(); b.release(); }
    assert.equal(await subjectOf(id.empty1), null, 'rolled back');
});

test('exactly the lessons that were shown: one that became fillable meanwhile waits for the next preview', async () => {
    const was = await shown();
    id.late = await lesson(year, 8, id.one, null);
    const done = await post(was);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.written, 2);
    assert.equal(await subjectOf(id.empty1), 'Ликовно');
    assert.equal(await subjectOf(id.empty2), 'Ликовно');
    assert.equal(await subjectOf(id.late), null, 'nobody was shown it');
    assert.equal(await subjectOf(id.chosen), 'Цртање', 'a subject a person chose is never replaced');
    for (const key of ['lessonTwo', 'lessonNone', 'lessonOdd', 'nobody']) assert.equal(await subjectOf(id[key]), null, key);
    assert.equal(await subjectOf(id.archived), null, 'another year reads as it was');
    assert.deepEqual((await lib.subjectFillPlan(db, year)).filled.map((x) => x.lessonIds), [[id.late]]);
});

test('sending the same thing again changes nothing; the next preview fills the rest, then there is none', async () => {
    const again = await post([{ id: id.empty1, subject: 'Ликовно' }, { id: id.empty2, subject: 'Ликовно' }]);
    assert.equal(again.status, 409);
    assert.equal(await subjectOf(id.late), null);
    const rest = await post(await shown());
    assert.deepEqual([rest.status, rest.body.written], [200, 1]);
    const end = await lib.subjectFillPlan(db, year);
    assert.deepEqual([end.empty, end.filled.length], [4, 0]);
});
