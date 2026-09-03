/**
 * Read endpoints over the relational tables.
 *
 * This is the plan's "connect the frontend" step: questions that were awkward
 * to answer inside one JSON blob — who has no schedule, who attends least,
 * which terms clash — are single queries here.
 *
 * The dataset is small (tens of students), so these return complete lists.
 * No pagination, no caching: at this size both would add moving parts without
 * saving measurable time.
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { nextGrade } from '../lib/year-rollover.js';
import { orderPupils } from '../lib/teaching.js';

export async function dataRoutes(server: FastifyInstance) {

    /** School years, newest first, with roster sizes. */
    server.get('/api/years', async () => {
        const { rows } = await pool.query(
            `SELECT y.label, y.starts_on, y.ends_on, y.is_current,
                    count(s.id)::int AS roster
             FROM school_years y
             LEFT JOIN student_enrollments e ON e.school_year_id = y.id AND e.active
             LEFT JOIN students s ON s.id = e.student_id AND (s.active OR NOT y.is_current)
             GROUP BY y.id ORDER BY y.starts_on DESC`
        );
        return rows;
    });

    /**
     * The roster for a year (default: current), each with grade, therapists
     * and how many terms a week they get.
     */
    server.get('/api/students', async (req) => {
        const q = req.query as any;
        const year = q?.year as string | undefined;
        const includeInactive = q?.includeInactive === '1' || q?.includeInactive === 'true';
        if (includeInactive) {
            const { rows } = await pool.query(
                `WITH y AS (
                     SELECT id FROM school_years
                     WHERE ($1::text IS NULL AND is_current) OR label = $1
                     LIMIT 1
                 )
                 SELECT s.public_id, s.name, coalesce(e.grade, latest.grade) AS grade,
                        s.active,
                        (s.active AND coalesce(e.active, false)) AS active_this_year,
                        s.sdnevnik_id IS NOT NULL AS has_diary,
                        coalesce(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL AND thy.active), '{}') AS therapists,
                        count(DISTINCT sl.id)::int AS terms_per_week
                 FROM students s
                 CROSS JOIN y
                 LEFT JOIN student_enrollments e
                        ON e.student_id = s.id AND e.school_year_id = y.id
                 LEFT JOIN LATERAL (
                     SELECT old.grade FROM student_enrollments old
                     WHERE old.student_id = s.id AND old.active
                     ORDER BY old.school_year_id DESC LIMIT 1
                 ) latest ON true
                 LEFT JOIN therapist_students ts ON ts.student_id = s.id AND ts.school_year_id = y.id
                 LEFT JOIN therapists t ON t.id = ts.therapist_id
                 LEFT JOIN therapist_years thy ON thy.therapist_id = t.id AND thy.school_year_id = y.id
                 LEFT JOIN schedule_slots sl ON sl.student_id = s.id AND sl.school_year_id = y.id
                 GROUP BY s.id, e.grade, e.active, latest.grade
                 ORDER BY coalesce(e.grade, latest.grade) NULLS LAST, s.name`,
                [year ?? null]
            );
            return orderPupils(rows);
        }
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT s.public_id, s.name, e.grade, s.active, s.sdnevnik_id IS NOT NULL AS has_diary,
                    COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL AND thy.active), '{}') AS therapists,
                    count(DISTINCT sl.id)::int AS terms_per_week
             FROM student_enrollments e
             JOIN y ON y.id = e.school_year_id
             JOIN students s ON s.id = e.student_id
             LEFT JOIN therapist_students ts ON ts.student_id = s.id AND ts.school_year_id = y.id
             LEFT JOIN therapists t ON t.id = ts.therapist_id
             LEFT JOIN therapist_years thy ON thy.therapist_id = t.id AND thy.school_year_id = y.id
             LEFT JOIN schedule_slots sl ON sl.student_id = s.id AND sl.school_year_id = y.id
             WHERE e.active AND s.active
             GROUP BY s.id, e.grade
             ORDER BY e.grade NULLS LAST, s.name`,
            [year ?? null]
        );
        return orderPupils(rows);
    });

    /**
     * The four lists a school year is made of, in one read.
     *
     * `Podatoci.html` draws all four at once and any of them can change the
     * others — adding a class changes what a teacher may be assigned to, and
     * adding a student changes whose caseload can grow. Four separate fetches
     * would let the page draw a teacher holding a class its own class list has
     * not heard of yet, which looks exactly like data loss.
     *
     * Deliberately NOT `/api/teaching/timetable`: that one carries every lesson
     * of the year (451 of them here) and this page never draws one.
     */
    server.get('/api/roster', async (req, reply) => {
        const label = (req.query as any)?.year as string | undefined;
        const { rows: years } = await pool.query(
            `SELECT id, label, starts_on, is_current FROM school_years
             WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
            [label ?? null]
        );
        if (!years.length) return reply.code(404).send({ error: `no such school year: ${label ?? '(current)'}` });
        const year = years[0];

        const [classes, teachers, therapists, students, studentCandidates, teacherCandidates, therapistCandidates, classCandidates] = await Promise.all([
            pool.query(
                `SELECT c.id, c.label FROM class_years cy
                 JOIN school_classes c ON c.id = cy.class_id
                 WHERE cy.school_year_id = $1 AND cy.active
                 ORDER BY c.sort_key, c.label`, [year.id]),
            pool.query(
                `SELECT t.id, t.name, t.kind, t.subject,
                        coalesce(json_agg(json_build_object('label', c.label, 'role', tc.role)
                                 ORDER BY (tc.role = 'homeroom') DESC, c.sort_key, c.label)
                                 FILTER (WHERE c.id IS NOT NULL), '[]') AS classes
                 FROM teachers t
                 JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
                 LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.school_year_id = $1
                 LEFT JOIN school_classes c   ON c.id = tc.class_id
                 GROUP BY t.id ORDER BY t.kind, t.name`,
                [year.id]
            ),
            pool.query(
                `SELECT t.id, t.name,
                        coalesce(array_agg(DISTINCT s.public_id ORDER BY s.public_id)
                                 FILTER (WHERE se.student_id IS NOT NULL), '{}') AS students,
                        count(DISTINCT sl.id)::int AS terms_per_week
                 FROM therapists t
                 JOIN therapist_years thy ON thy.therapist_id = t.id AND thy.school_year_id = $1 AND thy.active
                 LEFT JOIN therapist_students ts ON ts.therapist_id = t.id AND ts.school_year_id = $1
                 LEFT JOIN students s ON s.id = ts.student_id AND (s.active OR NOT $2::boolean)
                 LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_year_id = $1 AND se.active
                 LEFT JOIN schedule_slots sl ON sl.therapist_id = t.id AND sl.school_year_id = $1
                 GROUP BY t.id ORDER BY t.name`,
                [year.id, year.is_current]
            ),
            pool.query(
                `SELECT s.public_id, s.sdnevnik_id::text AS sdnevnik_id, s.name, e.grade, e.kind, s.active,
                        coalesce(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL AND thy.active), '{}') AS therapists
                 FROM student_enrollments e
                 JOIN students s ON s.id = e.student_id
                 LEFT JOIN therapist_students ts ON ts.student_id = s.id AND ts.school_year_id = $1
                 LEFT JOIN therapists t ON t.id = ts.therapist_id
                 LEFT JOIN therapist_years thy ON thy.therapist_id = t.id AND thy.school_year_id = $1
                 WHERE e.school_year_id = $1 AND e.active AND (s.active OR NOT $2::boolean)
                 GROUP BY s.id, e.grade, e.kind ORDER BY e.grade NULLS LAST, s.name`,
                [year.id, year.is_current]
            ),
            pool.query(
                `SELECT s.public_id, s.name,
                        current.grade AS current_grade, current.kind AS current_kind,
                        previous.grade AS last_grade, previous.kind AS last_kind,
                        previous.year AS last_year
                 FROM students s
                 LEFT JOIN student_enrollments current
                        ON current.student_id = s.id AND current.school_year_id = $1
                 LEFT JOIN LATERAL (
                     SELECT e.grade, e.kind, y.label AS year
                     FROM student_enrollments e
                     JOIN school_years y ON y.id = e.school_year_id
                     WHERE e.student_id = s.id AND e.active AND y.starts_on < $2
                     ORDER BY y.starts_on DESC LIMIT 1
                 ) previous ON true
                 WHERE s.active AND NOT coalesce(current.active, false)
                   AND (current.student_id IS NOT NULL OR previous.year IS NOT NULL)
                 ORDER BY previous.grade NULLS LAST, s.name`,
                [year.id, year.starts_on]
            ),
            pool.query(
                `SELECT t.id, t.name, t.kind, t.subject, previous.year AS last_year
                 FROM teachers t
                 LEFT JOIN teacher_years current
                        ON current.teacher_id = t.id AND current.school_year_id = $1
                 LEFT JOIN LATERAL (
                     SELECT y.label AS year FROM teacher_years old
                     JOIN school_years y ON y.id = old.school_year_id
                     WHERE old.teacher_id = t.id AND old.active AND y.starts_on < $2
                     ORDER BY y.starts_on DESC LIMIT 1
                 ) previous ON true
                 WHERE NOT coalesce(current.active, false)
                   AND (current.teacher_id IS NOT NULL OR previous.year IS NOT NULL)
                 ORDER BY t.kind, t.name`,
                [year.id, year.starts_on]
            ),
            pool.query(
                `SELECT t.id, t.name, previous.year AS last_year
                 FROM therapists t
                 LEFT JOIN therapist_years current
                        ON current.therapist_id = t.id AND current.school_year_id = $1
                 LEFT JOIN LATERAL (
                     SELECT y.label AS year FROM therapist_years old
                     JOIN school_years y ON y.id = old.school_year_id
                     WHERE old.therapist_id = t.id AND old.active AND y.starts_on < $2
                     ORDER BY y.starts_on DESC LIMIT 1
                 ) previous ON true
                 WHERE NOT coalesce(current.active, false)
                   AND (current.therapist_id IS NOT NULL OR previous.year IS NOT NULL)
                 ORDER BY t.name`,
                [year.id, year.starts_on]
            ),
            pool.query(
                `SELECT c.id, c.label, previous.year AS last_year
                 FROM school_classes c
                 LEFT JOIN class_years current
                        ON current.class_id = c.id AND current.school_year_id = $1
                 LEFT JOIN LATERAL (
                     SELECT y.label AS year FROM class_years old
                     JOIN school_years y ON y.id = old.school_year_id
                     WHERE old.class_id = c.id AND old.active AND y.starts_on < $2
                     ORDER BY y.starts_on DESC LIMIT 1
                 ) previous ON true
                 WHERE NOT coalesce(current.active, false)
                   AND (current.class_id IS NOT NULL OR previous.year IS NOT NULL)
                 ORDER BY c.sort_key, c.label`,
                [year.id, year.starts_on]
            )
        ]);

        const studentSuggestions = orderPupils(studentCandidates.rows).map((student: any) => {
            const sourceGrade = student.current_grade ?? student.last_grade;
            const suggestion = nextGrade(sourceGrade);
            return {
                ...student,
                suggested_grade: student.current_grade ?? suggestion.grade,
                suggested_kind: student.current_kind ?? student.last_kind ?? 'internal',
                graduated: student.current_grade == null && suggestion.outcome === 'graduated'
            };
        });

        return {
            year: year.label,
            isCurrentYear: year.is_current,
            classes: classes.rows,
            teachers: teachers.rows,
            therapists: therapists.rows,
            students: orderPupils(students.rows),
            candidates: {
                students: studentSuggestions,
                teachers: teacherCandidates.rows,
                therapists: therapistCandidates.rows,
                classes: classCandidates.rows
            }
        };
    });

    /** Everything known about one student, in one call. */
    server.get('/api/students/:publicId', async (req, reply) => {
        const { publicId } = req.params as { publicId: string };
        const student = (await pool.query(
            `SELECT s.id, s.public_id, s.name, s.grade, s.active, s.sdnevnik_id, p.name AS plan
             FROM students s LEFT JOIN plans p ON p.id = s.plan_id
             WHERE s.public_id = $1`,
            [publicId]
        )).rows[0];
        if (!student) return reply.code(404).send({ error: 'no such student', publicId });

        const [enrollments, schedule, attendance, progress, assessments, dossier] = await Promise.all([
            pool.query(
                `SELECT y.label, e.grade FROM student_enrollments e
                 JOIN school_years y ON y.id = e.school_year_id
                 WHERE e.student_id = $1 ORDER BY y.starts_on`, [student.id]),
            pool.query(
                `SELECT y.label AS year, sl.day, sl.time_slot, t.name AS therapist
                 FROM schedule_slots sl JOIN therapists t ON t.id = sl.therapist_id
                 LEFT JOIN school_years y ON y.id = sl.school_year_id
                 WHERE sl.student_id = $1 ORDER BY sl.day_order, sl.time_slot`, [student.id]),
            pool.query(
                `SELECT count(*) FILTER (WHERE status='present')::int AS present,
                        count(*) FILTER (WHERE status='absent')::int  AS absent,
                        min(date) AS first, max(date) AS last
                 FROM attendance WHERE student_id = $1`, [student.id]),
            pool.query(
                `SELECT p.name AS plan, count(*)::int AS completed,
                        (SELECT count(*) FROM plan_activities pa2 WHERE pa2.plan_id = p.id)::int AS in_plan,
                        max(spp.completed_on) AS last_worked
                 FROM student_plan_progress spp
                 JOIN plan_activities pa ON pa.id = spp.activity_id
                 JOIN plans p ON p.id = pa.plan_id
                 WHERE spp.student_id = $1 GROUP BY p.id, p.name`, [student.id]),
            pool.query(
                `SELECT date, period, average, comment FROM assessments
                 WHERE student_id = $1 ORDER BY date`, [student.id]),
            pool.query('SELECT * FROM student_records WHERE student_id = $1', [student.id])
        ]);

        return {
            ...student,
            enrollments: enrollments.rows,
            schedule: schedule.rows,
            attendance: attendance.rows[0],
            planProgress: progress.rows,
            assessments: assessments.rows,
            dossier: dossier.rows[0] ?? null
        };
    });

    server.get('/api/therapists', async (req) => {
        const q = req.query as any;
        const year = q?.year as string | undefined;
        const includeInactive = q?.includeInactive === '1' || q?.includeInactive === 'true';
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT t.name, coalesce(ty.active, false) AS active_this_year,
                    count(DISTINCT e.student_id)::int AS caseload,
                    count(DISTINCT sl.id)::int AS terms_per_week
             FROM therapists t
             CROSS JOIN y
             LEFT JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = y.id
             LEFT JOIN therapist_students ts ON ts.therapist_id = t.id AND ts.school_year_id = y.id
             LEFT JOIN students s ON s.id = ts.student_id AND s.active
             LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = y.id AND e.active
             LEFT JOIN schedule_slots sl ON sl.therapist_id = t.id AND sl.school_year_id = (SELECT id FROM y)
             WHERE $2::boolean OR coalesce(ty.active, false)
             GROUP BY t.id, t.name, ty.active ORDER BY caseload DESC`,
            [year ?? null, includeInactive]
        );
        return rows;
    });

    /** The week, grouped by term, ready to render. */
    server.get('/api/schedule', async (req) => {
        const q = req.query as any;
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT sl.day, sl.day_order, sl.time_slot, t.name AS therapist, s.name AS student
             FROM schedule_slots sl
             JOIN y ON y.id = sl.school_year_id
             JOIN therapists t ON t.id = sl.therapist_id
             JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = y.id AND ty.active
             LEFT JOIN students s ON s.id = sl.student_id
             LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = y.id AND e.active
             WHERE ($2::text IS NULL OR t.name = $2)
               AND (sl.student_id IS NULL OR e.student_id IS NOT NULL)
             ORDER BY sl.day_order, sl.time_slot, t.name`,
            [q?.year ?? null, q?.therapist ?? null]
        );

        const terms = new Map<string, any>();
        for (const r of rows) {
            const key = `${r.day}|${r.time_slot}`;
            if (!terms.has(key)) terms.set(key, { day: r.day, day_order: r.day_order, time: r.time_slot, assignments: {} });
            terms.get(key).assignments[r.therapist] = r.student;
        }
        return [...terms.values()];
    });

    /** Things worth a human's attention, in one place. */
    server.get('/api/stats', async (req, reply) => {
        const year = (req.query as any)?.year as string | undefined;
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id, label, starts_on, ends_on
                 FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT
               (SELECT label FROM y) AS school_year,
               (SELECT count(*) FROM student_enrollments e
                 JOIN students s ON s.id = e.student_id
                 WHERE e.school_year_id = (SELECT id FROM y)
                   AND e.active AND s.active)::int AS active_students,
               (SELECT count(*) FROM therapist_years ty
                 WHERE ty.school_year_id = (SELECT id FROM y)
                   AND ty.active)::int AS therapists,
               (SELECT count(*) FROM schedule_slots
                 WHERE school_year_id = (SELECT id FROM y))::int AS slots,
               (SELECT count(*) FROM schedule_conflicts
                 WHERE school_year = (SELECT label FROM y))::int AS double_booked,
               (SELECT count(*) FROM student_enrollments e
                 JOIN students s ON s.id = e.student_id
                 WHERE e.school_year_id = (SELECT id FROM y)
                   AND e.active AND s.active AND NOT EXISTS (
                   SELECT 1 FROM schedule_slots sl
                   WHERE sl.student_id = e.student_id
                     AND sl.school_year_id = (SELECT id FROM y)))::int AS unscheduled,
               (SELECT count(*) FROM attendance a
                 WHERE a.date BETWEEN (SELECT starts_on FROM y) AND (SELECT ends_on FROM y))::int AS attendance_marks,
               (SELECT count(*) FROM assessments a
                 WHERE a.date BETWEEN (SELECT starts_on FROM y) AND (SELECT ends_on FROM y))::int AS assessments,
               (SELECT count(*) FROM audiograms WHERE student_id IS NULL)::int AS audiograms_unlinked,
               (SELECT max(updated_at) FROM app_state) AS last_save`,
            [year ?? null]
        );
        if (!rows[0]?.school_year) {
            return reply.code(404).send({ error: `no such school year: ${year}` });
        }
        return rows[0];
    });

    /** Students booked with two therapists in the same term. */
    server.get('/api/conflicts', async (req) => {
        const year = (req.query as any)?.year as string | undefined;
        const { rows } = await pool.query(
            `SELECT school_year, day, time_slot, student, therapists
             FROM schedule_conflicts
             WHERE school_year = coalesce($1, (SELECT label FROM school_years WHERE is_current))
             ORDER BY day_order, time_slot`,
            [year ?? null]
        );
        return rows;
    });
}
