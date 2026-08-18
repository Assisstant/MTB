/**
 * Start a new school year.
 *
 * Carries the ROSTER forward and leaves everything else behind, which is how
 * the work actually restarts each September: names carry over, the schedule
 * is rebuilt, attendance and assessments begin again.
 *
 * Nothing is deleted. Last year's schedule, attendance, assessments, triage
 * tests and progress stay in place and stay queryable — they are archived by
 * being tagged with their year, not by being moved or dropped.
 *
 * Promotion follows the same rules as Rasporedi's own year transition:
 *   - a grade like "IV-б" advances to "V-б" (Roman numeral up, section kept)
 *   - students in the final grade (IX by default) graduate and are not
 *     enrolled in the new year
 *   - students with no school grade (preschool, "(над.)", "(под.)") stay as
 *     they are
 *
 * Usage (from the server folder):
 *   npm run rollover -- --to 2026/2027
 *   npm run rollover -- --to 2026/2027 --apply
 *   npm run rollover -- --to 2026/2027 --last-grade IX --no-promote --apply
 *
 * Dry run by default: it prints who would be promoted, who would graduate and
 * who would stay, and writes nothing.
 */

import { pool } from '../src/db.js';

const ROMAN_ORDER: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const ROMAN_BY_ORDER: Record<number, string> = Object.fromEntries(
    Object.entries(ROMAN_ORDER).map(([roman, n]) => [n, roman])
);

/** "IV-б" -> { roman: "IV", section: "б" }; anything else -> null. */
function parseGrade(grade: string | null): { roman: string; section: string } | null {
    const g = String(grade ?? '').trim();
    const m = /^([IVX]+)(?:-(.+))?$/.exec(g);
    if (!m || !ROMAN_ORDER[m[1]]) return null;
    return { roman: m[1], section: (m[2] || '').trim() };
}

function nextGrade(grade: string | null, lastRoman: string): { grade: string | null; outcome: 'promoted' | 'graduated' | 'stays' } {
    const parsed = parseGrade(grade);
    if (!parsed) return { grade, outcome: 'stays' };            // preschool / (над.) / (под.)
    if (ROMAN_ORDER[parsed.roman] >= (ROMAN_ORDER[lastRoman] || 9)) {
        return { grade: null, outcome: 'graduated' };
    }
    const next = ROMAN_BY_ORDER[ROMAN_ORDER[parsed.roman] + 1];
    if (!next) return { grade, outcome: 'stays' };
    return { grade: parsed.section ? `${next}-${parsed.section}` : next, outcome: 'promoted' };
}

function argValue(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const promote = !process.argv.includes('--no-promote');
    const lastRoman = (argValue('--last-grade') || 'IX').toUpperCase();
    const toLabel = argValue('--to');

    if (!toLabel || !/^\d{4}\/\d{4}$/.test(toLabel)) {
        console.error('Usage: npm run rollover -- --to 2026/2027 [--last-grade IX] [--no-promote] [--apply]');
        process.exit(1);
    }

    const current = (await pool.query('SELECT id, label FROM school_years WHERE is_current')).rows[0];
    if (!current) { console.error('No current school year is set.'); process.exit(1); }
    if (current.label === toLabel) { console.error(`${toLabel} is already the current year.`); process.exit(1); }

    const startYear = Number(toLabel.slice(0, 4));
    const startsOn = `${startYear}-09-01`;
    const endsOn = `${startYear + 1}-08-31`;

    const roster = (await pool.query(
        `SELECT s.id, s.name, e.grade
         FROM student_enrollments e
         JOIN students s ON s.id = e.student_id
         WHERE e.school_year_id = $1 AND e.active
         ORDER BY e.grade NULLS LAST, s.name`,
        [current.id]
    )).rows;

    const promoted: any[] = [], graduated: any[] = [], stays: any[] = [];
    for (const st of roster) {
        const result = promote ? nextGrade(st.grade, lastRoman) : { grade: st.grade, outcome: 'stays' as const };
        const entry = { ...st, newGrade: result.grade };
        if (result.outcome === 'promoted') promoted.push(entry);
        else if (result.outcome === 'graduated') graduated.push(entry);
        else stays.push(entry);
    }

    // What stays behind, tagged with the old year rather than deleted.
    const archived = (await pool.query(
        `SELECT (SELECT count(*) FROM schedule_slots WHERE school_year_id = $1) AS slots,
                (SELECT count(*) FROM attendance a WHERE school_year_of(a.date) = $1) AS attendance,
                (SELECT count(*) FROM assessments x WHERE school_year_of(x.date) = $1) AS assessments,
                (SELECT count(*) FROM triage_tests t WHERE school_year_of(t.test_date) = $1) AS triage`,
        [current.id]
    )).rows[0];

    console.log('\n=== SCHOOL YEAR ROLLOVER ===');
    console.log(`from:  ${current.label}`);
    console.log(`to:    ${toLabel}   (${startsOn} → ${endsOn})`);
    console.log(`mode:  ${apply ? 'APPLY (writes to PostgreSQL)' : 'DRY RUN (nothing is written)'}`);
    console.log(`promotion: ${promote ? `on, final grade ${lastRoman} graduates` : 'off (everyone keeps their grade)'}`);
    console.log('');
    console.log(`roster in ${current.label}: ${roster.length}`);
    console.log(`  promoted:  ${promoted.length}`);
    console.log(`  graduated: ${graduated.length}   (not enrolled in ${toLabel})`);
    console.log(`  unchanged: ${stays.length}   (no school grade)`);
    console.log(`carried into ${toLabel}: ${promoted.length + stays.length}`);
    console.log('');
    console.log(`stays archived under ${current.label} (kept, still queryable):`);
    console.log(`  ${archived.slots} schedule slots, ${archived.attendance} attendance marks,`);
    console.log(`  ${archived.assessments} assessments, ${archived.triage} triage tests`);

    if (graduated.length) {
        console.log(`\n--- graduating (${lastRoman}) ---`);
        graduated.forEach((g) => console.log(`  ${g.name}`));
    }
    if (promoted.length) {
        console.log('\n--- promoted (first 10) ---');
        promoted.slice(0, 10).forEach((p) => console.log(`  ${p.grade} → ${p.newGrade}   ${p.name}`));
        if (promoted.length > 10) console.log(`  … and ${promoted.length - 10} more`);
    }

    if (!apply) {
        console.log('\nDry run finished. Re-run with --apply to create the year.\n');
        await pool.end();
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE school_years SET is_current = false WHERE is_current');
        const { rows } = await client.query(
            `INSERT INTO school_years (label, starts_on, ends_on, is_current)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (label) DO UPDATE SET is_current = true
             RETURNING id`,
            [toLabel, startsOn, endsOn]
        );
        const newYearId = rows[0].id;

        for (const st of [...promoted, ...stays]) {
            await client.query(
                `INSERT INTO student_enrollments (student_id, school_year_id, grade)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (student_id, school_year_id) DO UPDATE SET grade = EXCLUDED.grade`,
                [st.id, newYearId, st.newGrade]
            );
            // students.grade mirrors the CURRENT year, for the apps' sake.
            await client.query('UPDATE students SET grade = $1, updated_at = now() WHERE id = $2', [st.newGrade, st.id]);
        }
        // Graduated students stay in the database with their history intact.
        for (const g of graduated) {
            await client.query('UPDATE students SET active = false, updated_at = now() WHERE id = $1', [g.id]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    const check = (await pool.query(
        `SELECT y.label, count(e.student_id) AS enrolled
         FROM school_years y LEFT JOIN student_enrollments e ON e.school_year_id = y.id
         GROUP BY y.label ORDER BY y.label`
    )).rows;
    console.log('\n--- school years now in the database ---');
    check.forEach((r) => console.log(`  ${r.label}: ${r.enrolled} students`));
    console.log(`\n${toLabel} is now the current year. Its schedule is empty — build it in Rasporedi, or import one.\n`);
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nRollover failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
});
