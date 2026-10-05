/**
 * Присуство по паралелка, по ден (owner, 5 Oct 2026; migration 057).
 *
 * WHAT IT IS FOR: how many pupils are in school today, so tomorrow's food can
 * be ordered („колку кифли да се нарачаат"). One mark per pupil per class per
 * day — not per lesson, and not the transport report, which stays the
 * cabinets' confirmed visits (transport-attendance.ts) and never reads this.
 *
 * WHO MARKS: a teacher who has a lesson in that class on that weekday (the
 * subject teacher while they are with the class), and the class's homeroom
 * teacher on any working day. Nobody else; a read-only account only reads,
 * which `signed()` in routes/portal.ts already enforces for every write.
 *
 * Unmarked is not absent. A pupil with no row is „неозначено", and the count
 * says so rather than guessing either way. The days a school is closed are the
 * cabinets' rule (`closedReason`), read from the same saved calendar.
 */
import { addDays, AttendanceError, calendarContext, closedReason } from './cabinet-attendance.js';
import { isIsoDate } from './duty.js';

type DB = { query: (sql: string, args?: any[]) => Promise<any> };
export type ClassMark = 'present' | 'absent' | null;
export interface ClassAccess { classId: number; label: string; alias: string | null; homeroom: boolean; weekdays: string[] }

const DAY_NAMES = ['недела', 'понеделник', 'вторник', 'среда', 'четврток', 'петок', 'сабота'];
export const dayNameOf = (date: string) => DAY_NAMES[new Date(date + 'T00:00:00Z').getUTCDay()];

/** May this access mark on this date? The homeroom any day; a lesson only on its weekday. */
export const mayMarkOn = (access: ClassAccess | null | undefined, date: string) =>
    Boolean(access && (access.homeroom || access.weekdays.includes(dayNameOf(date))));

/** The classes a teacher may see and mark this year: homeroom first, then by the school's order. */
export async function classAccessOf(db: DB, yearId: number, teacherId: number | null): Promise<ClassAccess[]> {
    if (teacherId == null) return [];
    const { rows } = await db.query(
        `SELECT c.id AS "classId", c.label, cy.alias,
                bool_or(tc.teacher_id IS NOT NULL) AS homeroom,
                coalesce(array_agg(DISTINCT l.day) FILTER (WHERE l.day IS NOT NULL), ARRAY[]::text[]) AS weekdays
           FROM school_classes c
           LEFT JOIN class_years cy ON cy.class_id = c.id AND cy.school_year_id = $1
           LEFT JOIN teacher_classes tc ON tc.class_id = c.id AND tc.school_year_id = $1
                 AND tc.teacher_id = $2 AND tc.role = 'homeroom'
           LEFT JOIN lessons l ON l.class_id = c.id AND l.school_year_id = $1 AND l.teacher_id = $2
          WHERE tc.teacher_id IS NOT NULL OR l.id IS NOT NULL
          GROUP BY c.id, c.label, cy.alias, c.sort_key
          ORDER BY bool_or(tc.teacher_id IS NOT NULL) DESC, c.sort_key, c.label`, [yearId, teacherId]);
    return rows;
}

/** Every class on the year's list, for a reader who may look at any of them. */
export async function allClassesOf(db: DB, yearId: number): Promise<ClassAccess[]> {
    const { rows } = await db.query(
        `SELECT c.id AS "classId", c.label, cy.alias, false AS homeroom, ARRAY[]::text[] AS weekdays
           FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active ORDER BY c.sort_key, c.label`, [yearId]);
    return rows;
}

async function classRow(db: DB, classId: number) {
    const row = (await db.query('SELECT id, label FROM school_classes WHERE id = $1', [classId])).rows[0];
    if (!row) throw new AttendanceError(404, 'Нема таква паралелка.');
    return row as { id: number; label: string };
}

/**
 * One class over a week or a month: its pupils, and each day's marks. The
 * pupils are the year's active enrolment in the class, plus anybody already
 * marked there in the range — a child who moved class keeps the days they
 * were marked in the old one.
 */
export async function readClassAttendance(db: DB, yearId: number, classId: number, from: string, to: string, access: ClassAccess | null) {
    if (!isIsoDate(from) || !isIsoDate(to) || from > to || Date.parse(to) - Date.parse(from) > 31 * 86400000)
        throw new AttendanceError(400, 'Изберете ден, недела или месец (најмногу 32 дена).');
    const cls = await classRow(db, classId);
    const context = await calendarContext(db, yearId);
    const pupils = (await db.query(
        `SELECT s.id AS "studentId", s.name, e.oddelenie
           FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.grade = $2 AND e.active AND s.active
         UNION
         SELECT s.id, s.name, NULL FROM class_attendance a JOIN students s ON s.id = a.student_id
          WHERE a.school_year_id = $1 AND a.class_id = $3 AND a.day BETWEEN $4 AND $5
            AND NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.student_id = s.id AND e.school_year_id = $1
                              AND e.grade = $2 AND e.active AND s.active)
          ORDER BY 2, 1`, [yearId, cls.label, classId, from, to])).rows;
    const marks = (await db.query(
        `SELECT day, student_id, status FROM class_attendance
          WHERE school_year_id = $1 AND class_id = $2 AND day BETWEEN $3 AND $4`, [yearId, classId, from, to])).rows;
    const byDay = new Map<string, Record<string, string>>();
    marks.forEach((m: any) => {
        if (!byDay.has(m.day)) byDay.set(m.day, {});
        byDay.get(m.day)![m.student_id] = m.status;
    });
    const days = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        const closed = closedReason(date, context);
        days.push({ date, dayName: dayNameOf(date), closed, future: date > context.today,
            mayMark: !closed && date <= context.today && mayMarkOn(access, date), marks: byDay.get(date) || {} });
    }
    return { class: { id: cls.id, label: cls.label, alias: access?.alias ?? null }, from, to, year: context.year.label,
        today: context.today, calendarAvailable: Boolean(context.calendar), pupils, days };
}

/**
 * One day's marks for one class, all or nothing. Caller owns the transaction.
 *
 * Each mark says what the caller saw (`expected`) and is written only if that
 * is still what is stored — an insert that finds a row, or an update or delete
 * that finds another status, is a 409 and the whole day's batch rolls back.
 * So „✓ Сите присутни" from a tab opened at 8:00 cannot overwrite the absence
 * a colleague marked at 8:30.
 */
export async function writeClassAttendance(db: DB, yearId: number, classId: number, author: string, access: ClassAccess | null,
    body: { date: string; marks: Array<{ studentId: number; status: ClassMark; expected: ClassMark }> }) {
    const cls = await classRow(db, classId);
    const context = await calendarContext(db, yearId);
    const closed = closedReason(body.date, context);
    if (closed) throw new AttendanceError(400, closed);
    if (body.date > context.today) throw new AttendanceError(400, 'Присуство не се означува однапред.');
    if (!mayMarkOn(access, body.date))
        throw new AttendanceError(403, 'Присуство во оваа паралелка бележи раководителот, или наставникот што има час во неа тој ден.');
    const ids = [...new Set(body.marks.map((m) => m.studentId))];
    if (ids.length !== body.marks.length) throw new AttendanceError(400, 'Ист ученик двапати во истиот внес.');
    // A pupil of this class this year, or one already marked here that day (to correct it).
    const known = new Set((await db.query(
        `SELECT e.student_id AS id FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.grade = $2 AND e.active AND s.active AND e.student_id = ANY($3::int[])
         UNION
         SELECT student_id FROM class_attendance
          WHERE school_year_id = $1 AND class_id = $4 AND day = $5 AND student_id = ANY($3::int[])`,
        [yearId, cls.label, ids, classId, body.date])).rows.map((r: any) => Number(r.id)));
    if (ids.some((id) => !known.has(id))) throw new AttendanceError(403, 'Ученикот не е во оваа паралелка.');

    let written = 0;
    const stale = () => new AttendanceError(409, 'Присуството е изменето во друг прозорец. Освежете ја листата и проверете повторно.');
    for (const m of body.marks) {
        if (m.status === m.expected) continue;
        const key = [yearId, classId, body.date, m.studentId];
        let changed: number;
        if (m.expected === null) {
            changed = (await db.query(
                `INSERT INTO class_attendance (school_year_id, class_id, day, student_id, status, marked_by)
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [...key, m.status, author])).rowCount;
        } else if (m.status === null) {
            changed = (await db.query(
                `DELETE FROM class_attendance WHERE school_year_id = $1 AND class_id = $2 AND day = $3 AND student_id = $4
                    AND status = $5`, [...key, m.expected])).rowCount;
        } else {
            changed = (await db.query(
                `UPDATE class_attendance SET status = $6, marked_by = $7, updated_at = now()
                  WHERE school_year_id = $1 AND class_id = $2 AND day = $3 AND student_id = $4 AND status = $5`,
                [...key, m.expected, m.status, author])).rowCount;
        }
        if (changed !== 1) throw stale();
        await db.query(
            `INSERT INTO class_attendance_changes (school_year_id, class_id, day, student_id, previous_status, status, marked_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`, [...key, m.expected, m.status, author]);
        written++;
    }
    return { ok: true, written };
}

/**
 * The day for the kitchen: per class, how many are on the list, marked present,
 * marked absent, and not marked yet; and the totals. Numbers only — no names
 * leave this function.
 */
export async function classAttendanceSummary(db: DB, yearId: number, date: string) {
    if (!isIsoDate(date)) throw new AttendanceError(400, 'Изберете ден.');
    const context = await calendarContext(db, yearId);
    const { rows } = await db.query(
        `WITH listed AS (
            SELECT c.id AS class_id, e.student_id
              FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
              JOIN student_enrollments e ON e.school_year_id = cy.school_year_id AND e.grade = c.label AND e.active
              JOIN students s ON s.id = e.student_id AND s.active
             WHERE cy.school_year_id = $1 AND cy.active
         ), marked AS (
            SELECT class_id, student_id, status, marked_by FROM class_attendance WHERE school_year_id = $1 AND day = $2
         )
         SELECT c.id AS "classId", c.label, cy.alias,
                (SELECT count(*) FROM listed l WHERE l.class_id = c.id)::int AS pupils,
                (SELECT count(*) FROM marked m WHERE m.class_id = c.id AND m.status = 'present')::int AS present,
                (SELECT count(*) FROM marked m WHERE m.class_id = c.id AND m.status = 'absent')::int AS absent,
                (SELECT count(*) FROM listed l WHERE l.class_id = c.id
                    AND NOT EXISTS (SELECT 1 FROM marked m WHERE m.class_id = c.id AND m.student_id = l.student_id))::int AS unmarked,
                coalesce((SELECT array_agg(DISTINCT m.marked_by) FROM marked m WHERE m.class_id = c.id), ARRAY[]::text[]) AS "markedBy"
           FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active
          ORDER BY c.sort_key, c.label`, [yearId, date]);
    const total = (key: 'pupils' | 'present' | 'absent' | 'unmarked') => rows.reduce((n: number, r: any) => n + r[key], 0);
    return { date, year: context.year.label, closed: closedReason(date, context), calendarAvailable: Boolean(context.calendar),
        classes: rows, totals: { pupils: total('pupils'), present: total('present'), absent: total('absent'), unmarked: total('unmarked') } };
}
