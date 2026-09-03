/**
 * Start a new school year.
 *
 * Creates the year's working roster blank by default. The previous roster is
 * still reported as reviewed suggestions; `--carry-students` is the explicit
 * compatibility option for carrying active students automatically.
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
 *   npm run rollover -- --to 2026/2027 --carry-students --apply
 *
 * Dry run by default: it prints who would be promoted, who would graduate and
 * who would stay, and writes nothing.
 */

import { pool } from '../src/db.js';
import { rolloverSchoolYear } from '../src/lib/year-rollover.js';

function argValue(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const promote = !process.argv.includes('--no-promote');
    const carryStudents = process.argv.includes('--carry-students');
    const lastRoman = (argValue('--last-grade') || 'IX').toUpperCase();
    const toLabel = argValue('--to');

    if (!toLabel || !/^\d{4}\/\d{4}$/.test(toLabel)) {
        console.error('Usage: npm run rollover -- --to 2026/2027 [--last-grade IX] [--no-promote] [--carry-students] [--apply]');
        process.exit(1);
    }

    const client = await pool.connect();
    let result;
    try {
        if (apply) await client.query('BEGIN');
        result = await rolloverSchoolYear(client, {
            to: toLabel,
            lastGrade: lastRoman,
            promote,
            carryStudents,
            apply
        });
        if (apply) await client.query('COMMIT');
    } catch (err) {
        if (apply) await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    console.log('\n=== SCHOOL YEAR ROLLOVER ===');
    console.log(`from:  ${result.from}`);
    console.log(`to:    ${result.to}   (${result.startsOn} → ${result.endsOn})`);
    console.log(`mode:  ${apply ? 'APPLY (writes to PostgreSQL)' : 'DRY RUN (nothing is written)'}`);
    console.log(`promotion: ${promote ? `on, final grade ${lastRoman} graduates` : 'off (everyone keeps their grade)'}`);
    console.log(`new roster: ${carryStudents ? 'carry active students' : 'blank; previous students are suggestions'}`);
    console.log('');
    console.log(`roster in ${result.from}: ${result.roster}`);
    console.log(`  promoted:  ${result.promoted.length}`);
    console.log(`  graduated: ${result.graduated.length}   (not enrolled in ${toLabel})`);
    console.log(`  unchanged: ${result.unchanged.length}   (no school grade)`);
    console.log(`carried into ${toLabel}: ${result.carried}`);
    console.log('');
    console.log(`stays archived under ${result.from} (kept, still queryable):`);
    console.log(`  ${result.archived.scheduleSlots} schedule slots, ${result.archived.attendance} attendance marks,`);
    console.log(`  ${result.archived.assessments} assessments, ${result.archived.triage} triage tests`);

    if (result.graduated.length) {
        console.log(`\n--- graduating (${lastRoman}) ---`);
        result.graduated.forEach((g) => console.log(`  ${g.name}`));
        console.log('\n  These are NOT retired by this script. Archive them in');
        console.log('  S-Dnevnik (Податоци -> Учебна година), which is the only place');
        console.log('  that decides who has left; the database follows from there.');
    }
    if (result.promoted.length) {
        console.log('\n--- promoted (first 10) ---');
        result.promoted.slice(0, 10).forEach((p) => console.log(`  ${p.grade} → ${p.newGrade}   ${p.name}`));
        if (result.promoted.length > 10) console.log(`  … and ${result.promoted.length - 10} more`);
    }

    if (!apply) {
        console.log('\nDry run finished. Re-run with --apply to create the year.\n');
        await pool.end();
        return;
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
