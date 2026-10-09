import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db.js';
import { todayInSkopje, isIsoDate } from './duty.js';
import { projectPayload, weekHasTerms, weekIsRecorded } from './import-core.js';
import { blockTimes, writeBlockInTransaction } from '../routes/schedule-write.js';
import { scheduleGate, lockScheduleTherapist, lockScheduleStudents } from './schedule-conflicts.js';

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const MK = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
type Week = Record<string, Array<Array<number | string>>>;
type Blocks = Record<string, string[][]>;
const weekSchema = z.object(Object.fromEntries(DAYS.map(d => [d,
    z.array(z.array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])).max(2)).min(1).max(12)
]))) as unknown as z.ZodType<Week>;
const blocksSchema = z.object(Object.fromEntries(DAYS.map(d => [d,
    z.array(z.array(z.string().min(1)).max(2)).min(1).max(12)
]))) as unknown as z.ZodType<Blocks>;
export const OngoingPlan = z.object({
    id: z.string().uuid(), baseVersion: z.number().int().nonnegative(),
    therapistId: z.number().int().positive(), fromWeek: z.string(),
    week: weekSchema, times: z.array(z.string()).min(1).max(12), expected: blocksSchema
});
export type PlanInput = z.infer<typeof OngoingPlan>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function monday(date: string): string {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}
function shift(date: string, days: number): string {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
export class PlanRefusal extends Error {
    constructor(public status: number, public body: any) { super(body.error); }
}
const refuse = (error: string, extra = {}): never => { throw new PlanRefusal(409, { error, ...extra }); };

/** Same history semantics as the diary: preserve before the start, never touch attendance. */
export function ongoingDiary(doc: any, from: string, week: Week, current: string, firstWeek: string, clearLater = true): any {
    const next = clone(doc);
    const history = next.scheduleHistory ||= {};
    const plans = next.planFrom ||= {};
    if (from <= current) {
        const previous = shift(from, -7);
        if (previous >= firstWeek && !weekIsRecorded(history[previous])) {
            const later = Object.keys(history).filter(k => k > previous && k <= current && weekIsRecorded(history[k])).sort()[0];
            const before = later ? history[later] : next.schedule;
            if (before) history[previous] = { ...clone(before), ...(!weekHasTerms(before) ? { _saved: true } : {}) };
        }
        for (let k = from; k <= current; k = shift(k, 7)) history[k] = clone(week);
        next.schedule = clone(week);
    } else plans[from] = clone(week);
    Object.keys(plans).forEach(k => {
        if ((clearLater && k > from) || (from <= current && k <= from)) delete plans[k];
    });
    return next;
}

async function lockedDiary(c: PoolClient) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('app_state:sdnevnik'))");
    const row = (await c.query("SELECT * FROM app_state WHERE app='sdnevnik' FOR UPDATE")).rows[0];
    if (!row) refuse('Прво зачувајте го дневникот на серверот.');
    return row;
}
async function year(c: PoolClient) {
    const y = (await c.query('SELECT * FROM school_years WHERE is_current FOR SHARE')).rows[0];
    if (!y) refuse('Нема тековна учебна година.');
    return y;
}
async function publicWeek(c: PoolClient, week: Week, doc: any): Promise<Blocks> {
    const out: Blocks = {};
    for (const day of DAYS) {
        out[day] = [];
        for (const slot of week[day]) {
            const pids = [];
            for (const id of slot) {
                const pupil = (doc.students || []).find((s: any) => String(s.id) === String(id));
                if (!pupil) refuse('Во постојаниот распоред може само ученик од „Мои ученици“.');
                const rows = (await c.query(
                    'SELECT public_id FROM students WHERE sdnevnik_id=$1 OR public_id=$2',
                    [String(id), pupil.rasporediStudentId || null])).rows;
                if (rows.length !== 1) refuse('Ученикот нема единствена врска со базата. Прво усогласете го списокот.');
                pids.push(String(rows[0].public_id));
            }
            if (new Set(pids).size !== pids.length) refuse('Истиот ученик е двапати во еден термин.');
            out[day].push(pids);
        }
    }
    return out;
}

async function blocks(c: PoolClient, y: any, therapistId: number, times: string[], wanted: Blocks, expected: Blocks) {
    await scheduleGate(c);
    // Lock all days first, then pupils, in a stable order across whole-week requests.
    for (const day of MK) await lockScheduleTherapist(c, y.id, day, therapistId);
    for (let d = 0; d < DAYS.length; d++) await lockScheduleStudents(c, y.id, MK[d], wanted[DAYS[d]].flat());
    for (let d = 0; d < DAYS.length; d++) for (let t = 0; t < times.length; t++) {
        const result = await writeBlockInTransaction(c, {
            year: y.label, therapistId, day: MK[d], time: times[t],
            studentPublicIds: wanted[DAYS[d]][t], expectedStudentPublicIds: expected[DAYS[d]][t]
        });
        if (result.status !== 200) throw new PlanRefusal(result.status, { ...result.body, day: MK[d], time: times[t] });
    }
}
async function saveDiary(c: PoolClient, payload: any) {
    const projection = await projectPayload(c, payload, { rosterOwned: true });
    if (projection.report.problems.length) refuse('Дневникот не може целосно да се запише во табелите.', { problems: projection.report.problems });
    return (await c.query(
        `UPDATE app_state SET payload=$1, version=version+1, updated_at=now() WHERE app='sdnevnik'
         RETURNING app, version, payload, updated_at, updated_by`, [JSON.stringify(payload)])).rows[0];
}

export async function confirmOngoing(input: PlanInput) {
    if (!weekHasTerms(input.week)) refuse('Копираната недела нема термини. Не е заменет постојаниот распоред.');
    if (!isIsoDate(input.fromWeek) || monday(input.fromWeek) !== input.fromWeek) refuse('Изберете понеделник како почеток.');
    const spans = input.times.map(blockTimes);
    if (spans.some(s => !s) || new Set(input.times).size !== input.times.length ||
        DAYS.some(d => input.week[d].length !== input.times.length || input.expected[d].length !== input.times.length)) refuse('Неделата има невалидни термини.');
    // The diary positions are chronological, non-overlapping 40-minute bells.
    for (let i = 1; i < input.times.length; i++) if (input.times[i].slice(0,5) < input.times[i-1].slice(6)) refuse('Термините се преклопуваат или не се по ред.');
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const row = await lockedDiary(c);
        const previous = (await c.query('SELECT status,from_week FROM diary_cabinet_changes WHERE id=$1', [input.id])).rows[0];
        if (previous) { await c.query('COMMIT'); return { ...row, replay: true, scheduled: previous.status==='scheduled', fromWeek: previous.from_week }; }
        if (row.version !== input.baseVersion) refuse('Дневникот се смени во меѓувреме. Прво синхронизирајте, па потврдете повторно.', { diaryConflict: true });
        const y = await year(c);
        if (input.fromWeek < monday(y.starts_on) || input.fromWeek > monday(y.ends_on)) refuse('Постојаниот план мора да почне во тековната учебна година.');
        const current = monday(todayInSkopje());
        const wanted = await publicWeek(c, input.week, row.payload);
        await c.query('SAVEPOINT validate_week');
        await blocks(c, y, input.therapistId, input.times, wanted, input.expected);
        if (input.fromWeek > current) await c.query('ROLLBACK TO SAVEPOINT validate_week');
        await c.query('RELEASE SAVEPOINT validate_week');
        // An earlier accepted future plan will be the baseline at activation.
        const earlier = (await c.query(
            `SELECT week, times, therapist_id FROM diary_cabinet_changes WHERE school_year_id=$1
             AND status='scheduled' AND from_week<$2 ORDER BY from_week DESC LIMIT 1`, [y.id,input.fromWeek])).rows[0];
        if (earlier && (earlier.therapist_id !== input.therapistId || JSON.stringify(earlier.times) !== JSON.stringify(input.times))) refuse('Веќе има подготвен план за друг кабинет или други термини.');
        const expected = earlier ? await publicWeek(c, earlier.week, row.payload) : input.expected;
        await c.query("UPDATE diary_cabinet_changes SET status='superseded' WHERE status IN ('scheduled','blocked') AND from_week >= $1", [input.fromWeek]);
        const payload = ongoingDiary(row.payload, input.fromWeek, input.week, current, monday(y.starts_on));
        // Only the server activates a confirmed shared plan. Diary-only pasted
        // weeks keep their offline promotion; confirmed weeks remain previews.
        if (input.fromWeek > current) payload.planFrom[input.fromWeek]._serverConfirmed = input.id;
        const saved = await saveDiary(c, payload);
        const scheduled = input.fromWeek > current;
        await c.query(
            `INSERT INTO diary_cabinet_changes(id,school_year_id,therapist_id,from_week,week,times,expected_blocks,before_diary,status,applied_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='applied' THEN now() ELSE NULL END)`,
            [input.id,y.id,input.therapistId,input.fromWeek,JSON.stringify(input.week),JSON.stringify(input.times),
                JSON.stringify(expected),JSON.stringify(row.payload),scheduled?'scheduled':'applied']);
        await c.query('COMMIT');
        return { ...saved, scheduled, fromWeek: input.fromWeek };
    } catch (err) { await c.query('ROLLBACK'); throw err; }
    finally { c.release(); }
}

/** Called on server start and on schedule/portal reads, even with no diary open. */
export async function activateOngoing(today = todayInSkopje()) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const waiting = (await c.query("SELECT 1 FROM diary_cabinet_changes WHERE status IN ('scheduled','blocked') LIMIT 1")).rows.length;
        if (!waiting) { await c.query('COMMIT'); return; }
        let row = await lockedDiary(c);
        // Upgrade pending plans saved before the marker existed, including
        // already blocked ones. Never change their pupils or promote a plan.
        const held = (await c.query("SELECT id,from_week FROM diary_cabinet_changes WHERE status IN ('scheduled','blocked') ORDER BY created_at")).rows;
        let marked = false;
        for (const plan of held) {
            const week = row.payload.planFrom?.[plan.from_week];
            if (week && week._serverConfirmed !== plan.id) { week._serverConfirmed = plan.id; marked = true; }
        }
        if (marked) row = (await c.query(
            "UPDATE app_state SET payload=$1,version=version+1,updated_at=now() WHERE app='sdnevnik' RETURNING *",
            [JSON.stringify(row.payload)])).rows[0];
        const y = await year(c);
        const pending = (await c.query("SELECT * FROM diary_cabinet_changes WHERE status='scheduled' AND from_week <= $1 ORDER BY from_week,created_at FOR UPDATE", [monday(today)])).rows;
        for (const plan of pending) {
            await c.query('SAVEPOINT activate_week');
            try {
                if (plan.school_year_id !== y.id) refuse('Учебната година е сменета.');
                const savedPlan = row.payload.planFrom?.[plan.from_week];
                // A newly added empty sixth slot and the ownership marker are
                // not timetable edits. Compare pupils, preserving their order.
                const comparable = (week: any) => DAYS.map(d => {
                    const slots = (week?.[d] || []).map((slot: any[]) => slot.map(String));
                    while (slots.length && !slots[slots.length - 1].length) slots.pop();
                    return slots;
                });
                if (!savedPlan || JSON.stringify(comparable(savedPlan)) !== JSON.stringify(comparable(plan.week)))
                    refuse('Подготвената недела во дневникот е сменета. Потврдете го новиот план.');
                const wanted = await publicWeek(c, plan.week, row.payload);
                await blocks(c, y, plan.therapist_id, plan.times, wanted, plan.expected_blocks);
                const payload = ongoingDiary(row.payload, plan.from_week, plan.week, monday(today), monday(y.starts_on), false);
                // A one-week local paste may carry a copy of this plan as the
                // following week's restoration. Its guard belongs to this same
                // confirmation, and must not survive successful activation.
                for (const restored of Object.values(payload.planFrom || {}) as any[]) {
                    if (restored?._serverConfirmed === plan.id) delete restored._serverConfirmed;
                }
                row = await saveDiary(c, payload);
                await c.query("UPDATE diary_cabinet_changes SET status='applied', applied_at=now(), problem=NULL WHERE id=$1", [plan.id]);
            } catch (err) {
                await c.query('ROLLBACK TO SAVEPOINT activate_week');
                if (!(err instanceof PlanRefusal)) throw err;
                await c.query("UPDATE diary_cabinet_changes SET status='blocked', problem=$2 WHERE id=$1", [plan.id,JSON.stringify(err.body)]);
            }
            await c.query('RELEASE SAVEPOINT activate_week');
        }
        await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; }
    finally { c.release(); }
}
