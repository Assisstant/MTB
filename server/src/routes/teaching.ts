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
                `SELECT c.id, c.label, c.sort_key FROM class_years cy
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
                               l.subject, t.name AS teacher, t.id AS teacher_id
                        FROM lessons l
                        JOIN school_classes c ON c.id = l.class_id
                        LEFT JOIN teachers t  ON t.id = l.teacher_id
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
            `SELECT l.day, l.day_order, l.ordinal, c.label AS class, l.subject, t.name AS teacher
             FROM lessons l
             JOIN school_classes c ON c.id = l.class_id
             LEFT JOIN teachers t  ON t.id = l.teacher_id
             WHERE l.school_year_id = $2
               AND ($1::text IS NULL OR l.day = $1)
             ORDER BY l.day_order, l.ordinal, c.sort_key`,
            [q.day ?? null, year.id]
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
        // Kept apart from `unplaced` on purpose. An external child belongs to
        // no class and never will — they come from home for the hour. Listing
        // them as work to be done makes a backlog that cannot shrink, and the
        // real omissions then hide inside it.
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
                    external.push({ ...s, reasonCode: 'external', reason: 'the student is external and attends no lessons' });
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
                lessonsDisrupted: cells.filter((c) => c.awayCount > 0).length
            }
        };
    });

}
