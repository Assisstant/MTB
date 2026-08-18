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

export async function dataRoutes(server: FastifyInstance) {

    /** School years, newest first, with roster sizes. */
    server.get('/api/years', async () => {
        const { rows } = await pool.query(
            `SELECT y.label, y.starts_on, y.ends_on, y.is_current,
                    count(e.student_id)::int AS roster
             FROM school_years y
             LEFT JOIN student_enrollments e ON e.school_year_id = y.id
             GROUP BY y.id ORDER BY y.starts_on DESC`
        );
        return rows;
    });

    /**
     * The roster for a year (default: current), each with grade, therapists
     * and how many terms a week they get.
     */
    server.get('/api/students', async (req) => {
        const year = (req.query as any)?.year as string | undefined;
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT s.public_id, s.name, e.grade, s.active, s.sdnevnik_id IS NOT NULL AS has_diary,
                    COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS therapists,
                    count(DISTINCT sl.id)::int AS terms_per_week
             FROM student_enrollments e
             JOIN y ON y.id = e.school_year_id
             JOIN students s ON s.id = e.student_id
             LEFT JOIN therapist_students ts ON ts.student_id = s.id
             LEFT JOIN therapists t ON t.id = ts.therapist_id
             LEFT JOIN schedule_slots sl ON sl.student_id = s.id AND sl.school_year_id = y.id
             GROUP BY s.id, e.grade
             ORDER BY e.grade NULLS LAST, s.name`,
            [year ?? null]
        );
        return rows;
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
        const year = (req.query as any)?.year as string | undefined;
        const { rows } = await pool.query(
            `WITH y AS (
                 SELECT id FROM school_years
                 WHERE ($1::text IS NULL AND is_current) OR label = $1
                 LIMIT 1
             )
             SELECT t.name,
                    count(DISTINCT ts.student_id)::int AS caseload,
                    count(DISTINCT sl.id)::int AS terms_per_week
             FROM therapists t
             LEFT JOIN therapist_students ts ON ts.therapist_id = t.id
             LEFT JOIN schedule_slots sl ON sl.therapist_id = t.id AND sl.school_year_id = (SELECT id FROM y)
             GROUP BY t.id, t.name ORDER BY caseload DESC`,
            [year ?? null]
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
             LEFT JOIN students s ON s.id = sl.student_id
             WHERE ($2::text IS NULL OR t.name = $2)
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
    server.get('/api/stats', async () => {
        const { rows } = await pool.query(
            `SELECT
               (SELECT label FROM school_years WHERE is_current) AS school_year,
               (SELECT count(*) FROM students WHERE active)::int AS active_students,
               (SELECT count(*) FROM therapists)::int AS therapists,
               (SELECT count(*) FROM schedule_slots
                 WHERE school_year_id = (SELECT id FROM school_years WHERE is_current))::int AS slots,
               (SELECT count(*) FROM schedule_conflicts)::int AS double_booked,
               (SELECT count(*) FROM students s
                 WHERE s.active AND NOT EXISTS (
                   SELECT 1 FROM schedule_slots sl
                   WHERE sl.student_id = s.id
                     AND sl.school_year_id = (SELECT id FROM school_years WHERE is_current)))::int AS unscheduled,
               (SELECT count(*) FROM attendance)::int AS attendance_marks,
               (SELECT count(*) FROM assessments)::int AS assessments,
               (SELECT count(*) FROM audiograms WHERE student_id IS NULL)::int AS audiograms_unlinked,
               (SELECT max(updated_at) FROM app_state) AS last_save`
        );
        return rows[0];
    });

    /** Students booked with two therapists in the same term. */
    server.get('/api/conflicts', async () => {
        const { rows } = await pool.query(
            'SELECT school_year, day, time_slot, student, therapists FROM schedule_conflicts ORDER BY day_order, time_slot'
        );
        return rows;
    });
}
