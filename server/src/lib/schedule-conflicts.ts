import { minutesOf, slotBell, type Bell } from './crossing.js';

type Db = { query: (sql: string, values?: any[]) => Promise<any> };
export const SCHEDULE_DAYS: Record<string, number> = { 'понеделник': 1, pon: 1, 'вторник': 2, vto: 2, 'среда': 3, sre: 3, 'четврток': 4, cet: 4, 'петок': 5, pet: 5, 'сабота': 6, 'недела': 7 };
export const scheduleDay = (day: string) => SCHEDULE_DAYS[String(day).trim().toLowerCase()] || 0;

/** Whole-document replacement excludes every cell writer until its decision commits. */
export async function scheduleGate(db: Db, replace = false) {
    await db.query(`SELECT pg_advisory_xact_lock${replace ? '' : '_shared'}(hashtext('cabinet-schedule-document'))`);
}
export async function lockScheduleTherapist(db: Db, year: number, day: string, therapist: number) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('fusion-therapist:' || $1::text || ':' || $2::text || ':' || $3::text))", [year, scheduleDay(day), therapist]);
}
export async function lockScheduleStudents(db: Db, year: number, day: string, students: string[]) {
    for (const id of [...new Set(students)].sort()) await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('fusion-student:' || $1::text || ':' || $2::text || ':' || $3))", [year, scheduleDay(day), id]);
}
export async function cabinetBells(db: Db, year: number): Promise<Bell[]> {
    const { rows } = await db.query(`SELECT to_char(coalesce(o.starts_at,b.starts_at),'HH24:MI') AS "startsAt",
        coalesce(o.minutes,b.minutes) AS minutes FROM bell_periods b LEFT JOIN bell_period_overrides o
        ON o.bell_period_id=b.id AND o.school_year_id=$1 WHERE b.schedule='kabinet'`, [year]);
    return rows;
}
/** A bare legacy clock is meaningful only when the year's configured bell supplies its end. */
export function scheduleSpan(time: string, bells: Bell[] = []): { start: number; end: number } | null {
    const span = slotBell(time);
    if (span) { const start = minutesOf(span.startsAt); return { start, end: start + span.minutes }; }
    const start = minutesOf(time);
    const matches = bells.filter(b => minutesOf(b.startsAt) === start && b.minutes > 0);
    if (!Number.isFinite(start) || !matches.length || new Set(matches.map(b => b.minutes)).size !== 1) return null;
    return { start, end: start + Number(matches[0].minutes) };
}
export function scheduleOverlap(a: string, b: string, bells: Bell[] = []): boolean {
    const x = scheduleSpan(a, bells), y = scheduleSpan(b, bells);
    return Boolean(x && y && x.start < y.end && y.start < x.end);
}

export class ScheduleImportRefusal extends Error {
    constructor(public conflicts: string[]) {
        super('Увозот е одбиен целосно. Ништо не е запишано.\n' + conflicts.slice(0, 20).join('\n') +
            (conflicts.length > 20 ? `\n… уште ${conflicts.length - 20} проблеми.` : ''));
    }
}
export type ScheduleTerm = { day: string; time: string; therapist: string; student: string; studentName: string };
export function scheduleProblems(terms: ScheduleTerm[], bells: Bell[]): string[] {
    const problems: string[] = [];
    for (let i = 0; i < terms.length; i++) {
        const a = terms[i];
        if (!scheduleDay(a.day) || !scheduleSpan(a.time, bells)) {
            problems.push(`Непроверлив термин: ${a.day} ${a.time} · ${a.therapist}. Наведи ден и време од–до.`);
            continue;
        }
        for (const b of terms.slice(i + 1)) {
            if (scheduleDay(a.day) !== scheduleDay(b.day) || !scheduleOverlap(a.time, b.time, bells)) continue;
            if (a.therapist === b.therapist) {
                if (a.time === b.time && a.student === b.student) continue;
                problems.push(`Преклопени записи во кабинет: ${a.day} · ${a.therapist} · ${a.time} / ${b.time}.`);
            } else if (a.student === b.student) {
                problems.push(`Ученикот ${a.studentName} е закажан двапати: ${a.day} · ${a.therapist} ${a.time} / ${b.therapist} ${b.time}.`);
            }
        }
    }
    return [...new Set(problems)];
}

/** Same overlap query for the block, stable-id session and legacy name route. Caller holds locks. */
export async function scheduleOverlaps(db: Db, year: number, day: string, therapist: number,
    time: string, student: string | null, exclude: string[]) {
    const bells = await cabinetBells(db, year);
    if (!scheduleSpan(time, bells)) return { invalid: true, rows: [] as any[] };
    const { rows } = await db.query(`SELECT sl.time_slot, sl.therapist_id, t.name AS therapist_name,
        s.public_id AS student_public_id, s.name AS student_name
        FROM schedule_slots sl JOIN therapists t ON t.id=sl.therapist_id LEFT JOIN students s ON s.id=sl.student_id
        WHERE sl.school_year_id=$1 AND sl.day_order=$2 AND (sl.therapist_id=$3 OR s.public_id=$4)
        AND NOT (sl.therapist_id=$3 AND sl.day=$5 AND sl.time_slot=ANY($6::text[]))`,
        [year, scheduleDay(day), therapist, student, day, exclude]);
    // An unplaceable existing row must not become a free interval by accident.
    if (rows.some((r: any) => !scheduleSpan(r.time_slot, bells))) return { invalid: true, rows: [] as any[] };
    return { invalid: false, rows: rows.filter((r: any) => scheduleOverlap(time, r.time_slot, bells)) };
}

export function overlapRefusal(overlaps: { invalid: boolean; rows: any[] }, therapist: number) {
    if (overlaps.invalid) return { error: 'Времетраењето на термин не може да се провери. Наведи време од–до.', invalidTime: true };
    const own = overlaps.rows.find(r => Number(r.therapist_id) === therapist);
    if (own) return { error: 'Кабинетот веќе има сесија што се преклопува.', therapistOccupied: true,
        time: own.time_slot, studentPublicId: own.student_public_id, studentName: own.student_name };
    const other = overlaps.rows[0];
    return other ? { error: 'Ученикот веќе е закажан во друг кабинет.', doubleBooked: true,
        therapistId: other.therapist_id, therapistName: other.therapist_name, time: other.time_slot,
        studentPublicId: other.student_public_id, studentName: other.student_name } : null;
}
