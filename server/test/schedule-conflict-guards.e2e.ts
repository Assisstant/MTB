/** Run only through test:scratch. Real overlapping/racing writers, no working data. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../src/db.js';
import { scheduleGate, cabinetBells, scheduleProblems } from '../src/lib/schedule-conflicts.js';
import { documentScheduleProblems, reconcile, newReport, writeAll } from '../src/lib/import-core.js';
if (process.env.MTB_SCRATCH_DB !== '1') throw new Error('Use npm run test:scratch -- test/schedule-conflict-guards.e2e.ts');
const base = process.env.API!;
const q = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows;
const call = async (path: string, body: any) => {
    const r = await fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
};
try {
    const [year] = await q('SELECT id,label FROM school_years WHERE is_current');
    const pupils = [];
    for (const n of ['A', 'B']) {
        const [p] = await q("INSERT INTO students(public_id,name,grade) VALUES ($1,$2,'III') RETURNING *", ['guard-' + n, 'Guard Pupil ' + n]);
        await q("INSERT INTO student_enrollments(student_id,school_year_id,grade) VALUES ($1,$2,'III')", [p.id, year.id]);
        pupils.push(p);
    }
    const therapists = [];
    for (const n of ['A', 'B']) {
        const [t] = await q('INSERT INTO therapists(name) VALUES ($1) RETURNING *', ['Guard Therapist ' + n]);
        await q('INSERT INTO therapist_years(therapist_id,school_year_id,active) VALUES ($1,$2,true)', [t.id, year.id]);
        for (const p of pupils) await q('INSERT INTO therapist_students(school_year_id,therapist_id,student_id) VALUES ($1,$2,$3)', [year.id, t.id, p.id]);
        therapists.push(t);
    }
    const legacy = (t = 0, p: string | null = pupils[0].name, time = '08:00-08:40', day = 'понеделник', expected: string | null = null) =>
        call('/api/schedule/slot', { year: year.label, day, time, therapist: therapists[t].name, student: p, expected });
    const session = (t = 0, p = pupils[0].public_id, time = '08:00-08:20', day = 'понеделник') =>
        call('/api/schedule/session', { year: year.label, day, time, therapistId: therapists[t].id, studentPublicId: p, expectedStudentPublicId: null });
    const clear = () => q('DELETE FROM schedule_slots WHERE school_year_id=$1', [year.id]);
    assert.equal((await legacy()).status, 200);
    let r = await legacy(1, pupils[0].name, '08:20-08:40', 'Понеделник');
    assert.equal(r.status, 409); assert.equal(r.body.doubleBooked, true);
    assert.equal((await legacy(0, pupils[1].name, '08:20-08:40')).body.therapistOccupied, true);
    assert.equal((await legacy(0, pupils[1].name)).body.actual, pupils[0].name, 'stale name guard retained');
    assert.equal((await legacy(0, null, '08:00-08:40', 'понеделник', pupils[0].name)).status, 200);
    assert.equal((await legacy(0, pupils[0].name, '08:00-08:20')).status, 200);
    assert.equal((await legacy(1, pupils[0].name, '08:20-08:40')).status, 200, 'adjacent halves allowed');
    await clear();
    assert.equal((await legacy(0, pupils[0].name, '08:00')).status, 200, 'legacy clock resolved by configured cabinet bell');
    assert.equal((await session(1)).body.doubleBooked, true, 'stable route sees bare-clock legacy row');
    await clear();
    assert.equal((await legacy(0, pupils[0].name, '03:17')).body.invalidTime, true, 'unknown clock never guessed');
    const parallel = await Promise.all([legacy(), session(1, pupils[0].public_id, '08:20-08:40', 'Понеделник')]);
    assert.deepEqual(parallel.map(r => r.status).sort(), [200, 409], 'legacy and stable-id writes share pupil/day lock');
    assert.equal((await q('SELECT count(*)::int n FROM schedule_slots'))[0].n, 1);
    await clear();
    const sameCell = await Promise.all([legacy(), legacy(0, pupils[1].name)]);
    assert.deepEqual(sameCell.map(r => r.status).sort(), [200, 409], 'empty cell first saves serialize before expected check');
    await clear();
    await q('UPDATE students SET name=$1 WHERE id=$2', [pupils[0].name, pupils[1].id]);
    assert.equal((await legacy()).body.ambiguous, true);
    await q('UPDATE students SET name=$1 WHERE id=$2', [pupils[1].name, pupils[1].id]);

    const doc = (overlap = true) => ({
        students: pupils.map(p => p.name), therapists: therapists.map(t => t.name),
        studentMeta: Object.fromEntries(pupils.map(p => [p.name, { studentId: p.public_id, grade: 'III' }])),
        therapistStudents: Object.fromEntries(therapists.map(t => [t.name, pupils.map(p => p.name)])),
        schedule: [
            { day: 'понеделник', time: '08:00-08:20', assignments: { [therapists[0].name]: pupils[0].name } },
            { day: 'Понеделник', time: overlap ? '08:00-08:40' : '08:20-08:40', assignments: { [therapists[1].name]: pupils[0].name } }
        ]
    });
    const bells = await cabinetBells(pool, year.id);
    const preview = documentScheduleProblems(doc(), reconcile(doc(), [], newReport()), bells);
    assert.equal(preview.length, 1, 'preview catches partial overlap across differently spelled same day');
    assert.equal(scheduleProblems([
        { day: 'понеделник', time: '08:00-08:20', therapist: 'a', student: '1', studentName: 'same' },
        { day: 'понеделник', time: '08:00-08:40', therapist: 'b', student: '2', studentName: 'same' }
    ], bells).length, 0, 'names are not identity');
    const app = '/api/state/conflict-guard-test';
    r = await call(app, { baseVersion: 0, payload: doc() });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.scheduleImportRefused, true);
    assert.equal((await q("SELECT count(*)::int n FROM app_state WHERE app='conflict-guard-test'"))[0].n, 0, 'refused blob is rolled back');
    assert.equal((await q('SELECT count(*)::int n FROM schedule_slots'))[0].n, 0);
    r = await call(app, { baseVersion: 0, payload: doc(false) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await q('SELECT count(*)::int n FROM schedule_slots'))[0].n, 2, 'non-conflicting legacy document still imports');
    const withNewPerson = doc();
    withNewPerson.students.push('Guard Extra Pupil');
    withNewPerson.studentMeta['Guard Extra Pupil'] = { studentId: 'guard-extra', grade: 'III' };
    const before = JSON.stringify(await q('SELECT * FROM schedule_slots ORDER BY id'));
    r = await call(app, { baseVersion: 1, payload: withNewPerson });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(JSON.stringify(await q('SELECT * FROM schedule_slots ORDER BY id')), before, 'existing schedule remains exact');
    assert.equal((await q("SELECT version FROM app_state WHERE app='conflict-guard-test'"))[0].version, 1);
    assert.equal((await q("SELECT count(*)::int n FROM students WHERE name='Guard Extra Pupil'"))[0].n, 0, 'roster writes before validation rolled back too');

    const dir = await mkdtemp(join(tmpdir(), 'mtb-conflict-fixture-'));
    try {
        const file = join(dir, 'fixture.json');
        await writeFile(file, JSON.stringify(doc()));
        for (const flags of [[], ['--apply']]) {
            await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/import-json.ts', file, ...flags]),
                (err: any) => err.code === 1 && /Увозот е одбиен целосно/.test(err.stderr), 'CLI preview/apply both refuse a partial overlap');
            assert.equal(JSON.stringify(await q('SELECT * FROM schedule_slots ORDER BY id')), before);
        }
        await writeFile(file, JSON.stringify(doc(false)));
        await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/import-json.ts', file]);
        assert.equal(JSON.stringify(await q('SELECT * FROM schedule_slots ORDER BY id')), before, 'valid preview writes nothing');
    } finally { await rm(join(dir, 'fixture.json'), { force: true }); await rmdir(dir); }

    // Hold the real importer transaction open: a cell writer must wait, then check its result.
    await clear();
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await scheduleGate(c, true);
        const payload = doc(false);
        await writeAll(c, reconcile(payload, [], newReport()), payload, null, newReport());
        let finished = false;
        const waiting = session(1).then(r => { finished = true; return r; });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(finished, false, 'document replacement excludes live writers');
        await c.query('COMMIT');
        assert.equal((await waiting).body.doubleBooked, true, 'writer rechecks committed import');
    } finally { await c.query('ROLLBACK'); c.release(); }
    console.log('PASS: legacy locks, interval guards, shared writers, strict atomic import, preview and concurrent import');
} finally { await pool.end(); }
