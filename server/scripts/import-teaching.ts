/**
 * Import the school's teaching timetable from its own workbook.
 *
 * This is the half of the crossing that Rasporedi never had. Rasporedi knows
 * that Терапевт 3 takes a child at 09:40 on Wednesday; this tells us the child
 * was in IV-б having мак. with a named teacher at the time.
 *
 * The workbook stays OUTSIDE the repository — it carries real teacher names,
 * and the repository is public (rules 1 and 6). Point the script at wherever
 * it actually lives:
 *
 *   npm run import:teaching -- "C:\Users\...\Raspored nastava.xlsx"
 *   npm run import:teaching -- ../private/Raspored-nastava.xlsx --year=2025/2026 --apply
 *   npm run import:teaching -- ../private/Raspored-nastava.xlsx --year=2025/2026 --apply --force
 *
 * Dry run by default: it parses, prints what it found and what it could not
 * make sense of, and writes nothing. --force overrides the guard that refuses
 * to replace a full timetable with a much smaller one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { pool } from '../src/db.js';
import { parseTeachingGrid } from '../src/lib/teaching.js';
import { writeTeaching } from '../src/lib/teaching-write.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const force = argv.includes('--force');
const sheetArg = argv.find((a) => a.startsWith('--sheet='))?.slice(8);
const yearArg = argv.find((a) => a.startsWith('--year='))?.slice(7);
const files = argv.filter((a) => !a.startsWith('--'));

if (files.length !== 1) {
    console.error('Usage: npm run import:teaching -- <workbook.xlsx> [--year=2025/2026] [--sheet=Name] [--apply] [--force]');
    process.exit(1);
}

/** The sheet as a plain grid — exactly what parseTeachingGrid is tested on. */
function gridOf(path: string, sheetName?: string): unknown[][] {
    const wb = XLSX.read(readFileSync(path), { type: 'buffer', cellDates: false });
    const name = sheetName || wb.SheetNames[0];
    const sheet = wb.Sheets[name];
    if (!sheet) throw new Error(`No sheet "${name}". This workbook has: ${wb.SheetNames.join(', ')}`);
    // Merged cells are NOT filled in: the parser carries the day banner across
    // its run itself, and filling them would turn the vertical "ИМЕ И ПРЕЗИМЕ"
    // merge into three header rows instead of one.
    return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: null }) as unknown[][];
}

const path = resolve(files[0]);
console.log(`Reading ${path}${sheetArg ? ` (sheet ${sheetArg})` : ''}\n`);

const parsed = parseTeachingGrid(gridOf(path, sheetArg));

parsed.notes.forEach((n) => console.log('  ' + n));
if (parsed.problems.length) {
    console.log('\nProblems:');
    parsed.problems.forEach((p) => console.log('  ! ' + p));
}

console.log('\nClasses: ' + (parsed.classes.join(', ') || '—'));
console.log('\nTeachers:');
parsed.teachers.forEach((t) => {
    const what = t.kind === 'odd'
        ? `одделенска · ${t.homeroom || '—'}`
        : `предметна · ${t.subject || (t.homeroom ? `раководител на ${t.homeroom}, предмет НЕПОЗНАТ` : 'предмет НЕПОЗНАТ')}`;
    console.log(`  ${t.name.padEnd(26)} ${what}`);
});

const byDay = new Map<string, number>();
parsed.lessons.forEach((l) => byDay.set(l.day, (byDay.get(l.day) || 0) + 1));
console.log('\nLessons per day: ' + Array.from(byDay.entries()).map(([d, n]) => `${d} ${n}`).join(' · '));

if (!apply) {
    console.log('\nDry run — nothing written. Add --apply to import.');
    await pool.end();
    process.exit(parsed.problems.length ? 1 : 0);
}

const client = await pool.connect();
try {
    await client.query('BEGIN');
    const { rows: years } = await client.query(
        `SELECT id, label FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1
         LIMIT 1`,
        [yearArg ?? null]
    );
    if (!years.length) throw new Error(`No such school year: ${yearArg}`);
    const year = years[0];
    if (force) {
        // The guard lives in writeTeaching and reads the current row count.
        // Emptying the table first is how --force says "yes, really".
        await client.query('DELETE FROM lessons WHERE school_year_id = $1', [year.id]);
    }
    const result = await writeTeaching(client, parsed, year);
    if (result.skipped) {
        await client.query('ROLLBACK');
        console.log('\nNothing written:');
        result.problems.forEach((p) => console.log('  ! ' + p));
        process.exit(1);
    }
    await client.query('COMMIT');
    console.log(`\nWritten for ${year.label}: ${result.classes} classes, ${result.teachers} teachers, ${result.lessons} lessons (replaced ${result.replaced}).`);
    if (result.problems.length) {
        console.log('Problems:');
        result.problems.forEach((p) => console.log('  ! ' + p));
    }
} catch (err) {
    await client.query('ROLLBACK');
    throw err;
} finally {
    client.release();
    await pool.end();
}
