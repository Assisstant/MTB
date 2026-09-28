import { createHash } from 'node:crypto';
import { isIsoDate, todayInSkopje } from './duty.js';
import { minutesOf, timeOf } from './crossing.js';

type DB = { query: (sql: string, args?: any[]) => Promise<any> };
export type Session = { key: string; studentId: number; publicId: string; name: string; grade: string; time: string };
export type Mark = 'present' | 'absent' | null;
export class AttendanceError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
const days = ['недела', 'понеделник', 'вторник', 'среда', 'четврток', 'петок', 'сабота'];
export const addDays = (iso: string, count: number) => new Date(Date.parse(iso + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
// jsonb reorders object keys; hash a fixed projection, not object insertion order.
export const planToken = (plan: Session[]) => createHash('sha256')
    .update(JSON.stringify(plan.map(s => [s.key, s.studentId, s.publicId, s.name, s.grade, s.time]))).digest('hex');

/** Preserve exact half-hour placement. Only legacy equal 20-minute halves
 * become one 40-minute treatment; two different children remain separate. */
export function sessionsOf(rows: any[]): Session[] {
    const sorted = rows.filter(r => r.public_id).sort((a, b) => a.time_slot.localeCompare(b.time_slot));
    const out: Session[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i], next = sorted[i + 1];
        let time = row.time_slot;
        const [start, end] = time.split('-');
        if (next && next.public_id === row.public_id && minutesOf(end) - minutesOf(start) === 20
            && next.time_slot === `${end}-${timeOf(minutesOf(end) + 20)}`) {
            time = `${start}-${timeOf(minutesOf(end) + 20)}`;
            i++;
        }
        out.push({ key: `${row.student_id}|${time}`, studentId: row.student_id, publicId: row.public_id, name: row.name, grade: row.grade || '', time });
    }
    return out;
}

export function overlaps(plan: Session[]) {
    return plan.some((a, i) => plan.slice(i + 1).some(b => {
        const [af, at] = a.time.split('-').map(minutesOf), [bf, bt] = b.time.split('-').map(minutesOf);
        return af < bt && bf < at;
    }));
}

/** The calendar already saved by S-Dnevnik is read, never edited here.
 * An older year's calendar must not close dates in this one. No personal
 * diary records leave this query. A missing calendar is visible, not invented. */
export async function attendanceContext(db: DB, yearId: number, therapistId: number) {
    const year = (await db.query('SELECT starts_on, ends_on, label FROM school_years WHERE id=$1', [yearId])).rows[0];
    const stored = (await db.query("SELECT payload->'schoolCalendar' AS calendar FROM app_state WHERE app='sdnevnik'")).rows[0]?.calendar;
    const calendar = stored && isIsoDate(stored.yearStart) && isIsoDate(stored.yearEnd)
        && stored.yearStart >= year.starts_on && stored.yearEnd <= year.ends_on ? stored : null;
    const rows = (await db.query(`SELECT sl.day, sl.time_slot, s.id AS student_id, s.public_id, s.name, coalesce(e.grade,s.grade,'') AS grade
        FROM schedule_slots sl JOIN students s ON s.id=sl.student_id
        LEFT JOIN student_enrollments e ON e.student_id=s.id AND e.school_year_id=sl.school_year_id
        WHERE sl.school_year_id=$1 AND sl.therapist_id=$2 ORDER BY sl.day,sl.time_slot`, [yearId, therapistId])).rows;
    return { year, calendar, rows, today: todayInSkopje() };
}

export function closedReason(date: string, context: any): string | null {
    if (!isIsoDate(date)) return 'Невалиден датум.';
    if (date < context.year.starts_on || date > context.year.ends_on) return 'Надвор од учебната година.';
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) return 'Викенд';
    const c = context.calendar;
    if (c && (date < c.yearStart || date > c.yearEnd)) return 'Надвор од наставната година.';
    const holiday = (c?.holidays || []).find((h: any) => isIsoDate(h.start) && isIsoDate(h.end)
        && h.start <= date && date <= h.end && (h.kind === 'praznik' || h.kind === 'raspust' || !h.kind));
    return holiday ? String(holiday.name || 'Неработен ден') : null;
}

function dayView(date: string, context: any, saved?: any) {
    const closed = closedReason(date, context);
    const dayName = days[new Date(date + 'T00:00:00Z').getUTCDay()];
    const plan: Session[] = saved?.plan || (closed ? [] : sessionsOf(context.rows.filter((r: any) => r.day === dayName)));
    return { date, dayName, closed, conflict: overlaps(plan), frozen: Boolean(saved), revision: saved?.revision || 0,
        planToken: planToken(plan), sessions: plan.map(s => ({ ...s, status: saved?.marks?.[s.key] || null })), future: date > context.today };
}

export async function readAttendance(db: DB, yearId: number, therapistId: number, from: string, to: string) {
    if (!isIsoDate(from) || !isIsoDate(to) || from > to || Date.parse(to) - Date.parse(from) > 31 * 86400000)
        throw new AttendanceError(400, 'Изберете недела или месец (најмногу 32 дена).');
    const context = await attendanceContext(db, yearId, therapistId);
    const saved = (await db.query(`SELECT day,plan,marks,revision FROM cabinet_attendance_days
        WHERE school_year_id=$1 AND therapist_id=$2 AND day BETWEEN $3 AND $4`, [yearId, therapistId, from, to])).rows;
    const byDate = new Map(saved.map((r: any) => [r.day, r]));
    const result = [];
    for (let date = from; date <= to; date = addDays(date, 1)) result.push(dayView(date, context, byDate.get(date)));
    return { from, to, year: context.year.label, today: context.today, yearStart: context.year.starts_on,
        yearEnd: context.year.ends_on, calendarAvailable: Boolean(context.calendar), days: result };
}

/** Caller owns transaction. A row lock serializes even two first marks;
 * revision + plan fingerprint reject stale tabs and changed timetables. */
export async function writeAttendance(db: DB, yearId: number, therapistId: number, author: string,
    body: { date: string; key: string; status: Mark; expected: Mark; revision: number; planToken: string }) {
    const context = await attendanceContext(db, yearId, therapistId);
    const closed = closedReason(body.date, context);
    if (closed) throw new AttendanceError(400, closed);
    if (body.date > context.today) throw new AttendanceError(400, 'Присуство не се означува однапред.');
    const draft = dayView(body.date, context);
    // A SELECT on an absent row cannot lock it. The unique insert waits for
    // another first writer, then the locked read sees that writer's revision.
    await db.query(`INSERT INTO cabinet_attendance_days(school_year_id,therapist_id,day,plan)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
        [yearId, therapistId, body.date, JSON.stringify(draft.sessions.map(({ status, ...s }) => s))]);
    const saved = (await db.query(`SELECT * FROM cabinet_attendance_days
        WHERE school_year_id=$1 AND therapist_id=$2 AND day=$3 FOR UPDATE`, [yearId, therapistId, body.date])).rows[0];
    const view = dayView(body.date, context, saved);
    if (view.revision !== body.revision || view.planToken !== body.planToken)
        throw new AttendanceError(409, 'Листата е изменета во друг прозорец или распоредот е сменет. Освежете и проверете повторно.');
    if (view.conflict) throw new AttendanceError(409, 'Има преклопени термини. Прво исправете го распоредот.');
    const session = view.sessions.find(s => s.key === body.key);
    if (!session) throw new AttendanceError(403, 'Третманот не е во вашиот распоред за тој ден.');
    if (session.status !== body.expected) throw new AttendanceError(409, 'Присуството е изменето. Освежете ја листата.');
    await db.query(`INSERT INTO cabinet_attendance_pupils(school_year_id,therapist_id,day,student_id)
        SELECT $1,$2,$3,unnest($4::int[]) ON CONFLICT DO NOTHING`,
        [yearId, therapistId, body.date, [...new Set(view.sessions.map(s => s.studentId))]]);
    const marks = { ...saved.marks };
    if (body.status === null) delete marks[body.key]; else marks[body.key] = body.status;
    await db.query(`UPDATE cabinet_attendance_days SET marks=$4::jsonb,revision=revision+1,updated_at=now()
        WHERE school_year_id=$1 AND therapist_id=$2 AND day=$3`, [yearId, therapistId, body.date, JSON.stringify(marks)]);
    await db.query(`INSERT INTO cabinet_attendance_changes(school_year_id,therapist_id,day,session_key,previous_status,status,marked_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [yearId, therapistId, body.date, body.key, session.status, body.status, author]);
    return { ok: true, revision: saved.revision + 1 };
}
