/**
 * Generate a DEMO teaching timetable, so the screens have something to show.
 *
 *   npm run demo:teaching                          dry run, current year
 *   npm run demo:teaching -- --year 2026/2027      dry run, a named year
 *   npm run demo:teaching -- --load 23             a different weekly load
 *   npm run demo:teaching -- --apply               write it
 *   npm run demo:teaching -- --apply --replace     throw away what is there
 *
 * It reads the classes, the staff and the homerooms from the YEAR'S OWN lists
 * and the subjects with their weekly hours from `teaching_subjects`. It creates
 * nobody: no teacher, no class, no pupil. A lesson nobody is free to take is
 * written with an empty teacher and counted in the report — see the header of
 * `lib/teaching-demo.ts` for why that, and not a made-up name.
 *
 * To take it away again: „Испразни ја годината" in NastavaUredi.html, or
 * DELETE /api/teaching/year-lessons with the count you believe you are
 * throwing away.
 */

import { pool } from '../src/db.js';
import { dayOrderOf } from '../src/lib/teaching.js';
import {
    planDemoTimetable,
    type DemoClass, type DemoTeacher, type SubjectHours
} from '../src/lib/teaching-demo.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};

const yearLabel = flag('year');
const apply = argv.includes('--apply');
const replace = argv.includes('--replace');
const load = Number(flag('load') ?? 21);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

/**
 * Which grades a class covers, for reading the subject catalogue.
 *
 * `student_enrollments.oddelenie` FIRST — migration 031 named it the owner of
 * the generation range, and for a комбинирана паралелка it is the only honest
 * source. The Roman numeral in the label is the fallback, and a class with
 * neither is reported rather than guessed at: inventing a grade would invent
 * a curriculum.
 */
async function gradesOf(client: any, yearId: number, label: string): Promise<string[]> {
    const { rows } = await client.query(
        `SELECT DISTINCT btrim(e.oddelenie) AS g
           FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND s.active
            AND lower(btrim(e.grade)) = lower($2)
            AND e.oddelenie IS NOT NULL AND btrim(e.oddelenie) <> ''`,
        [yearId, label]
    );
    const found = rows.map((r: any) => String(r.g).toUpperCase()).filter((g: string) => ROMAN.includes(g));
    if (found.length) return found.sort((a: string, b: string) => ROMAN.indexOf(a) - ROMAN.indexOf(b));
    const m = /^\s*(IX|IV|V?I{0,3})\b/i.exec(label.replace(/[Іі]/g, 'I').replace(/[Хх]/g, 'X'));
    const guess = m ? m[1].toUpperCase() : '';
    return ROMAN.includes(guess) ? [guess] : [];
}

const client = await pool.connect();
try {
    await client.query('BEGIN');

    const { rows: years } = await client.query(
        `SELECT id, label FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [yearLabel ?? null]
    );
    const year = years[0];
    if (!year) throw new Error(`No school year "${yearLabel ?? '(current)'}".`);

    const existing = (await client.query(
        'SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1', [year.id]
    )).rows[0].n as number;
    if (existing && !replace) {
        console.error(
            `${year.label} already has ${existing} lessons. Nothing was generated — `
            + 'a demo must never quietly replace a real timetable. Add --replace if they really are to go.'
        );
        await client.query('ROLLBACK');
        process.exit(2);
    }

    const { rows: classRows } = await client.query(
        `SELECT c.id, c.label FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active ORDER BY c.sort_key, c.label`, [year.id]);
    const { rows: teacherRows } = await client.query(
        `SELECT t.id, t.name, t.kind, t.subject FROM teacher_years ty JOIN teachers t ON t.id = ty.teacher_id
          WHERE ty.school_year_id = $1 AND ty.active ORDER BY t.id`, [year.id]);
    const { rows: homeRows } = await client.query(
        `SELECT class_id, teacher_id FROM teacher_classes
          WHERE school_year_id = $1 AND role = 'homeroom'`, [year.id]);
    const { rows: bellRows } = await client.query(
        `SELECT coalesce(o.ordinal, b.ordinal) AS ordinal
           FROM bell_periods b
           LEFT JOIN bell_period_overrides o
                  ON o.bell_period_id = b.id AND o.school_year_id = $1
          WHERE b.kind = 'nastava-am' ORDER BY 1`, [year.id]);

    const periods: number[] = bellRows.map((r: any) => Number(r.ordinal)).filter((n: number) => n > 0);
    if (!periods.length) throw new Error('This year has no teaching bells (nastava-am).');
    if (!classRows.length) throw new Error(`${year.label} has no active classes. Enter them in Podatoci first.`);

    const homeroom = new Map<number, number>(homeRows.map((r: any) => [r.class_id, r.teacher_id]));
    const teachers: DemoTeacher[] = teacherRows.map((t: any) => ({
        id: t.id, name: t.name, kind: t.kind, subject: t.subject ?? null
    }));

    const classes: DemoClass[] = [];
    const noGrade: string[] = [];
    for (const c of classRows) {
        const grades = await gradesOf(client, year.id, c.label);
        if (!grades.length) noGrade.push(c.label);
        classes.push({ id: c.id, label: c.label, grades, homeroomTeacherId: homeroom.get(c.id) ?? null });
    }

    const { rows: subjectRows } = await client.query(
        `SELECT grade, subject, max(weekly_hours) AS hours FROM teaching_subjects
          WHERE weekly_hours IS NOT NULL GROUP BY grade, subject`);
    const byGrade = new Map<string, SubjectHours[]>();
    for (const r of subjectRows) {
        const list = byGrade.get(r.grade) ?? [];
        list.push({ subject: r.subject, hours: Number(r.hours) });
        byGrade.set(r.grade, list);
    }
    // A combined paralelka covers several grades; the union by subject name,
    // taking the larger fund, is the same rule /api/teaching/subjects uses.
    const subjectsFor = (grades: string[]): SubjectHours[] => {
        const merged = new Map<string, number>();
        for (const g of grades) {
            for (const s of byGrade.get(g) ?? []) {
                merged.set(s.subject, Math.max(merged.get(s.subject) ?? 0, s.hours));
            }
        }
        return [...merged].map(([subject, hours]) => ({ subject, hours }));
    };

    const plan = planDemoTimetable(classes, teachers, subjectsFor, { periods, load });

    console.log(`\nДЕМО распоред за ${year.label}${apply ? '' : '  (проба — ништо не се запишува)'}\n`);
    plan.notes.forEach((n) => console.log('  ' + n));
    if (noGrade.length) {
        console.log(`  ${noGrade.length} classes have no readable grade, so they got no lessons: ${noGrade.join(', ')}`);
        console.log('    Fill student_enrollments.oddelenie in Podatoci, or use a label with a Roman numeral.');
    }

    console.log('\n  Фонд по наставник:');
    const named = teachers
        .map((t) => ({ t, n: plan.load.get(t.id) ?? 0 }))
        .sort((a, b) => b.n - a.n);
    // Names are printed to the local console only; nothing here is written to
    // a file or to the repository (rules 1 and 6).
    named.forEach(({ t, n }) => console.log(
        `    ${String(n).padStart(3)}  ${t.kind === 'odd' ? 'одд.' : 'предм.'}  ${t.name}`));

    plan.problems.forEach((p) => console.log('\n  ⚠ ' + p));

    if (!apply) {
        console.log('\n  Проба. Додади --apply за да се запише.\n');
        await client.query('ROLLBACK');
        process.exit(0);
    }

    if (existing) {
        const gone = await client.query('DELETE FROM lessons WHERE school_year_id = $1', [year.id]);
        console.log(`\n  Избришани ${gone.rowCount} постоечки часа.`);
    }
    let written = 0;
    for (const l of plan.lessons) {
        const r = await client.query(
            `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (school_year_id, day, ordinal, class_id, teacher_id) DO NOTHING`,
            [year.id, l.day, dayOrderOf(l.day), l.ordinal, l.classId, l.teacherId, l.subject]
        );
        written += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
    console.log(`  Запишани ${written} часа во ${year.label}.`);
    console.log('  Ова е ДЕМО. Се брише со „Испразни ја годината" во НаставаУреди.\n');
} catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
} finally {
    client.release();
    await pool.end();
}
