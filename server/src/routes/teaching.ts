/**
 * The crossing: which children are out of which lesson, and with whom.
 *
 * Read-only, every line of it. The therapy schedule is owned by Rasporedi and
 * the timetable by the school's workbook; this route owns neither and invents
 * nothing. What it adds is the join — and, more importantly, the ARITHMETIC,
 * computed in one place so a printed report and a browser tab can never
 * disagree about which lesson a child was pulled out of.
 *
 *   GET /api/teaching/timetable?year=…   bells, classes, teachers, lessons
 *   GET /api/teaching/crossing?year=…    the answer, per class per period
 *
 * The writes live in `teaching-edit.ts` and are used by a different page, so
 * that this file and `Nastava.html` stay a pair that cannot change anything.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { overlapsFor, disruptedBy, normalizeClassLabel, slotBell, mergeAdjacent, type Bell } from '../lib/crossing.js';

const CrossingQuery = z.object({
    day: z.string().min(1).max(32).optional(),
    // `school_years.label` is plain text and a school may write more than
    // "2026/2027" in it. A limit shorter than the column turns a legitimate
    // label into a 400 that reads like a missing year.
    year: z.string().min(1).max(64).optional(),
    /** How much of a lesson a child must miss before they count as absent from it. */
    minShare: z.coerce.number().min(0).max(1).optional()
});

async function schoolYear(label?: string) {
    const { rows } = await pool.query(
        `SELECT id, label, is_current
         FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1
         LIMIT 1`,
        [label ?? null]
    );
    return rows[0] ?? null;
}

async function bellsOf(schedule: string, schoolYearId: number): Promise<Bell[]> {
    const { rows } = await pool.query(
        `SELECT b.id, b.ordinal,
                coalesce(o.label, b.label, b.ordinal::text) AS label,
                to_char(coalesce(o.starts_at, b.starts_at), 'HH24:MI') AS starts_at,
                coalesce(o.minutes, b.minutes) AS minutes
         FROM bell_periods b
         LEFT JOIN bell_period_overrides o
           ON o.bell_period_id = b.id AND o.school_year_id = $2
         WHERE b.schedule = $1
         ORDER BY b.ordinal`,
        [schedule, schoolYearId]
    );
    // `id` and `schedule` are for the editor; the crossing ignores them.
    return rows.map((r: any) => ({
        id: r.id, schedule, ordinal: r.ordinal, label: r.label, startsAt: r.starts_at, minutes: r.minutes
    })) as Bell[];
}

export async function teachingRoutes(server: FastifyInstance) {

    server.get('/api/teaching/timetable', async (req, reply) => {
        const q = CrossingQuery.pick({ year: true }).parse(req.query);
        const year = await schoolYear(q.year);
        if (!year) return reply.code(404).send({ error: `no such school year: ${q.year}` });
        const [nastavaAm, nastavaPm, kabinet] = await Promise.all([
            bellsOf('nastava-am', year.id), bellsOf('nastava-pm', year.id), bellsOf('kabinet', year.id)
        ]);
        // The ids are here for the editor, which has to address a row rather
        // than describe it. They cost a read nothing and adding them later
        // would have meant a second, nearly identical endpoint.
        const [classes, teachers, lessons, clashes] = await Promise.all([
            pool.query(
                `SELECT c.id, c.label, c.sort_key, cy.description FROM class_years cy
                 JOIN school_classes c ON c.id = cy.class_id
                 WHERE cy.school_year_id = $1 AND cy.active
                 ORDER BY c.sort_key, c.label`, [year.id]),
            // A teacher's classes are per YEAR and there can be several of
            // them — комбинирани паралелки, and a subject teacher belongs to
            // every class they enter. `homeroom` is the first of them with
            // that role, kept as a convenience for callers that want one name.
            pool.query(`SELECT t.id, t.name, t.kind, t.subject,
                               coalesce(json_agg(json_build_object('label', c.label, 'role', tc.role)
                                        ORDER BY (tc.role = 'homeroom') DESC, c.sort_key, c.label)
                                        FILTER (WHERE c.id IS NOT NULL), '[]') AS classes,
                               min(c.label) FILTER (WHERE tc.role = 'homeroom') AS homeroom
                        FROM teachers t
                        JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
                        LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.school_year_id = $1
                        LEFT JOIN school_classes c   ON c.id = tc.class_id
                        GROUP BY t.id, t.name, t.kind, t.subject
                        ORDER BY t.kind, t.name`, [year.id]),
            pool.query(`SELECT l.id, l.day, l.day_order, l.ordinal, c.label AS class, c.id AS class_id,
                               l.subject, t.name AS teacher, t.id AS teacher_id,
                               (t.id IS NULL OR ty.teacher_id IS NOT NULL) AS teacher_on_staff
                        FROM lessons l
                        JOIN school_classes c ON c.id = l.class_id
                        LEFT JOIN teachers t  ON t.id = l.teacher_id
                        LEFT JOIN teacher_years ty
                               ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
                        WHERE l.school_year_id = $1
                        ORDER BY l.day_order, l.ordinal, c.sort_key`,
                        [year.id]),
            pool.query(
                `SELECT day, ordinal, class, who FROM teaching_clashes
                 WHERE school_year = $1 ORDER BY day_order, ordinal`,
                [year.label]
            )
        ]);
        return {
            year: year.label,
            bells: { 'nastava-am': nastavaAm, 'nastava-pm': nastavaPm, kabinet },
            classes: classes.rows,
            teachers: teachers.rows,
            lessons: lessons.rows,
            clashes: clashes.rows
        };
    });

    /**
     * What a teacher could plausibly be holding in this period.
     *
     * The MON/BRO catalogue, narrowed to the generations a paralelka actually
     * teaches. It is an OFFER, never a constraint: `lessons.subject` stays free
     * text and a subject outside this list saves exactly as before.
     *
     * Which generations, in this order, and the answer says which one it used:
     *
     *   `oddelenie` — the pupils' own generations, which is the fact migration
     *      030 created the column to hold and 031 pointed at by name. This is
     *      its first reader.
     *   `label` — the Roman numeral in „IV-а", for a numbered paralelka where
     *      the label IS the generation.
     *   `all` — everything, when neither can say. Showing forty subjects is a
     *      mild annoyance; hiding the one the teacher needs is a wall.
     *
     * UNION, not the highest generation. Measured against the workbook: for
     * Аутизам, Мултихендикеп and Интелектуална попреченост the ninth grade
     * carries 11 of 25 subjects, so „take the largest" would hide more than
     * half of them in exactly the plans this centre uses most.
     *
     * The PLAN is deliberately not derived. `class_years.description` says
     * „ученици со оштетен слух" in the school's own words, and migration 031
     * states in as many words that nothing may compute from it. So every plan
     * is offered together, folded by subject name.
     */
    server.get('/api/teaching/subjects', async (req, reply) => {
        const label = String((req.query as any)?.class ?? '').trim();
        const year = await schoolYear((req.query as any)?.year);
        if (!year) {
            return reply.code(404).send({ error: 'no such school year' });
        }

        const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
        let grades: string[] = [];
        let basis: 'oddelenie' | 'label' | 'all' = 'all';

        if (label) {
            const { rows } = await pool.query(
                `SELECT DISTINCT btrim(e.oddelenie) AS g
                   FROM student_enrollments e
                   JOIN students s ON s.id = e.student_id
                  WHERE e.school_year_id = $1 AND e.active AND s.active
                    AND lower(btrim(e.grade)) = lower($2)
                    AND e.oddelenie IS NOT NULL AND btrim(e.oddelenie) <> ''`,
                [year.id, label]
            );
            grades = rows.map((r: any) => String(r.g).toUpperCase()).filter((g) => ROMAN.includes(g));
            if (grades.length) basis = 'oddelenie';
        }
        if (!grades.length && label) {
            // „IV-а" → IV. A combined label carries no numeral and falls through.
            const match = /^\s*(IX|IV|V?I{0,3})\b/i.exec(label.replace(/[Іі]/g, 'I').replace(/[Хх]/g, 'X'));
            const guess = match ? match[1].toUpperCase() : '';
            if (ROMAN.includes(guess)) { grades = [guess]; basis = 'label'; }
        }

        const { rows: found } = await pool.query(
            grades.length
                ? `SELECT subject, min(category) AS category,
                          array_agg(DISTINCT grade ORDER BY grade) AS grades
                     FROM teaching_subjects WHERE grade = ANY($1)
                    GROUP BY subject ORDER BY subject`
                : `SELECT subject, min(category) AS category,
                          array_agg(DISTINCT grade ORDER BY grade) AS grades
                     FROM teaching_subjects GROUP BY subject ORDER BY subject`,
            grades.length ? [grades] : []
        );

        return {
            year: year.label,
            class: label || null,
            basis,
            grades: grades.sort((a, b) => ROMAN.indexOf(a) - ROMAN.indexOf(b)),
            subjects: found
        };
    });

    /**
     * For each class and teaching period: what is on, and who is not there.
     *
     * `unplaced` is the part worth reading. A session lands nowhere when the
     * child has no class recorded, or when their class is written differently
     * from the timetable's ("VI-а" against "VI"). Those are NOT folded
     * together — VI and VI-а are different rooms (rule 2) — so they surface
     * here as work for a person, not as a silently prettier number.
     */
    server.get('/api/teaching/crossing', async (req, reply) => {
        const q = CrossingQuery.parse(req.query);
        const minShare = q.minShare ?? 0.5;

        const year = await schoolYear(q.year);
        if (!year) {
            return reply.code(404).send({ error: `no such school year: ${q.year}` });
        }

        const [teachBells, cabinetBells] = await Promise.all([
            bellsOf('nastava-am', year.id), bellsOf('kabinet', year.id)
        ]);

        const { rows: lessonRows } = await pool.query(
            `SELECT l.day, l.day_order, l.ordinal, c.label AS class, l.subject, t.name AS teacher,
                    (t.id IS NULL OR ty.teacher_id IS NOT NULL) AS teacher_on_staff
             FROM lessons l
             JOIN school_classes c ON c.id = l.class_id
             LEFT JOIN teachers t  ON t.id = l.teacher_id
             LEFT JOIN teacher_years ty
                    ON ty.teacher_id = t.id AND ty.school_year_id = $2 AND ty.active
             WHERE l.school_year_id = $2
               AND ($1::text IS NULL OR l.day = $1)
             ORDER BY l.day_order, l.ordinal, c.sort_key`,
            [q.day ?? null, year.id]
        );

        // Everyone on the year's staff list, including whoever has no lesson
        // yet. „По наставник" is a list of the STAFF, not a reading of the
        // timetable: a teacher Podatoci shows and this page does not reads as
        // data loss, and it WAS — the two screens disagreed by everybody who
        // had not been given a lesson.
        const { rows: staffRows } = await pool.query(
            `SELECT t.id, t.name, t.kind FROM teachers t
               JOIN teacher_years ty
                 ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
              ORDER BY t.kind, t.name`,
            [year.id]
        );

        // And the same for classes, for the same reason and against the same
        // failure. „По одделение" was built from the LESSONS, so a class with
        // no lesson yet did not exist on this page — and the morning a year's
        // invalid timetable is thrown away to be retyped, every class vanishes
        // at once while sitting active in the database. That reads as data
        // loss on the one week it is guaranteed to happen.
        const { rows: classRows } = await pool.query(
            `SELECT c.id, c.label, cy.description FROM class_years cy
               JOIN school_classes c ON c.id = cy.class_id
              WHERE cy.school_year_id = $1 AND cy.active
              ORDER BY c.sort_key, c.label`,
            [year.id]
        );

        // Every therapy session, with the class its student is recorded in.
        const { rows: sessionRows } = await pool.query(
            `SELECT sl.day, sl.day_order, sl.time_slot, th.name AS therapist,
                    st.name AS student, coalesce(e.grade, '') AS grade,
                    coalesce(e.kind, 'internal') AS kind
             FROM schedule_slots sl
             JOIN therapists th ON th.id = sl.therapist_id
             JOIN therapist_years thy
                  ON thy.therapist_id = th.id AND thy.school_year_id = sl.school_year_id AND thy.active
             JOIN students   st ON st.id = sl.student_id
             JOIN student_enrollments e
                  ON e.student_id = st.id AND e.school_year_id = sl.school_year_id AND e.active
             WHERE sl.school_year_id = $2
               AND st.active
               AND sl.student_id IS NOT NULL
               AND ($1::text IS NULL OR sl.day = $1)
             ORDER BY sl.day_order, sl.time_slot`,
            [q.day ?? null, year.id]
        );

        const known = new Set(lessonRows.map((r: any) => normalizeClassLabel(r.class)));

        type Absence = { therapist: string; student: string; minutes: number };
        const absences = new Map<string, Map<string, Absence>>();   // day|ordinal|class -> student|therapist
        const unplaced: any[] = [];
        // An external pupil without a local class may attend therapy only.
        // Keep that case apart from missing internal class assignments, without
        // inferring that every external pupil attends no local teaching.
        const external: any[] = [];

        // The schedule stores one row per twenty-minute half, so the rows are
        // gathered into the sessions they actually are before any arithmetic.
        // Doing it the other way round splits one session across two lessons
        // and understates both — see mergeAdjacent.
        const bySession = new Map<string, { row: any; spans: Bell[] }>();
        for (const s of sessionRows) {
            const span = slotBell(s.time_slot);
            if (!span) {
                unplaced.push({ ...s, reasonCode: 'unreadable-slot', reason: `the term "${s.time_slot}" does not name a time range` });
                continue;
            }
            const key = `${s.day}|${s.therapist}|${s.student}`;
            if (!bySession.has(key)) bySession.set(key, { row: s, spans: [] });
            bySession.get(key)!.spans.push(span);
        }

        for (const { row: s, spans } of bySession.values()) {
            const label = normalizeClassLabel(s.grade);
            if (!label) {
                // The class decides placement; the kind only decides how a
                // MISSING class is reported. So correcting somebody's kind can
                // never change a number that was already right.
                if (s.kind === 'external') {
                    external.push({ ...s, reasonCode: 'external', reason: 'the external student has no local class or group recorded' });
                } else {
                    unplaced.push({ ...s, reasonCode: 'no-class', reason: 'the student has no class recorded' });
                }
                continue;
            }
            if (!known.has(label)) {
                unplaced.push({ ...s, reasonCode: 'unknown-class', reason: `class "${s.grade}" is not in the teaching timetable` });
                continue;
            }

            let placed = 0;
            for (const session of mergeAdjacent(spans)) {
                for (const hit of disruptedBy(session, teachBells, minShare)) {
                    placed++;
                    const key = `${s.day}|${hit.ordinal}|${label}`;
                    if (!absences.has(key)) absences.set(key, new Map());
                    const seat = absences.get(key)!;
                    // Two separate sessions can still touch one lesson. One
                    // child out of one lesson is ONE absence; keep the longer.
                    const who = `${s.student}|${s.therapist}`;
                    const before = seat.get(who);
                    if (!before || before.minutes < hit.minutes) {
                        seat.set(who, { therapist: s.therapist, student: s.student, minutes: hit.minutes });
                    }
                }
            }
            if (!placed) {
                unplaced.push({ ...s, reasonCode: 'outside-teaching', reason: `the term "${s.time_slot}" falls outside the teaching day` });
            }
        }

        const cells = lessonRows.map((r: any) => {
            const label = normalizeClassLabel(r.class);
            const away = Array.from((absences.get(`${r.day}|${r.ordinal}|${label}`) || new Map()).values())
                .sort((a, b) => a.student.localeCompare(b.student, 'mk'));
            return {
                day: r.day,
                dayOrder: r.day_order,
                ordinal: r.ordinal,
                class: r.class,
                subject: r.subject,
                teacher: r.teacher,
                teacherOnStaff: r.teacher_on_staff !== false,
                away,
                awayCount: away.length
            };
        });

        // Same session, seen from the cabinet: which lessons it costs.
        const blocks = cabinetBells.map((b) => ({
            ...b,
            covers: overlapsFor(b, teachBells).map((o) => ({ ordinal: o.ordinal, minutes: o.minutes, share: o.share }))
        }));

        return {
            year: year.label,
            isCurrentYear: year.is_current,
            day: q.day ?? null,
            minShare,
            bells: { teaching: teachBells, cabinet: blocks },
            teachers: staffRows,
            classes: classRows,
            cells,
            unplaced,
            external,
            summary: {
                // Sessions, not rows: two halves of one term are one session.
                sessions: bySession.size,
                placed: bySession.size - unplaced.length - external.length,
                unplaced: unplaced.length,
                external: external.length,
                // Distinct children out of a lesson, not rows: the same child
                // in both halves of one term is one absence.
                absences: cells.reduce((n, c) => n + c.awayCount, 0),
                lessonsDisrupted: cells.filter((c) => c.awayCount > 0).length,
                offStaffLessons: cells.filter((c) => !c.teacherOnStaff).length
            }
        };
    });

}
