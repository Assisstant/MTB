/**
 * A year's паралелки as the school's own table has them, written in one go
 * (owner, 26 Sep 2026): for every row, the homeroom teacher, the name the
 * паралелка is shown by that year, and the teacher's kind.
 *
 * A ROW IS MATCHED BY ITS HOMEROOM TEACHER, never by its label. The labels
 * differ between installations (one calls a class „II-б", another renamed it
 * „II-б, III-б"), and a паралелка is told apart by its children and the person
 * who leads it — the label is internal. So: the teacher is found on the year's
 * list by name, exactly (rule 2: two with one name is a refusal, not a pick),
 * and the паралелка is the one they lead this year. A teacher who leads none
 * yet is given one only when the row says which: an existing label, or
 * `create` for a паралелка the database does not have.
 *
 * ALL OR NOTHING. Every row is tried inside one transaction, and a single row
 * that cannot be matched rolls the whole list back. A dry run makes the same
 * writes and rolls them back too, so what it reports is what applying would do.
 *
 * WHAT IT NEVER DOES: deactivate a паралелка missing from the list, move a
 * pupil, or rename a label. Missing ones are reported; the pupils' classes
 * have their own screen; a label is what every link is made by.
 *
 * The file holding the list names people, so it lives in `backups/` (ignored)
 * or outside the repository — never in a commit (rule 1).
 */
import { setClassAlias, setHomeroom, tidy, upsertClass } from './teaching-edit.js';

export interface ClassListRow {
    /** The homeroom teacher, as the year's teacher list spells the name. */
    homeroom: string;
    /** The name the паралелка is shown by this year. */
    alias: string;
    /** The teacher's kind: одделенска ('odd') or предметна ('pred') настава. */
    kind?: 'odd' | 'pred';
    /** For a teacher who leads no паралелка yet: the existing one to give them. */
    label?: string;
    /** For a паралелка the database does not have: create it under `label`. */
    create?: boolean;
    /**
     * For an EMPLOYEE who is not on the year's teacher list: make them a
     * teacher this year (with `kind`), linked to the same employee — what
     * ticking „наставник" in Администрација → Вработени does (workspace.ts).
     * Never a second person under one name.
     */
    addTeacher?: boolean;
}

export interface ClassListPlan {
    year?: string;
    /** How many паралелки the Годишна програма gives the year. */
    count?: number | null;
    classes: ClassListRow[];
}

export interface ClassListLine {
    position: number;
    alias: string;
    homeroom: string;
    label: string | null;
    done: string[];
    problem: string | null;
}

export interface ClassListReport {
    year: string;
    applied: boolean;
    lines: ClassListLine[];
    count: { was: number | null; now: number | null; entered: number };
    /** Active паралелки of the year that no row names; left as they are. */
    unlisted: Array<{ label: string; alias: string | null; homeroom: string | null; pupils: number }>;
    /** Internal pupils of the year who sit in no паралелка. */
    withoutClass: number;
    problems: number;
}

const key = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('mk-MK');

export async function applyClassList(client: any, plan: ClassListPlan, options: { apply: boolean; year?: string }): Promise<ClassListReport> {
    if (!plan || !Array.isArray(plan.classes) || !plan.classes.length) throw new Error('the list has no паралелки');
    await client.query('BEGIN');
    try {
        const wanted = options.year ?? plan.year;
        const yr = await client.query(
            `SELECT id, label, class_count FROM school_years
              WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`, [wanted ?? null]);
        if (!yr.rows.length) throw new Error(`no such school year: ${wanted ?? '(current)'}`);
        const year = yr.rows[0] as { id: number; label: string; class_count: number | null };

        // Two runs of a list for the same year wait for each other.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`class-list|${year.id}`]);

        const teachers = (await client.query(
            `SELECT t.id, t.name, t.kind FROM teachers t
               JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active`, [year.id])).rows as
            Array<{ id: number; name: string; kind: string }>;

        const lines: ClassListLine[] = [];
        const taken = new Map<number, number>();
        for (const [position, row] of plan.classes.entries()) {
            const alias = tidy(row.alias) ?? '';
            const line: ClassListLine = { position, alias, homeroom: String(row.homeroom ?? ''), label: null, done: [], problem: null };
            lines.push(line);
            if (!alias) { line.problem = 'нема име за приказ'; continue; }
            let named = teachers.filter((t) => key(t.name) === key(String(row.homeroom ?? '')));
            if (named.length > 1) { line.problem = 'двајца наставници со исто име — не се погодува'; continue; }
            if (!named.length && row.addTeacher) {
                const people = (await client.query('SELECT id, name FROM employees WHERE superseded_by IS NULL')).rows
                    .filter((e: any) => key(e.name) === key(String(row.homeroom ?? '')));
                if (people.length !== 1) { line.problem = people.length ? 'двајца вработени со исто име — не се погодува' : 'нема таков вработен'; continue; }
                if (!row.kind) { line.problem = 'за нов наставник треба kind: odd (одделенска) или pred (предметна)'; continue; }
                let profile = (await client.query('SELECT id, name, kind FROM teachers WHERE employee_id = $1', [people[0].id])).rows[0];
                if (!profile) {
                    profile = (await client.query(
                        'INSERT INTO teachers (name, kind, employee_id) VALUES ($1, $2, $3) RETURNING id, name, kind',
                        [people[0].name, row.kind, people[0].id])).rows[0];
                    line.done.push('наставник (истиот вработен)');
                }
                await client.query(
                    `INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)
                     ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`, [year.id, profile.id]);
                line.done.push('на списокот на наставници');
                teachers.push(profile);
                named = [profile];
            }
            if (!named.length) {
                line.problem = 'нема таков наставник на списокот за годинава (ако е вработен, стави addTeacher и kind)';
                continue;
            }
            const teacher = named[0];

            const leads = (await client.query(
                `SELECT c.id, c.label FROM teacher_classes tc
                   JOIN school_classes c ON c.id = tc.class_id
                   JOIN class_years cy ON cy.class_id = c.id AND cy.school_year_id = tc.school_year_id AND cy.active
                  WHERE tc.school_year_id = $1 AND tc.teacher_id = $2 AND tc.role = 'homeroom'`, [year.id, teacher.id])).rows;
            if (leads.length > 1) { line.problem = `води ${leads.length} паралелки — која е оваа?`; continue; }

            let cls: { id: number; label: string } | null = leads[0] ?? null;
            if (!cls) {
                const label = tidy(row.label);
                if (!label) { line.problem = 'не води паралелка годинава — во редот треба ознака (label) или create'; continue; }
                const found = (await client.query('SELECT id, label FROM school_classes WHERE label = $1', [label])).rows[0];
                if (!found && !row.create) { line.problem = `нема паралелка со ознака „${label}“ — за нова стави create`; continue; }
                cls = found ?? await upsertClass(client, label);
                if (!found) line.done.push('нова паралелка');
                const joined = await client.query(
                    `INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)
                     ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true
                     RETURNING (xmax = 0) AS inserted`, [year.id, cls!.id]);
                if (found && joined.rows[0].inserted) line.done.push('додадена во годината');
                const { replaced } = await setHomeroom(client, year.id, teacher.id, cls!.id);
                line.done.push('раководител' + (replaced.length ? ` (наместо ${replaced.map((r) => r.teacher).join(', ')})` : ''));
            }
            line.label = cls!.label;
            if (taken.has(cls!.id)) { line.problem = `истата паралелка е и во ред ${taken.get(cls!.id)}`; continue; }
            taken.set(cls!.id, position);

            const named2 = await setClassAlias(client, year.id, cls!.id, alias);
            if (!named2.ok) { line.problem = 'паралелката не е на листата за годинава'; continue; }
            if (named2.action !== 'unchanged') line.done.push('име');

            if (row.kind && row.kind !== teacher.kind) {
                await client.query('UPDATE teachers SET kind = $2 WHERE id = $1', [teacher.id, row.kind]);
                line.done.push(row.kind === 'odd' ? 'одделенска настава' : 'предметна настава');
                teacher.kind = row.kind;
            }

            const order = await client.query(
                `INSERT INTO roster_order (school_year_id, list, member_key, position) VALUES ($1, 'classes', $2, $3)
                 ON CONFLICT (school_year_id, list, member_key) DO UPDATE SET position = EXCLUDED.position
                 WHERE roster_order.position IS DISTINCT FROM EXCLUDED.position
                 RETURNING position`, [year.id, String(cls!.id), position]);
            if (order.rowCount) line.done.push('редослед');
        }

        let now = year.class_count;
        if (plan.count !== undefined && plan.count !== year.class_count) {
            await client.query('UPDATE school_years SET class_count = $2 WHERE id = $1', [year.id, plan.count]);
            now = plan.count ?? null;
        }

        const listed = [...taken.keys()];
        const unlisted = (await client.query(
            `SELECT c.label, cy.alias,
                    (SELECT string_agg(t.name, ' и ') FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
                      WHERE tc.class_id = c.id AND tc.school_year_id = $1 AND tc.role = 'homeroom') AS homeroom,
                    (SELECT count(*)::int FROM student_enrollments e
                      WHERE e.school_year_id = $1 AND e.active AND e.grade = c.label) AS pupils
               FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
              WHERE cy.school_year_id = $1 AND cy.active AND NOT (c.id = ANY($2::int[]))
              ORDER BY c.sort_key, c.label`, [year.id, listed])).rows;
        const entered = (await client.query(
            'SELECT count(*)::int AS n FROM class_years WHERE school_year_id = $1 AND active', [year.id])).rows[0].n;
        const withoutClass = (await client.query(
            `SELECT count(*)::int AS n FROM student_enrollments e JOIN students s ON s.id = e.student_id
              WHERE e.school_year_id = $1 AND e.active AND s.active
                AND e.enrollment_type <> 'external' AND nullif(btrim(e.grade), '') IS NULL`, [year.id])).rows[0].n;

        const problems = lines.filter((l) => l.problem).length;
        const applied = options.apply && !problems;
        await client.query(applied ? 'COMMIT' : 'ROLLBACK');
        return { year: year.label, applied, lines, count: { was: year.class_count, now, entered }, unlisted, withoutClass, problems };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    }
}

