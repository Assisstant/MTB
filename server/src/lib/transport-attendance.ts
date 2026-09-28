import { monthBounds, todayInSkopje } from './duty.js';
import { AttendanceError } from './cabinet-attendance.js';

/** Transport counts visits to the centre, not cabinet appointments. Only
 * persisted positive marks count; no recurring-plan projection or diary guess.
 * DISTINCT is by stable pupil id and calendar date across every cabinet. */
export async function transportAttendance(db: any, year: { id: number; label: string; starts_on: string; ends_on: string }, month: string) {
    const bounds = monthBounds(month);
    if (!bounds || bounds.last < year.starts_on || bounds.first > year.ends_on)
        throw new AttendanceError(400, 'Изберете месец во учебната година.');
    const today = todayInSkopje();
    const { rows } = await db.query(`WITH confirmed AS (
        SELECT DISTINCT cp.student_id, d.day
        FROM cabinet_attendance_days d
        JOIN cabinet_attendance_pupils cp USING (school_year_id,therapist_id,day)
        CROSS JOIN LATERAL jsonb_array_elements(d.plan) AS p
        WHERE d.school_year_id=$1 AND d.day BETWEEN $2 AND $3
          AND d.day BETWEEN $4 AND $5 AND d.day <= $6
          AND p->>'studentId'=cp.student_id::text AND d.marks->>(p->>'key')='present'
    ) SELECT s.id AS "studentId", s.public_id AS "publicId", s.name, coalesce(e.grade,'') AS grade,
        coalesce(array_agg(c.day::text ORDER BY c.day) FILTER (WHERE c.day IS NOT NULL), ARRAY[]::text[]) AS dates
      FROM student_enrollments e JOIN students s ON s.id=e.student_id
      LEFT JOIN confirmed c ON c.student_id=s.id
      WHERE e.school_year_id=$1 AND e.enrollment_type='external'
        AND (e.active OR c.student_id IS NOT NULL)
      GROUP BY s.id,s.public_id,s.name,e.grade ORDER BY s.name,s.id`,
        [year.id,bounds.first,bounds.last,year.starts_on,year.ends_on,today]);
    return { month, from: bounds.first, to: bounds.last, year: year.label, generatedAt: new Date().toISOString(),
        pupils: rows.map((r: any) => ({ ...r, daysPresent: r.dates.length })),
        note: 'Се бројат единствени датуми со зачувано присуство во барем еден кабинет. Нема ознака не значи отсуство. Статусот „надворешен“ е според годишниот список во Податоци.' };
}
