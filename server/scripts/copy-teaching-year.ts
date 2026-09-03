/**
 * Last year's teaching timetable as this year's starting point.
 *
 * September's real problem is not that the timetable is unknown — it is that
 * it is mostly the same as last year's with a handful of changes, and there is
 * no way to say that. The choices were "re-type 450 cells" or "wait for the
 * school to publish a workbook", and both leave the crossing blank for weeks.
 *
 * So: copy, then correct. The corrections happen in `NastavaUredi.html`, one
 * cell at a time, all year.
 *
 *   npm run copy:teaching -- --from 2025/2026                    dry run
 *   npm run copy:teaching -- --from 2025/2026 --to 2026/2027 --apply
 *   npm run copy:teaching -- --from 2025/2026 --apply --replace  throw away what is there
 *
 * `--to` defaults to the current year. Dry run by default, like every other
 * write in this project, and it refuses to write over a year that already has
 * lessons unless `--replace` says so in as many words.
 */

import { pool } from '../src/db.js';
import { copyYearLessons } from '../src/lib/teaching-edit.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};

const from = flag('from');
const to = flag('to');
const apply = argv.includes('--apply');
const replace = argv.includes('--replace');

if (!from) {
    console.error('Usage: npm run copy:teaching -- --from 2025/2026 [--to 2026/2027] [--replace] [--apply]');
    process.exit(1);
}

async function year(client: any, label?: string) {
    const { rows } = await client.query(
        `SELECT id, label FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    return rows[0] ?? null;
}

const client = await pool.connect();
try {
    await client.query('BEGIN');
    const source = await year(client, from);
    const target = await year(client, to);
    if (!source) throw new Error(`No school year "${from}".`);
    if (!target) throw new Error(`No school year "${to ?? '(current)'}".`);

    const result = await copyYearLessons(client, source, target, { replace, apply });

    result.notes.forEach((n) => console.log('  ' + n));
    if (result.problems.length) {
        console.log('\nProblems:');
        result.problems.forEach((p) => console.log('  ! ' + p));
        await client.query('ROLLBACK');
        process.exitCode = 1;
    } else if (!apply) {
        console.log('\nDry run — nothing was written. Add --apply.');
        await client.query('ROLLBACK');
    } else {
        await client.query('COMMIT');
        console.log(`\nCopied ${result.lessons} lessons into ${result.to}`
            + (result.removed ? ` (${result.removed} replaced)` : '') + '.');
        console.log('Now correct them by hand in NastavaUredi.html — the classes are last year\'s.');
    }
} catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(String((err as Error).message || err));
    process.exitCode = 1;
} finally {
    client.release();
    await pool.end();
}
