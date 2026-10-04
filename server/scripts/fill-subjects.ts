/**
 * Lessons with no subject, filled where the answer is already known.
 *
 *   npm run subjects:fill                 dry run: what would be filled, and what is left and why
 *   npm run subjects:fill -- --apply
 *
 * A предметен teacher who lists exactly one subject of their own gets that
 * subject in every lesson of theirs that has none (`fillOwnSubjects`). The
 * rest is reported for a person: одделенски lessons, teachers with two
 * subjects, and teachers with none listed — those are fixed once in
 * Податоци → Наставници, and a second run fills their lessons.
 *
 * Only the CURRENT year: a teacher's list says what they teach now, and an
 * archived timetable must read as it was. The report names teachers, so it
 * stays in this terminal.
 */

import { pool } from '../src/db.js';
import { fillOwnSubjects } from '../src/lib/teaching-edit.js';

const apply = process.argv.includes('--apply');

const client = await pool.connect();
try {
    await client.query('BEGIN');
    const year = (await client.query('SELECT id, label FROM school_years WHERE is_current LIMIT 1')).rows[0];
    if (!year) throw new Error('No current school year.');
    const r = await fillOwnSubjects(client, year.id, apply);
    const sum = (list: Array<{ lessons: number }>) => list.reduce((n, x) => n + x.lessons, 0);

    console.log(`${year.label}: ${r.empty} lessons without a subject.\n`);
    console.log(`Filled from the teacher's only subject — ${sum(r.filled)} lessons:`);
    r.filled.forEach((x) => console.log(`  ${x.teacher}: ${x.lessons} × „${x.subject}"`));
    console.log(`\nLeft for a person:`);
    console.log(`  одделенска настава — ${sum(r.homeroom)} lessons; chosen in the class's week (Уреди настава):`);
    r.homeroom.forEach((x) => console.log(`    ${x.teacher}: ${x.lessons}`));
    console.log(`  no subject listed — ${sum(r.unlisted)} lessons; give the teacher a subject in Податоци, then run this again:`);
    r.unlisted.forEach((x) => console.log(`    ${x.teacher}: ${x.lessons}`));
    console.log(`  two or more subjects — ${sum(r.several)} lessons; the person chooses per lesson:`);
    r.several.forEach((x) => console.log(`    ${x.teacher} (${x.subjects.join(', ')}): ${x.lessons}`));
    if (r.noTeacher) console.log(`  no teacher in the lesson — ${r.noTeacher}`);

    if (!apply) {
        await client.query('ROLLBACK');
        console.log('\nDry run — nothing was written. Add --apply.');
    } else {
        await client.query('COMMIT');
        console.log(`\nWritten: ${r.written} lessons.`);
    }
} catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(String((err as Error).message || err));
    process.exitCode = 1;
} finally {
    client.release();
    await pool.end();
}
