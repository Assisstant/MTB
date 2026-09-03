/**
 * The school's own list of pupils, read against the database.
 *
 * Every September the resource centre writes the year's lists into its годишна
 * програма: which classes were formed and who is in them. That document is the
 * source. The database has never had it — a child's class only ever arrived
 * embedded in their NAME („V-а - Име Презиме"), typed into an app that had
 * nowhere else to put it, which is the single reason most therapy sessions
 * cannot be attached to a lesson.
 *
 *   npm run import:roster -- <list.docx> --year 2025/2026            report
 *   npm run import:roster -- <list.docx> --year 2025/2026 --apply    write it
 *   npm run import:roster -- <list.docx> --year 2025/2026 --promote --to 2026/2027
 *
 * Dry run by default, like every other write in this project. The file stays
 * wherever the school keeps it and never enters this repository (rules 1, 6).
 *
 * WHAT `--apply` WRITES, and nothing else:
 *   · `student_enrollments.grade` for the year named — the class, where it
 *     belongs, instead of inside a name;
 *   · `student_enrollments.kind = 'internal'` for everyone on the list, since
 *     being in a class is what internal means;
 *   · `students.name` cleaned to the document's spelling — the class prefix
 *     and the school's parenthetical removed.
 *
 * The rename is safe by construction rather than by inspection. A pupil is
 * MATCHED on `bareName`, which already ignores the prefix, the parenthetical,
 * the case and the spacing — so those are the only things that can differ
 * between the two spellings, and a genuinely different name never reaches the
 * rename at all: it is reported as unknown instead. `public_id` never moves,
 * so every term, mark and dossier follows without being touched.
 *
 * WHAT IT NEVER DOES. It does not create a student and it does not remove one.
 * A name on the list that the database has never heard of is REPORTED — adding
 * a child is `POST /api/students` from `Podatoci.html`, where a person can see
 * the whole list while doing it. A child in the database that the list does
 * not mention is reported too, and is usually экстерен rather than gone.
 *
 * `--promote` prints next September and writes nothing at all, deliberately.
 * Which children are on a year's list is owned by `PUT /api/roster/memberships`
 * and shown as reviewed suggestions in `Podatoci.html` (rule 5); a second path
 * that wrote the same fact from a script is exactly the arrangement this
 * project keeps having to undo. The point of the report is that the numeral is
 * certain and the section letter is not — the school forms its classes afresh
 * each year, so this year's two fourth classes may be one fifth class or three.
 */

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { docxTables, parseRosterGrid, classShapeProblems, promote, splitClassLabel } from '../src/lib/roster-doc.js';
import { bareName, personName } from '../src/lib/import-core.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};

const file = argv.find((a) => !a.startsWith('--') && /\.(docx|xml)$/i.test(a));
const yearLabel = flag('year');
const toLabel = flag('to');
const apply = argv.includes('--apply');
const wantPromote = argv.includes('--promote');
const lastGrade = (flag('last') || 'IX').toUpperCase();

if (!file || !yearLabel) {
    console.error('Usage: npm run import:roster -- <list.docx> --year 2025/2026 [--promote --to 2026/2027] [--apply]');
    process.exit(1);
}

const doc = (() => {
    const tables = docxTables(readFileSync(file));
    if (!tables.length) throw new Error('no table in that document — is it the pupil list?');
    // The list is the biggest table: a school document often opens with a
    // one-cell table used as a heading box, and picking the first would read
    // the title as a roster of one.
    const biggest = tables.reduce((a, b) => (b.length > a.length ? b : a));
    return parseRosterGrid(biggest);
})();

const say = (s = '') => console.log(s);
const counts = new Map<string, number>();
for (const r of doc.rows) counts.set(r.classLabel, (counts.get(r.classLabel) ?? 0) + 1);

say(`${file}`);
say(`  ${doc.rows.length} pupils, ${counts.size} classes`);
say('  ' + [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'mk'))
    .map(([label, n]) => `${label}:${n}`).join('  '));

const shape = classShapeProblems(counts.keys());
if (shape.length || doc.problems.length) {
    say('\n  ── the document contradicts itself here ──');
    // The shape problems first: they are about how the school NAMES its
    // classes, so one of them can explain several odd-looking pupils.
    for (const p of shape) say(`  ! ${p}`);
    for (const p of doc.problems) say(`  ! ${p}`);
}

const client = await pool.connect();
try {
    await client.query('BEGIN');
    const year = (await client.query('SELECT id, label FROM school_years WHERE label = $1', [yearLabel])).rows[0];
    if (!year) throw new Error(`No school year "${yearLabel}".`);

    const { rows: known } = await client.query(
        `SELECT s.id, s.public_id, s.name, s.active, e.grade, e.kind
         FROM students s
         LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = $1`,
        [year.id]
    );
    const byKey = new Map<string, any[]>();
    for (const s of known) {
        const key = bareName(s.name);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(s);
    }

    const matched: Array<{ row: typeof doc.rows[number]; student: any }> = [];
    const ambiguous: Array<{ row: typeof doc.rows[number]; students: any[] }> = [];
    const unknown: typeof doc.rows = [];
    for (const row of doc.rows) {
        const hits = byKey.get(bareName(row.name)) ?? [];
        if (hits.length === 1) matched.push({ row, student: hits[0] });
        else if (hits.length > 1) ambiguous.push({ row, students: hits });
        else unknown.push(row);
    }
    const namedInDoc = new Set(doc.rows.map((r) => bareName(r.name)));
    const onlyInDb = known.filter((s) => s.grade !== null && !namedInDoc.has(bareName(s.name)));

    say(`\n${year.label} — the database holds ${known.length} students, ${known.filter((s) => s.grade !== null).length} enrolled in this year`);
    say(`  ${matched.length} on the list and found`);
    say(`  ${unknown.length} on the list and NOT in the database`);
    say(`  ${ambiguous.length} on the list matching more than one child`);
    say(`  ${onlyInDb.length} enrolled in this year but not on the list`);

    // Rule 2: ambiguity is reported and never resolved by guessing. Two
    // „Јана Пробева" in different grades is a real case in this school.
    if (ambiguous.length) {
        say('\n  ── the same name means two children; nothing was changed for these ──');
        for (const { row, students } of ambiguous) {
            say(`  ? ${row.classLabel}  ${row.name}`);
            for (const s of students) say(`      ${s.public_id}  ${s.name}  ${s.grade ?? '(not enrolled this year)'}`);
        }
    }
    if (unknown.length) {
        say('\n  ── on the school\'s list, unknown to the database — add them in Податоци ──');
        for (const row of unknown) say(`  + ${row.classLabel}  ${row.name}`);
    }
    if (onlyInDb.length) {
        say('\n  ── enrolled in this year, not on the school\'s list ──');
        say('     usually екстерни, who belong to no class; check the ones that are not');
        for (const s of onlyInDb) say(`  - ${s.grade || '(no class)'}  ${s.name}  [${s.kind ?? 'internal'}]`);
    }

    // ── what would change ───────────────────────────────────────────────────
    const gradeChanges: string[] = [];
    const kindChanges: string[] = [];
    const nameChanges: string[] = [];
    for (const { row, student } of matched) {
        if ((student.grade ?? '') !== row.classLabel) {
            gradeChanges.push(`  ${student.public_id}  ${student.grade ?? '(none)'} -> ${row.classLabel}   ${row.name}`);
        }
        if ((student.kind ?? 'internal') !== 'internal') {
            kindChanges.push(`  ${student.public_id}  ${student.kind} -> internal   ${row.name}`);
        }
        const wanted = personName(row.name);
        // Safe by construction, not by inspection: the two were MATCHED on
        // `bareName`, which already ignores the class prefix, the trailing
        // parenthetical, the case and the spacing — so those are the only
        // things that can differ here. A genuinely different name never
        // reaches this line; it is reported as unknown instead.
        if (student.name !== wanted) {
            nameChanges.push(`  ${student.public_id}  ${student.name} -> ${wanted}`);
        }
    }

    say(`\nwhat ${apply ? 'is being' : 'would be'} written`);
    say(`  ${gradeChanges.length} classes into the enrolment`);
    gradeChanges.forEach(say);
    if (kindChanges.length) {
        say(`  ${kindChanges.length} marked internal (they are in a class)`);
        kindChanges.forEach(say);
    }
    if (nameChanges.length) {
        say(`  ${nameChanges.length} names cleaned of the class prefix`);
        nameChanges.forEach(say);
    }

    if (apply) {
        for (const { row, student } of matched) {
            await client.query(
                `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
                 VALUES ($1, $2, $3, 'internal', true)
                 ON CONFLICT (student_id, school_year_id) DO UPDATE
                 SET grade = EXCLUDED.grade, kind = 'internal', active = true`,
                [student.id, year.id, row.classLabel]
            );
            // The class has to exist as a row, or the year's working list and
            // the timetable disagree about which rooms there are.
            await client.query(
                `INSERT INTO school_classes (label, sort_key) VALUES ($1, $1)
                 ON CONFLICT (label) DO NOTHING`, [row.classLabel]
            );
            await client.query(
                `INSERT INTO class_years (school_year_id, class_id, active)
                 SELECT $1, id, true FROM school_classes WHERE label = $2
                 ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
                [year.id, row.classLabel]
            );
            const wanted = personName(row.name);
            if (student.name !== wanted) {
                await client.query('UPDATE students SET name = $2, updated_at = now() WHERE id = $1',
                    [student.id, wanted]);
            }
        }
        await client.query('COMMIT');
        say('\napplied.');
    } else {
        await client.query('ROLLBACK');
        say('\nDry run — nothing was written. Add --apply to write it.');
    }

    // ── September ───────────────────────────────────────────────────────────
    if (wantPromote) {
        const target = toLabel ?? '(not named)';
        say(`\n${yearLabel} -> ${target}, if every class were formed the same way`);
        const certain: string[] = [];
        const suggested: string[] = [];
        const leaving: string[] = [];
        for (const { row, student } of matched) {
            const next = promote(row.classLabel, lastGrade);
            const line = `  ${row.classLabel} -> ${next.label ?? '—'}   ${student.public_id}  ${row.name}`;
            if (next.outcome === 'graduated') leaving.push(line);
            else if (next.certain) certain.push(line);
            else suggested.push(line);
        }
        say(`  ${certain.length} certain — the grade has one class, so it has no letter to lose`);
        certain.forEach(say);
        say(`  ${suggested.length} SUGGESTED — the letter survives only if the same number of classes is formed`);
        suggested.forEach(say);
        say(`  ${leaving.length} finishing ${lastGrade} — not on next year's list at all`);
        leaving.forEach(say);
        const nextLabels = new Set(matched
            .map(({ row }) => promote(row.classLabel, lastGrade).label)
            .filter((l): l is string => Boolean(l)));
        const nextShape = classShapeProblems(nextLabels);
        if (nextShape.length) {
            say('\n  ── carrying the letters over would contradict the naming rule ──');
            for (const p of nextShape) say(`  ! ${p}`);
        }
        for (const label of [...nextLabels].sort()) {
            const parts = splitClassLabel(label);
            if (parts && !parts.section) {
                say(`  · ${label} has no letter — right only if ${parts.grade} is one class next year`);
            }
        }
        say('\n  Nothing above was written. Confirm it in Податоци → предлози, which owns');
        say('  who is on a year\'s list; a second path writing the same fact is the');
        say('  arrangement this project keeps having to undo.');
    }
} catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
} finally {
    client.release();
    await pool.end();
}
