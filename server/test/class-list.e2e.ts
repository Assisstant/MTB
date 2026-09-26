/**
 * A year's паралелки from the school's table (lib/class-list.ts), against a
 * real database: rows matched by homeroom teacher, never by label; a dry run
 * writes nothing; one row that cannot be matched and nothing is written; the
 * second run changes nothing. Invented people in an invented year, all removed.
 *
 *     npx tsx test/class-list.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import 'dotenv/config';
import { applyClassList, type ClassListPlan } from '../src/lib/class-list.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1923/1924-classes';
const T = ['Пробна Раководителка Прва', 'Пробна Раководителка Втора', 'Пробна Раководителка Трета'];
const C = ['ПЛ-1', 'ПЛ-2', 'ПЛ-3', 'ПЛ-4', 'ПЛ-5'];
/** An employee with no teacher profile — a therapist, say — who leads ПЛ-5. */
const E = 'Пробна Вработена Без Настава';
const PUPIL = 'class-list-pupil';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function cleanup() {
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM students WHERE public_id = $1`, [PUPIL]);
    await q(`DELETE FROM school_classes WHERE label = ANY($1::text[])`, [C]);
    await q(`DELETE FROM teachers WHERE name = ANY($1::text[])`, [[...T, E]]);
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)`, [[...T, E]]);
}

async function main() {
    await cleanup();
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1923-09-01', '1924-08-31', false) RETURNING id`, [YEAR]);
    const tid: number[] = [];
    for (const name of T) {
        const [t] = await q(`INSERT INTO teachers (name, kind) VALUES ($1, 'pred') RETURNING id`, [name]);
        await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
        tid.push(t.id);
    }
    const cid: Record<string, number> = {};
    const [emp] = await q(`INSERT INTO employees (name) VALUES ($1) RETURNING id`, [E]);
    for (const label of [C[0], C[1], C[3], C[4]]) {
        const [c] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id`, [label, 'zz-' + label]);
        await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [y.id, c.id]);
        cid[label] = c.id;
    }
    // The first leads ПЛ-1 already; the second leads nothing yet; ПЛ-4 is on
    // the year's list with a pupil and in nobody's row.
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role) VALUES ($1, $2, $3, 'homeroom')`, [y.id, tid[0], cid[C[0]]]);
    const [s] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, 'Пробен Ученик Листа', $2) RETURNING id`, [PUPIL, C[3]]);
    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`, [s.id, y.id, C[3]]);

    const plan: ClassListPlan = { year: YEAR, count: 3, classes: [
        { homeroom: T[0], alias: 'I-а – пробни ученици', kind: 'odd' },
        { homeroom: '  пробна   раководителка ВТОРА ', alias: 'подготвителна', label: C[1] },
        { homeroom: T[2], alias: 'Комбинирана паралелка', label: C[2], create: true },
        { homeroom: E, alias: 'подготвителна', label: C[4], addTeacher: true, kind: 'pred' }
    ] };
    const run = async (p: ClassListPlan, apply: boolean) => {
        const client = await pool.connect();
        try { return await applyClassList(client, p, { apply }); } finally { client.release(); }
    };
    const aliasOf = async (label: string) => (await q(
        `SELECT cy.alias FROM class_years cy JOIN school_classes c ON c.id = cy.class_id WHERE cy.school_year_id = $1 AND c.label = $2`,
        [y.id, label]))[0]?.alias ?? null;

    try {
        console.log('a dry run');
        const dry = await run(plan, false);
        check('reports every row matched, none a problem', dry.problems === 0 && dry.lines.every((l) => l.label), JSON.stringify(dry.lines));
        check('by homeroom teacher, spelling of spaces and case aside', dry.lines[1].label === C[1]);
        check('and says what it would do', dry.lines[2].done.includes('нова паралелка') && dry.lines[0].done.includes('одделенска настава'),
            JSON.stringify(dry.lines.map((l) => l.done)));
        check('but writes nothing', !dry.applied && await aliasOf(C[0]) === null
            && !(await q(`SELECT 1 FROM school_classes WHERE label = $1`, [C[2]])).length
            && (await q(`SELECT kind FROM teachers WHERE id = $1`, [tid[0]]))[0].kind === 'pred');

        console.log('\none row that cannot be matched');
        const broken = await run({ ...plan, classes: [...plan.classes, { homeroom: 'Непостоечка Наставничка', alias: 'X' }] }, true);
        check('is named', broken.problems === 1 && /нема таков наставник/.test(broken.lines[broken.lines.length - 1].problem || ''), JSON.stringify(broken.lines[broken.lines.length - 1]));
        check('and nothing at all is written', !broken.applied && await aliasOf(C[0]) === null);

        console.log('\napplied');
        const done = await run(plan, true);
        check('it is written', done.applied && done.problems === 0);
        check('the name for the year', await aliasOf(C[0]) === 'I-а – пробни ученици' && await aliasOf(C[1]) === 'подготвителна');
        check('the homeroom of a паралелка that had none',
            (await q(`SELECT 1 FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2 AND class_id = $3 AND role = 'homeroom'`,
                [y.id, tid[1], cid[C[1]]])).length === 1);
        check('a паралелка the database did not have, on the year\'s list, with its homeroom',
            (await q(`SELECT 1 FROM school_classes c JOIN class_years cy ON cy.class_id = c.id AND cy.school_year_id = $1 AND cy.active
                       JOIN teacher_classes tc ON tc.class_id = c.id AND tc.school_year_id = $1 AND tc.teacher_id = $2 AND tc.role = 'homeroom'
                      WHERE c.label = $3`, [y.id, tid[2], C[2]])).length === 1);
        check('the teacher\'s kind', (await q(`SELECT kind FROM teachers WHERE id = $1`, [tid[0]]))[0].kind === 'odd');
        const order = (await q(`SELECT c.label, o.position FROM roster_order o JOIN school_classes c ON c.id::text = o.member_key
                                 WHERE o.school_year_id = $1 AND o.list = 'classes' ORDER BY o.position`, [y.id])).map((r: any) => r.label);
        check('the order of the list', JSON.stringify(order) === JSON.stringify([C[0], C[1], C[2], C[4]]), JSON.stringify(order));
        check('the count by the Годишна програма', (await q(`SELECT class_count FROM school_years WHERE id = $1`, [y.id]))[0].class_count === 3
            && done.count.entered === 5, JSON.stringify(done.count));
        check('a паралелка in no row is reported and left as it is',
            done.unlisted.length === 1 && done.unlisted[0].label === C[3] && done.unlisted[0].pupils === 1
            && (await q(`SELECT active FROM class_years WHERE school_year_id = $1 AND class_id = $2`, [y.id, cid[C[3]]]))[0].active === true,
            JSON.stringify(done.unlisted));
        const profiles = await q(`SELECT t.id, t.kind FROM teachers t WHERE t.employee_id = $1`, [emp.id]);
        check('an employee who was not a teacher becomes one — the same person, not a second one',
            profiles.length === 1 && profiles[0].kind === 'pred'
            && (await q(`SELECT count(*)::int AS n FROM employees WHERE name = $1`, [E]))[0].n === 1, JSON.stringify(profiles));
        check('on the year\'s teacher list, leading their паралелка',
            (await q(`SELECT 1 FROM teacher_years WHERE school_year_id = $1 AND teacher_id = $2 AND active`, [y.id, profiles[0]?.id])).length === 1
            && (await q(`SELECT 1 FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2 AND class_id = $3 AND role = 'homeroom'`,
                [y.id, profiles[0]?.id, cid[C[4]]])).length === 1);
        check('and no pupil was moved', (await q(`SELECT grade FROM student_enrollments WHERE student_id = $1`, [s.id]))[0].grade === C[3]);

        console.log('\nthe second time');
        const again = await run(plan, true);
        check('changes nothing', again.applied && again.lines.every((l) => !l.done.length), JSON.stringify(again.lines.map((l) => l.done)));
    } finally {
        await cleanup();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}

main().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
