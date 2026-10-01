import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// Renaming a subject (owner, 1 Oct 2026): the name is text in three places and
// all three move together. Its own schema and invented years: no live row.
const schema = `subject_rename_test_${process.pid}`, label = '1935/1936-subject', other = '1934/1935-subject';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>;
const LONG = 'Македонски / Албански / Турски / Српски / Босански јазик', SHORT = 'Македонски јазик';
const call = async (method: any, url: string, payload?: any) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json() };
};
const names = async () => (await call('GET', `/api/teaching/subject-names?year=${encodeURIComponent(label)}`)).body.subjects;
const rename = (from: string, to: string, year = label) => call('POST', '/api/teaching/subject-rename', { year, from, to });
const lessonsOf = async (year: string) => (await db.query(
    `SELECT l.subject FROM lessons l JOIN school_years y ON y.id = l.school_year_id WHERE y.label = $1 ORDER BY l.ordinal`, [year])).rows.map((r) => r.subject);

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    delete process.env.MTB_REQUIRE_SIGNIN;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, file), 'utf8'));
    const year = async (l: string, from: string, to: string) =>
        (await db.query('INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,$2,$3,false) RETURNING id', [l, from, to])).rows[0].id;
    const now = await year(label, '1935-09-01', '1936-08-31'), before = await year(other, '1934-09-01', '1935-08-31');
    const cls = (await db.query("INSERT INTO school_classes(label) VALUES('ПРЕД-1') RETURNING id")).rows[0].id;
    const teacher = async (name: string, subject: string) => {
        const id = (await db.query("INSERT INTO teachers(name,kind,subject) VALUES($1,'pred',$2) RETURNING id", [name, subject])).rows[0].id;
        await db.query('INSERT INTO teacher_years(school_year_id,teacher_id,active) VALUES($1,$2,true)', [now, id]);
        return id;
    };
    const a = await teacher('Измислена Предметна Прва', `${LONG}, Математика`);
    await teacher('Измислена Предметна Втора', `${SHORT}, ${LONG}`);
    const lesson = (y: number, ordinal: number, subject: string) => db.query(
        "INSERT INTO lessons(school_year_id,day,day_order,ordinal,class_id,teacher_id,subject) VALUES($1,'понеделник',1,$2,$3,$4,$5)", [y, ordinal, cls, a, subject]);
    await lesson(now, 1, LONG); await lesson(now, 2, LONG); await lesson(now, 3, 'Математика'); await lesson(before, 1, LONG);
    app = Fastify();
    await app.register((await import('../src/routes/teaching-edit.js')).teachingEditRoutes);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('the page sees every name in use: in lessons, on teachers\' lists, in the offer', async () => {
    const long = (await names()).find((s: any) => s.subject === LONG);
    assert.deepEqual(long, { subject: LONG, lessons: 2, teachers: 2, offered: true }, 'the ministry\'s wording, as migration 032 brought it');
    assert.deepEqual((await names()).find((s: any) => s.subject === 'Математика').lessons, 1);
});

test('one rename moves the lessons of the year, the teachers\' lists and the offer together', async () => {
    const offeredBefore = (await db.query('SELECT count(*)::int AS n FROM teaching_subjects WHERE subject = $1', [LONG])).rows[0].n;
    assert.ok(offeredBefore > 0);
    const done = await rename(LONG, `  ${SHORT} `);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.to, done.body.lessons, done.body.teachers, done.body.offered], [SHORT, 2, 2, offeredBefore]);
    assert.deepEqual(await lessonsOf(label), [SHORT, SHORT, 'Математика']);
    assert.deepEqual(await lessonsOf(other), [LONG], 'an archived year reads as it was written');
    assert.deepEqual((await db.query('SELECT subject FROM teachers ORDER BY name')).rows.map((r) => r.subject),
        [SHORT, `${SHORT}, Математика`], 'renamed in place; a teacher who had both keeps the name once');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM teaching_subjects WHERE subject = $1', [LONG])).rows[0].n, 0);
    // The offer already had the short name for other plans; the renamed rows join them, one per plan and grade.
    const short = (await db.query('SELECT plan, grade, count(*)::int AS n FROM teaching_subjects WHERE subject = $1 GROUP BY plan, grade', [SHORT])).rows;
    assert.ok(short.length >= offeredBefore && short.every((r) => r.n === 1));
    const all = await names();
    assert.ok(!all.some((s: any) => s.subject === LONG));
    assert.deepEqual(all.find((s: any) => s.subject === SHORT), { subject: SHORT, lessons: 2, teachers: 2, offered: true });
});

test('renaming onto a name the offer already has merges, and nothing is half-done', async () => {
    const maths = (await db.query("SELECT count(*)::int AS n FROM teaching_subjects WHERE subject = 'Математика'")).rows[0].n;
    assert.ok(maths > 0, 'the offer has Математика for several grades');
    const done = await rename(SHORT, 'Математика');
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(await lessonsOf(label), ['Математика', 'Математика', 'Математика']);
    const rows = (await db.query("SELECT plan, grade, count(*)::int AS n FROM teaching_subjects WHERE subject = 'Математика' GROUP BY plan, grade")).rows;
    assert.ok(rows.every((r) => r.n === 1), 'one row per plan and grade');
    assert.deepEqual((await db.query('SELECT subject FROM teachers ORDER BY name')).rows.map((r) => r.subject), ['Математика', 'Математика']);
});

test('what is refused: an unknown name, the same name, an empty one, a comma, an unknown year', async () => {
    assert.equal((await rename('Нема таков предмет', 'Нешто')).status, 404);
    assert.equal((await rename('Математика', 'Математика')).status, 400);
    assert.equal((await rename('Математика', '   ')).status, 400);
    assert.equal((await rename('Математика', 'Математика, прв дел')).status, 400);
    assert.equal((await rename('Математика', 'Алгебра', '1800/1801')).status, 404);
    assert.deepEqual(await lessonsOf(label), ['Математика', 'Математика', 'Математика'], 'none of them wrote anything');
});
