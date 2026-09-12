/**
 * Is it all one system, or several tables that happen to share a database?
 *
 *   npm run check:consistency            the report
 *   npm run check:consistency -- --mask  the same, with names masked
 *   npm run check:consistency -- --year 2025/2026
 *
 * READ-ONLY. There is no --apply and there must never be one: every line in
 * here is either something a person decides or something that needs a change
 * of code, and a script that "fixes" an identity it cannot verify is the exact
 * failure rules 2 and 5 exist to prevent.
 *
 * It answers three questions, in this order, because they fail differently:
 *
 *   ГРЕШКИ      rows that cannot be right — a term nobody can see, a mark that
 *               cannot reach the diary, one fact written twice and disagreeing.
 *   РАБОТА      rows that are right and incomplete: a class nobody has typed
 *               in yet. A backlog is not a fault and must not be counted as
 *               one, or the faults hide inside it.
 *   ВРСКИ       what actually joins the apps, stated as numbers rather than
 *               as an assumption — including the two weekly schedules that are
 *               NOT joined and never have been.
 *
 * WHY THE SEPARATION IS THE POINT. `/api/teaching/crossing` filters sessions
 * through the year's active lists with plain JOINs, which is correct for
 * drawing a screen and invisible when something is missing: a term whose pupil
 * is not enrolled this year is not reported, it simply is not there. The same
 * is true of a therapist who is not on the year's list. So the screens cannot
 * show these, by construction, and something outside them has to look.
 *
 * The exit code follows that split: 1 when a ГРЕШКА is found, 0 when the only
 * findings are work for a person. A check that goes red every day for a
 * backlog is a check nobody reads.
 */

import { pool } from '../src/db.js';
import { normalizeClassLabel } from '../src/lib/crossing.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};
const masked = argv.includes('--mask');
const yearLabel = flag('year');

/**
 * The report is the next thing to get pasted somewhere — check-names.ts learnt
 * that the expensive way. Names are shown by default because without them the
 * findings cannot be acted on, and `--mask` exists for when this is sent on.
 */
const who = (name: string | null | undefined) => {
    const n = (name ?? '').trim();
    if (!n) return '—';
    if (!masked) return n;
    return n.split(/\s+/).map((w) => w.charAt(0) + '·'.repeat(Math.max(1, w.length - 1))).join(' ');
};

type Finding = { level: 'fault' | 'work'; title: string; lines: string[] };
const findings: Finding[] = [];
const add = (level: Finding['level'], title: string, lines: string[]) => {
    if (lines.length) findings.push({ level, title, lines });
};
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows as any[];

try {
    const years = await q(
        yearLabel
            ? 'SELECT id, label FROM school_years WHERE label = $1'
            : 'SELECT id, label FROM school_years WHERE is_current',
        yearLabel ? [yearLabel] : []
    );
    if (!years.length) throw new Error(yearLabel ? `Нема учебна година „${yearLabel}".` : 'Ниту една година не е тековна.');
    const year = years[0] as { id: number; label: string };

    const [counts] = await q(
        `SELECT (SELECT count(*) FROM student_enrollments WHERE school_year_id = $1 AND active) AS students,
                (SELECT count(*) FROM teacher_years       WHERE school_year_id = $1 AND active) AS teachers,
                (SELECT count(*) FROM therapist_years     WHERE school_year_id = $1 AND active) AS therapists,
                (SELECT count(*) FROM class_years         WHERE school_year_id = $1 AND active) AS classes,
                (SELECT count(*) FROM lessons             WHERE school_year_id = $1)            AS lessons,
                (SELECT count(*) FROM schedule_slots      WHERE school_year_id = $1)            AS slots,
                (SELECT count(*) FROM diary_schedule      WHERE school_year_id = $1)            AS diary`,
        [year.id]
    );

    // ── ГРЕШКИ ──────────────────────────────────────────────────────────────

    // A term whose pupil is not on this year's list is dropped by the
    // crossing's JOIN. It sits in the cabinet's week, it is drawn there, and
    // Настава has never heard of it.
    add('fault', 'Термини што Настава не може да ги види (ученикот не е на списокот оваа година)',
        (await q(
            `SELECT st.name, st.public_id, count(*) AS n
               FROM schedule_slots sl
               JOIN students st ON st.id = sl.student_id
              WHERE sl.school_year_id = $1 AND sl.student_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM student_enrollments e
                                 WHERE e.student_id = st.id AND e.school_year_id = $1 AND e.active)
              GROUP BY st.name, st.public_id ORDER BY count(*) DESC`, [year.id]
        )).map((r) => `${who(r.name)} (${r.public_id}) · ${r.n} термини`)
    );

    add('fault', 'Термини чиј терапевт не е на годишниот список',
        (await q(
            `SELECT th.name, count(*) AS n
               FROM schedule_slots sl
               JOIN therapists th ON th.id = sl.therapist_id
              WHERE sl.school_year_id = $1
                AND NOT EXISTS (SELECT 1 FROM therapist_years ty
                                 WHERE ty.therapist_id = th.id AND ty.school_year_id = $1 AND ty.active)
              GROUP BY th.name ORDER BY count(*) DESC`, [year.id]
        )).map((r) => `${who(r.name)} · ${r.n} термини`)
    );

    add('fault', 'Неактивен ученик со термин оваа година',
        (await q(
            `SELECT DISTINCT st.name, st.public_id FROM schedule_slots sl JOIN students st ON st.id = sl.student_id
              WHERE sl.school_year_id = $1 AND NOT st.active ORDER BY st.name`, [year.id]
        )).map((r) => `${who(r.name)} (${r.public_id})`)
    );

    // The diary reads attendance keyed by sdnevnik_id. A mark on a pupil
    // without one is written, stored, counted in the tables — and invisible in
    // S-Dnevnik for ever, which reads as the mark not having been made.
    add('fault', 'Присуство што не може да стигне до S-Dnevnik (ученикот нема sdnevnik_id)',
        (await q(
            `SELECT st.name, st.public_id, count(*) AS n
               FROM attendance a JOIN students st ON st.id = a.student_id
              WHERE st.sdnevnik_id IS NULL
              GROUP BY st.name, st.public_id ORDER BY count(*) DESC LIMIT 20`
        )).map((r) => `${who(r.name)} (${r.public_id}) · ${r.n} записи`)
    );

    // One fact, two columns. `students.grade` and the enrolment's are both
    // written today; when they disagree, which screen you opened decides what
    // the child's class is.
    add('fault', 'Паралелката пишува различно во students.grade и во запишувањето',
        (await q(
            `SELECT st.name, st.public_id, st.grade AS a, e.grade AS b
               FROM student_enrollments e JOIN students st ON st.id = e.student_id
              WHERE e.school_year_id = $1 AND e.active AND st.active
                AND coalesce(btrim(st.grade),'') <> '' AND coalesce(btrim(e.grade),'') <> ''
              ORDER BY st.name`, [year.id]
        )).filter((r) => normalizeClassLabel(r.a) !== normalizeClassLabel(r.b))
          .map((r) => `${who(r.name)} (${r.public_id}): students="${r.a}" · запишување="${r.b}"`)
    );

    // Two rows for one teacher, differing only in case, is what happens when
    // the workbook shouts and a screen title-cases. `teachers.name` is unique
    // on the exact string, so both survive and only one carries the lessons.
    add('fault', 'Ист наставник запишан двапати (се разликуваат само по големи букви или размак)',
        (await q(
            `SELECT string_agg(name, ' | ' ORDER BY id) AS names, count(*) AS n
               FROM teachers GROUP BY lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) HAVING count(*) > 1`
        )).map((r) => `${r.names}`.split(' | ').map(who).join('  |  '))
    );

    add('fault', 'Терапевт запишан двапати',
        (await q(
            `SELECT string_agg(name, ' | ' ORDER BY id) AS names FROM therapists
              GROUP BY lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) HAVING count(*) > 1`
        )).map((r) => `${r.names}`.split(' | ').map(who).join('  |  '))
    );

    add('fault', 'Каталог на терапевт кон ученик што не е на списокот оваа година',
        (await q(
            `SELECT th.name AS therapist, st.name AS student, st.public_id
               FROM therapist_students ts
               JOIN therapists th ON th.id = ts.therapist_id
               JOIN students   st ON st.id = ts.student_id
               JOIN therapist_years ty ON ty.therapist_id = th.id AND ty.school_year_id = $1 AND ty.active
              WHERE ts.school_year_id = $1
                AND NOT EXISTS (SELECT 1 FROM student_enrollments e
                                 WHERE e.student_id = st.id AND e.school_year_id = $1 AND e.active)
              ORDER BY th.name, st.name`, [year.id]
        )).map((r) => `${who(r.therapist)} → ${who(r.student)} (${r.public_id})`)
    );

    // ── РАБОТА ЗА ЧОВЕК ─────────────────────────────────────────────────────

    // Rule 2 in its everyday form: two children really do share a name, and
    // that is not a fault. It is stated so that nothing is ever matched by
    // name without a person knowing the name means two people.
    add('work', 'Две деца со исто име (не спојувај ги — правило 2)',
        (await q(
            `SELECT string_agg(st.public_id || ' · ' || coalesce(e.grade,'—'), '  |  ' ORDER BY st.id) AS both,
                    st.name
               FROM student_enrollments e JOIN students st ON st.id = e.student_id
              WHERE e.school_year_id = $1 AND e.active AND st.active
              GROUP BY lower(btrim(st.name)), st.name HAVING count(*) > 1`, [year.id]
        )).map((r) => `${who(r.name)} → ${r.both}`)
    );

    const noClass = await q(
        `SELECT st.name, st.public_id, e.kind
           FROM student_enrollments e JOIN students st ON st.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND st.active
            AND coalesce(btrim(e.grade), '') = ''
          ORDER BY e.kind, st.name`, [year.id]
    );
    // `kind_matches_grade` (migration 029) already forbids an internal or
    // boarding pupil without a class, so this can only ever be an external one
    // — and for them a missing class is a missing ASSIGNMENT, not proof that
    // they attend no teaching. Настава says the same in its own panel.
    add('work', 'Надворешни ученици без запишана паралелка или група',
        noClass.map((r) => `${who(r.name)} (${r.public_id}) · ${r.kind}`)
    );

    // The class a child is recorded in, against the classes this year has.
    // Matched through normalizeClassLabel, the single copy of "these two
    // labels are the same room" — comparing with = reports „IV-а" against
    // „IV-a" as a missing class, which is a Latin a and an hour of confusion.
    const activeClasses = (await q(
        `SELECT c.label FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active`, [year.id]
    )).map((r) => normalizeClassLabel(r.label));
    const usedClasses = await q(
        `SELECT btrim(e.grade) AS grade, count(*) AS n
           FROM student_enrollments e JOIN students st ON st.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND st.active AND coalesce(btrim(e.grade),'') <> ''
          GROUP BY btrim(e.grade) ORDER BY count(*) DESC`, [year.id]
    );
    add('work', 'Паралелка запишана кај дете, а ја нема на списокот паралелки оваа година',
        usedClasses.filter((r) => !activeClasses.includes(normalizeClassLabel(r.grade)))
                   .map((r) => `„${r.grade}" · ${r.n} деца`)
    );

    const lessonClasses = (await q(
        `SELECT DISTINCT c.label FROM lessons l JOIN school_classes c ON c.id = l.class_id
          WHERE l.school_year_id = $1`, [year.id]
    )).map((r) => normalizeClassLabel(r.label));
    add('work', 'Паралелка со деца, но без ниту еден час во распоредот на настава',
        Number(counts.lessons) === 0 ? [] :
        usedClasses.filter((r) => !lessonClasses.includes(normalizeClassLabel(r.grade)))
                   .map((r) => `„${r.grade}" · ${r.n} деца — нивните третмани остануваат неповрзани`)
    );

    add('work', 'Наставник со час, а не е на годишниот список',
        (await q(
            `SELECT t.name, count(*) AS n FROM lessons l JOIN teachers t ON t.id = l.teacher_id
              WHERE l.school_year_id = $1
                AND NOT EXISTS (SELECT 1 FROM teacher_years ty
                                 WHERE ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active)
              GROUP BY t.name ORDER BY count(*) DESC`, [year.id]
        )).map((r) => `${who(r.name)} · ${r.n} часа`)
    );

    add('work', 'Час без наставник',
        (await q(
            `SELECT c.label, count(*) AS n FROM lessons l JOIN school_classes c ON c.id = l.class_id
              WHERE l.school_year_id = $1 AND l.teacher_id IS NULL GROUP BY c.label ORDER BY count(*) DESC`, [year.id]
        )).map((r) => `${r.label} · ${r.n} часа`)
    );

    add('work', 'Дете во каталогот на терапевт, а нема ниту еден термин',
        (await q(
            `SELECT th.name AS therapist, st.name AS student, st.public_id
               FROM therapist_students ts
               JOIN therapists th ON th.id = ts.therapist_id
               JOIN students   st ON st.id = ts.student_id
               JOIN therapist_years ty ON ty.therapist_id = th.id AND ty.school_year_id = $1 AND ty.active
               JOIN student_enrollments e ON e.student_id = st.id AND e.school_year_id = $1 AND e.active
              WHERE ts.school_year_id = $1
                AND NOT EXISTS (SELECT 1 FROM schedule_slots sl
                                 WHERE sl.school_year_id = $1 AND sl.student_id = st.id AND sl.therapist_id = th.id)
              ORDER BY th.name, st.name`, [year.id]
        )).map((r) => `${who(r.therapist)} → ${who(r.student)} (${r.public_id})`)
    );

    add('work', 'Термин со дете што не е во каталогот на тој терапевт',
        (await q(
            `SELECT DISTINCT th.name AS therapist, st.name AS student, st.public_id
               FROM schedule_slots sl
               JOIN therapists th ON th.id = sl.therapist_id
               JOIN students   st ON st.id = sl.student_id
              WHERE sl.school_year_id = $1
                AND NOT EXISTS (SELECT 1 FROM therapist_students ts
                                 WHERE ts.therapist_id = th.id AND ts.student_id = st.id
                                   AND ts.school_year_id = $1)
              ORDER BY th.name, st.name`, [year.id]
        )).map((r) => `${who(r.therapist)} → ${who(r.student)} (${r.public_id})`)
    );

    // ── ВРСКИ ───────────────────────────────────────────────────────────────

    const [bridge] = await q(
        `SELECT (SELECT count(*) FROM students WHERE active AND sdnevnik_id IS NULL) AS no_sdn,
                (SELECT count(*) FROM students WHERE active AND sdnevnik_id IS NOT NULL) AS with_sdn,
                (SELECT count(DISTINCT student_id) FROM schedule_slots WHERE school_year_id = $1) AS in_cabinet,
                (SELECT count(DISTINCT student_id) FROM diary_schedule WHERE school_year_id = $1) AS in_diary`,
        [year.id]
    );
    const blobs = await q(
        `SELECT app, version, updated_at,
                coalesce(payload->'unifiedMeta'->>'slotWrites', '—') AS slot_writes,
                coalesce(payload->'_meta'->'rowWrites' #>> '{}', '—') AS row_writes,
                jsonb_array_length(coalesce(payload->'students', '[]'::jsonb)) AS students
           FROM app_state ORDER BY app`
    );
    const onlyCabinet = await q(
        `SELECT st.name, st.public_id FROM students st
          WHERE EXISTS (SELECT 1 FROM schedule_slots sl WHERE sl.school_year_id = $1 AND sl.student_id = st.id)
            AND NOT EXISTS (SELECT 1 FROM diary_schedule d WHERE d.school_year_id = $1 AND d.student_id = st.id)
          ORDER BY st.name`, [year.id]
    );

    // ── печатење ────────────────────────────────────────────────────────────

    const faults = findings.filter((f) => f.level === 'fault');
    const work = findings.filter((f) => f.level === 'work');

    console.log(`\n════ ПРОВЕРКА НА ПОВРЗАНОСТА · ${year.label} ════`);
    if (!masked) console.log('  (носи вистински имиња — за праќање користи --mask)');
    console.log(`\n  списоци:  ${counts.students} ученици · ${counts.teachers} наставници · ` +
                `${counts.therapists} стручни · ${counts.classes} паралелки`);
    console.log(`  внесено:  ${counts.lessons} часа настава · ${counts.slots} термини во кабинетите · ` +
                `${counts.diary} термини во дневникот`);

    if (Number(counts.lessons) === 0) {
        console.log('\n  ⚠ НЕМА ВНЕСЕН РАСПОРЕД НА НАСТАВА за оваа година.');
        console.log('    Вкрстувањето нема со што да вкрсти, па СЕКОЈ третман останува');
        console.log('    неповрзан — тоа не е грешка во податоците, туку распоред што го нема.');
        console.log('    npm run copy:teaching -- --from <лани>   или   npm run demo:teaching');
    }

    console.log(`\n──── ГРЕШКИ (${faults.length}) ────`);
    if (!faults.length) console.log('  нема');
    for (const f of faults) {
        console.log(`\n  ✗ ${f.title} — ${f.lines.length}`);
        for (const l of f.lines.slice(0, 15)) console.log(`      ${l}`);
        if (f.lines.length > 15) console.log(`      … и уште ${f.lines.length - 15}`);
    }

    console.log(`\n──── РАБОТА ЗА ЧОВЕК (${work.length}) ────`);
    if (!work.length) console.log('  нема');
    for (const f of work) {
        console.log(`\n  • ${f.title} — ${f.lines.length}`);
        for (const l of f.lines.slice(0, 15)) console.log(`      ${l}`);
        if (f.lines.length > 15) console.log(`      … и уште ${f.lines.length - 15}`);
    }

    console.log('\n──── ВРСКИ ────');
    console.log(`\n  Ученик ↔ S-Dnevnik (sdnevnik_id):  ${bridge.with_sdn} поврзани · ${bridge.no_sdn} неповрзани`);
    console.log('    Неповрзан ученик се гледа во Податоци и во распоредот, но неговото');
    console.log('    присуство не може да стигне до дневникот: дневникот чита по sdnevnik_id.');

    console.log(`\n  Две НЕДЕЛИ, не една:  ${bridge.in_cabinet} деца во распоредот на кабинетите ` +
                `(schedule_slots) · ${bridge.in_diary} во неделата на дневникот (diary_schedule)`);
    console.log('    Тоа се две различни табели и НИШТО не копира меѓу нив. Термин внесен во');
    console.log('    Распоред НЕ се појавува во S-Dnevnik и обратно — така е замислено:');
    console.log('    распоредот на кабинетот е договор со училиштето, неделата на дневникот е');
    console.log('    личниот план на еден терапевт. Присуството се води по вториот.');
    if (onlyCabinet.length) {
        console.log(`\n    Само во кабинетскиот распоред, не и во дневникот — ${onlyCabinet.length}:`);
        for (const r of onlyCabinet.slice(0, 10)) console.log(`      ${who(r.name)} (${r.public_id})`);
        if (onlyCabinet.length > 10) console.log(`      … и уште ${onlyCabinet.length - 10}`);
    }

    console.log('\n  Целосни документи (app_state) — што држат апликациите:');
    if (!blobs.length) console.log('    ниту еден');
    for (const b of blobs) {
        console.log(`    ${b.app}  в.${b.version}  ${new Date(b.updated_at).toISOString().slice(0, 16).replace('T', ' ')}` +
                    `  ученици во документот: ${b.students}`);
        console.log(`        slotWrites=${b.slot_writes}  rowWrites=${b.row_writes}`);
    }
    console.log('    slotWrites/rowWrites кажуваат кој дел веќе се пишува ред по ред. Каде што');
    console.log('    пишува „—", тој дел сè уште го одлучува целиот документ.');

    console.log('');
    process.exit(faults.length ? 1 : 0);
} catch (error) {
    console.error('\n' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(2);
} finally {
    await pool.end();
}
