import type { PoolClient } from 'pg';

export type StudentKind = 'internal' | 'boarding' | 'external';

const ROMAN_ORDER: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10
};
const ROMAN_BY_ORDER: Record<number, string> = Object.fromEntries(
    Object.entries(ROMAN_ORDER).map(([roman, n]) => [n, roman])
);

export class YearRolloverError extends Error {
    constructor(message: string, public readonly status = 409) {
        super(message);
    }
}

export interface RolloverStudent {
    id: number;
    publicId: string;
    name: string;
    grade: string | null;
    newGrade: string | null;
    kind: StudentKind;
}

export interface YearRolloverResult {
    applied: boolean;
    from: string;
    to: string;
    startsOn: string;
    endsOn: string;
    roster: number;
    carried: number;
    startsBlank: boolean;
    promoted: RolloverStudent[];
    graduated: RolloverStudent[];
    unchanged: RolloverStudent[];
    archived: {
        scheduleSlots: number;
        attendance: number;
        assessments: number;
        triage: number;
    };
}

export interface YearRolloverOptions {
    to: string;
    from?: string;
    lastGrade?: string;
    promote?: boolean;
    carryStudents?: boolean;
    apply?: boolean;
}

/** "IV-б" -> { roman: "IV", section: "б" }; anything else -> null. */
export function parseGrade(grade: string | null): { roman: string; section: string } | null {
    const value = String(grade ?? '').trim();
    const match = /^([IVX]+)(?:-(.+))?$/.exec(value);
    if (!match || !ROMAN_ORDER[match[1]]) return null;
    return { roman: match[1], section: (match[2] || '').trim() };
}

export function nextGrade(
    grade: string | null,
    lastRoman = 'IX'
): { grade: string | null; outcome: 'promoted' | 'graduated' | 'stays' } {
    const parsed = parseGrade(grade);
    if (!parsed) return { grade, outcome: 'stays' };
    if (ROMAN_ORDER[parsed.roman] >= (ROMAN_ORDER[lastRoman] || 9)) {
        return { grade: null, outcome: 'graduated' };
    }
    const next = ROMAN_BY_ORDER[ROMAN_ORDER[parsed.roman] + 1];
    if (!next) return { grade, outcome: 'stays' };
    return {
        grade: parsed.section ? `${next}-${parsed.section}` : next,
        outcome: 'promoted'
    };
}

const asCount = (value: unknown) => Number(value || 0);

/**
 * Plans or applies one September transition. The caller owns the transaction;
 * apply mode must run inside BEGIN/COMMIT so the current-year switch and every
 * enrolment either land together or do not land at all.
 */
export async function rolloverSchoolYear(
    client: PoolClient,
    options: YearRolloverOptions
): Promise<YearRolloverResult> {
    const to = options.to.trim();
    const apply = options.apply === true;
    const promote = options.promote !== false;
    const carryStudents = options.carryStudents !== false;
    const lastGrade = (options.lastGrade || 'IX').trim().toUpperCase();

    if (!/^\d{4}\/\d{4}$/.test(to)) {
        throw new YearRolloverError('school year must look like 2026/2027', 400);
    }
    if (!ROMAN_ORDER[lastGrade]) {
        throw new YearRolloverError(`unknown final grade: ${lastGrade}`, 400);
    }

    const current = (await client.query(
        `SELECT id, label FROM school_years WHERE is_current${apply ? ' FOR UPDATE' : ''}`
    )).rows[0];
    if (!current) throw new YearRolloverError('no current school year is set');
    if (options.from !== undefined && current.label !== options.from) {
        throw new YearRolloverError(
            `current school year changed from ${options.from} to ${current.label}; refresh and review again`
        );
    }
    if (current.label === to) throw new YearRolloverError(`${to} is already the current year`);

    const target = await client.query('SELECT id FROM school_years WHERE label = $1', [to]);
    if (target.rows.length) {
        throw new YearRolloverError(`${to} already exists; select it from the year list instead`);
    }

    const startYear = Number(to.slice(0, 4));
    if (Number(to.slice(5)) !== startYear + 1) {
        throw new YearRolloverError('the second year must follow the first one', 400);
    }
    const startsOn = `${startYear}-09-01`;
    const endsOn = `${startYear + 1}-08-31`;

    const roster = (await client.query(
        `SELECT s.id, s.public_id, s.name, e.grade, e.kind
           FROM student_enrollments e
           JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND s.active
          ORDER BY e.grade NULLS LAST, s.name`,
        [current.id]
    )).rows;

    const promoted: RolloverStudent[] = [];
    const graduated: RolloverStudent[] = [];
    const unchanged: RolloverStudent[] = [];
    for (const row of roster) {
        const outcome = promote
            ? nextGrade(row.grade, lastGrade)
            : { grade: row.grade, outcome: 'stays' as const };
        const student: RolloverStudent = {
            id: row.id,
            publicId: row.public_id,
            name: row.name,
            grade: row.grade,
            newGrade: outcome.grade,
            kind: row.kind || 'internal'
        };
        if (outcome.outcome === 'promoted') promoted.push(student);
        else if (outcome.outcome === 'graduated') graduated.push(student);
        else unchanged.push(student);
    }

    const archivedRow = (await client.query(
        `SELECT (SELECT count(*) FROM schedule_slots WHERE school_year_id = $1) AS slots,
                (SELECT count(*) FROM attendance a WHERE school_year_of(a.date) = $1) AS attendance,
                (SELECT count(*) FROM assessments x WHERE school_year_of(x.date) = $1) AS assessments,
                (SELECT count(*) FROM triage_tests t WHERE school_year_of(t.test_date) = $1) AS triage`,
        [current.id]
    )).rows[0];

    if (apply) {
        await client.query('UPDATE school_years SET is_current = false WHERE is_current');
        const inserted = await client.query(
            `INSERT INTO school_years (label, starts_on, ends_on, is_current)
             VALUES ($1, $2, $3, true) RETURNING id`,
            [to, startsOn, endsOn]
        );
        const newYearId = inserted.rows[0].id;

        // A new year starts with the bells that were effective in the year
        // just closed. The first transition into 2026/2027 is the exception:
        // morning teaching moved from 07:30 to the diary's 08:00 blocks.
        await client.query(
            `INSERT INTO bell_period_overrides
                    (school_year_id, bell_period_id, label, starts_at, minutes)
             SELECT $2, bell_period_id, label, starts_at, minutes
             FROM bell_period_overrides
             WHERE school_year_id = $1
             ON CONFLICT (school_year_id, bell_period_id) DO NOTHING`,
            [current.id, newYearId]
        );
        const morningOverrides = await client.query(
            `SELECT 1
             FROM bell_period_overrides o
             JOIN bell_periods b ON b.id = o.bell_period_id
             WHERE o.school_year_id = $1 AND b.schedule = 'nastava-am'
             LIMIT 1`,
            [newYearId]
        );
        if (startYear >= 2026 && !morningOverrides.rows.length) {
            await client.query(
                `INSERT INTO bell_period_overrides
                        (school_year_id, bell_period_id, label, starts_at, minutes)
                 SELECT $1, b.id, b.label,
                        CASE b.ordinal
                            WHEN 1 THEN time '08:00'
                            WHEN 2 THEN time '08:45'
                            WHEN 3 THEN time '09:40'
                            WHEN 4 THEN time '10:25'
                            WHEN 5 THEN time '11:10'
                            WHEN 6 THEN time '11:55'
                            WHEN 7 THEN time '12:40'
                        END,
                        40
                 FROM bell_periods b
                 WHERE b.schedule = 'nastava-am' AND b.ordinal BETWEEN 1 AND 7
                 ON CONFLICT (school_year_id, bell_period_id) DO NOTHING`,
                [newYearId]
            );
        }

        if (carryStudents) {
            for (const student of [...promoted, ...unchanged]) {
                await client.query(
                    `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
                     VALUES ($1, $2, $3, $4, true)`,
                    [student.id, newYearId, student.newGrade, student.kind]
                );
                await client.query(
                    'UPDATE students SET grade = $1, updated_at = now() WHERE id = $2',
                    [student.newGrade, student.id]
                );
            }
        }
    }

    return {
        applied: apply,
        from: current.label,
        to,
        startsOn,
        endsOn,
        roster: roster.length,
        carried: carryStudents ? promoted.length + unchanged.length : 0,
        startsBlank: !carryStudents,
        promoted,
        graduated,
        unchanged,
        archived: {
            scheduleSlots: asCount(archivedRow.slots),
            attendance: asCount(archivedRow.attendance),
            assessments: asCount(archivedRow.assessments),
            triage: asCount(archivedRow.triage)
        }
    };
}
