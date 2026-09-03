import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { nextGrade, rolloverSchoolYear } from '../src/lib/year-rollover.js';

test('grade promotion keeps the class section and stops at IX', () => {
    assert.deepEqual(nextGrade('IV-б'), { grade: 'V-б', outcome: 'promoted' });
    assert.deepEqual(nextGrade('IX-а'), { grade: null, outcome: 'graduated' });
    assert.deepEqual(nextGrade('предучилишно'), { grade: 'предучилишно', outcome: 'stays' });
    assert.deepEqual(nextGrade(null), { grade: null, outcome: 'stays' });
});

test('a new year carries active students and their kind without touching the old year', async () => {
    const client = await pool.connect();
    const target = '1888/1889';
    const prefix = 'test-year-rollover-';
    try {
        await client.query('BEGIN');
        const current = (await client.query('SELECT id, label FROM school_years WHERE is_current')).rows[0];
        assert.ok(current, 'a current school year is required');
        assert.notEqual(current.label, target);

        const bell = (await client.query(
            `SELECT id, label FROM bell_periods WHERE schedule = 'kabinet' ORDER BY ordinal LIMIT 1`
        )).rows[0];
        assert.ok(bell, 'a cabinet bell is required');
        await client.query(
            `INSERT INTO bell_period_overrides
                    (school_year_id, bell_period_id, label, starts_at, minutes)
             VALUES ($1, $2, $3, '06:01', 17)
             ON CONFLICT (school_year_id, bell_period_id) DO UPDATE
                 SET label = EXCLUDED.label, starts_at = EXCLUDED.starts_at, minutes = EXCLUDED.minutes`,
            [current.id, bell.id, bell.label]
        );

        // Everything is inside this transaction and is rolled back below.
        await client.query('DELETE FROM school_years WHERE label = $1', [target]);
        await client.query('DELETE FROM students WHERE public_id LIKE $1', [`${prefix}%`]);

        const fixtures = [
            ['internal', 'VIII-б', true],
            ['boarding', 'VIII-а', true],
            ['external', null, true],
            ['internal', 'IX-а', true],
            ['internal', 'III-а', false],
            ['internal', 'предучилишно', true]
        ] as const;
        for (let i = 0; i < fixtures.length; i++) {
            const [kind, grade, active] = fixtures[i];
            const student = (await client.query(
                `INSERT INTO students (public_id, name, grade, active)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [`${prefix}${i}`, `${prefix}${i}`, grade, active]
            )).rows[0];
            await client.query(
                `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind)
                 VALUES ($1, $2, $3, $4)`,
                [student.id, current.id, grade, kind]
            );
        }

        const blankPreview = await rolloverSchoolYear(client, {
            from: current.label,
            to: target,
            lastGrade: 'IX',
            carryStudents: false,
            apply: false
        });
        assert.equal(blankPreview.startsBlank, true);
        assert.equal(blankPreview.carried, 0);
        assert.equal(
            blankPreview.promoted.filter((student) => student.publicId.startsWith(prefix)).length,
            2,
            'the old roster is still offered as reviewed suggestions'
        );

        const result = await rolloverSchoolYear(client, {
            from: current.label,
            to: target,
            lastGrade: 'IX',
            apply: true
        });
        assert.equal(result.applied, true);

        const carriedBell = (await client.query(
            `SELECT to_char(o.starts_at, 'HH24:MI') AS starts_at, o.minutes
             FROM bell_period_overrides o
             JOIN school_years y ON y.id = o.school_year_id
             WHERE y.label = $1 AND o.bell_period_id = $2`,
            [target, bell.id]
        )).rows[0];
        assert.deepEqual(carriedBell, { starts_at: '06:01', minutes: 17 }, 'the next year starts with the current bells');

        const carried = (await client.query(
            `SELECT s.public_id, e.grade, e.kind
               FROM student_enrollments e
               JOIN students s ON s.id = e.student_id
               JOIN school_years y ON y.id = e.school_year_id
              WHERE y.label = $1 AND s.public_id LIKE $2
              ORDER BY s.public_id`,
            [target, `${prefix}%`]
        )).rows;
        assert.deepEqual(carried, [
            { public_id: `${prefix}0`, grade: 'IX-б', kind: 'internal' },
            { public_id: `${prefix}1`, grade: 'IX-а', kind: 'boarding' },
            { public_id: `${prefix}2`, grade: null, kind: 'external' },
            { public_id: `${prefix}5`, grade: 'предучилишно', kind: 'internal' }
        ]);

        const oldRows = await client.query(
            `SELECT count(*)::int AS n
               FROM student_enrollments e JOIN students s ON s.id = e.student_id
              WHERE e.school_year_id = $1 AND s.public_id LIKE $2`,
            [current.id, `${prefix}%`]
        );
        assert.equal(oldRows.rows[0].n, fixtures.length);
        assert.equal(result.graduated.some((s) => s.publicId === `${prefix}3`), true);
        assert.equal(result.promoted.some((s) => s.publicId === `${prefix}4`), false, 'inactive students stay out');
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
