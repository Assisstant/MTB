/**
 * The review queue for answers to the offline forms (docs/PLAN-formulari.md).
 *
 * An answer is stored first and checked against the database every time it is
 * opened; nothing in it is written until the administrator accepts it, item by
 * item. This file only READS and DECIDES. Accepted items are written by the
 * routes that already own each fact (the caller injects those requests), so
 * the queue cannot become a second way into the schedule tables.
 *
 * The answer's meaning — which blocks changed, which typed names are which
 * pupil — is decided by `plan()` in `mtb-schedule-form.js`, the SAME function
 * Кабинети used when it wrote answers directly. It is loaded here the way its
 * test loads it, so the file on a colleague's desk and the queue cannot read an
 * answer two ways.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { PoolClient } from 'pg';
import { minutesOf, slotBell, timeOf } from './crossing.js';

type Queryable = Pick<PoolClient, 'query'>;

export const DAYS = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];

// ── the one planner ─────────────────────────────────────────────────────────

type Planned = {
    errors: string[]; therapist: { id: number; name: string } | null; note: string;
    newPupils: Array<{ id: string; name: string; match: 'existing' | 'ambiguous' | 'create'; publicId?: string; label?: string }>;
    changes: Array<{ key: string; day: string; time: string; from: string[]; to: Array<string | { create: string }> }>;
    conflicts: Array<{ key: string; day: string; time: string; from: string[]; to: Array<string | { create: string }>; baseline: string[] }>;
    skipped: Array<{ key: string; day: string; time: string; reason: string }>;
    unchanged: number; caseloadAdds: string[];
};
type Planner = { REPLY: string; VERSION: number; plan: (reply: unknown, ctx: unknown) => Planned };

let planner: Planner | null = null;

function repoFile(name: string): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const up of ['../../..', '../../../..']) {
        const candidate = path.resolve(here, up, name);
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(`${name} is not where the server expects the repository root`);
}

export function formPlanner(): Planner {
    if (planner) return planner;
    const sandbox: { window: { MTBScheduleForm?: Planner } } = { window: {} };
    vm.runInNewContext(readFileSync(repoFile('mtb-schedule-form.js'), 'utf8'), sandbox);
    const form = sandbox.window.MTBScheduleForm as Planner;
    // Results are made in another realm; hand them on as plain data.
    planner = { REPLY: form.REPLY, VERSION: form.VERSION, plan: (r, c) => JSON.parse(JSON.stringify(form.plan(r, c))) };
    return planner;
}

// ── who an answer is about ──────────────────────────────────────────────────

/** Same person on every machine: kind + name, normalised as a pupil key is. */
export const personKey = (kind: string, name: unknown) =>
    kind + ':' + String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');

export type Described =
    | { ok: true; kind: 'cabinet'; year: string; aboutKey: string; aboutName: string; madeAt: string | null; filledAt: string | null }
    | { ok: false; error: string };

const isoOrNull = (value: unknown) => {
    const d = new Date(String(value || ''));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

export function describeReply(reply: any): Described {
    const { REPLY } = formPlanner();
    if (!reply || typeof reply !== 'object') return { ok: false, error: 'не е JSON одговор од формулар' };
    if (reply.kind === REPLY) {
        const name = String(reply.therapist?.name || '').trim();
        if (!name) return { ok: false, error: 'одговорот не кажува за кој терапевт е' };
        if (!reply.year) return { ok: false, error: 'одговорот не кажува за која учебна година е' };
        return {
            ok: true, kind: 'cabinet', year: String(reply.year),
            aboutKey: personKey('therapist', name), aboutName: name,
            madeAt: isoOrNull(reply.formGeneratedAt), filledAt: isoOrNull(reply.savedAt)
        };
    }
    return { ok: false, error: 'непознат вид формулар' };
}

/** The same file read twice is one answer; key order does not make it new. */
export function fingerprintOf(reply: unknown): string {
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
    return createHash('sha256').update(JSON.stringify(stable(reply))).digest('hex');
}

/**
 * Newest wins: among the answers about one person in one year, only the one
 * filled in last stays pending; the others point at it. Called after every
 * store, so the order the files arrive in does not matter.
 */
export async function settleNewest(db: Queryable, yearId: number, kind: string, aboutKey: string): Promise<void> {
    const rows = (await db.query(
        `SELECT id, status FROM form_replies
          WHERE school_year_id = $1 AND kind = $2 AND about_key = $3
          ORDER BY filled_at DESC NULLS LAST, received_at DESC, id DESC`,
        [yearId, kind, aboutKey])).rows;
    if (!rows.length) return;
    const newest = rows[0];
    for (const row of rows.slice(1)) {
        if (row.status === 'pending') {
            await db.query(`UPDATE form_replies SET status = 'superseded', superseded_by = $2 WHERE id = $1`, [row.id, newest.id]);
        }
    }
    if (newest.status === 'superseded') {
        await db.query(`UPDATE form_replies SET status = 'pending', superseded_by = NULL WHERE id = $1`, [newest.id]);
    }
}

// ── the week as the database holds it ───────────────────────────────────────

function halvesOf(full: string): [string, string] | null {
    const span = slotBell(full);
    if (!span || span.minutes !== 40) return null;
    const start = minutesOf(span.startsAt);
    return [`${timeOf(start)}-${timeOf(start + 20)}`, `${timeOf(start + 20)}-${timeOf(start + 40)}`];
}

/** Same reading as schedule-write's `semanticBlock`: null when full and half rows contradict. */
function blockIds(rows: Array<{ time_slot: string; public_id: string }>, full: string, halves: [string, string]): string[] | null {
    const f = rows.find((r) => r.time_slot === full)?.public_id;
    const h = halves.map((t) => rows.find((r) => r.time_slot === t)?.public_id).filter(Boolean) as string[];
    if (f && h.length) return null;
    if (f) return [String(f)];
    if (h.length === 2 && h[0] === h[1]) return [String(h[0])];
    return h.map(String);
}

type Session = { day: string; time_slot: string; therapist_id: number; therapist_name: string; public_id: string };

export type CabinetContext = {
    year: string;
    therapists: Array<{ id: number; name: string; students: string[] }>;
    students: Array<{ public_id: string; name: string; grade: string | null }>;
    current: Record<string, string[]>;
    validKeys: string[];
    locked: string[];
    sessions: Session[];
};

export async function cabinetContext(db: Queryable, year: { id: number; label: string; is_current: boolean }, therapistId: number): Promise<CabinetContext> {
    const therapists = (await db.query(
        `SELECT t.id, t.name,
                coalesce(array_agg(s.public_id ORDER BY s.public_id) FILTER (WHERE s.public_id IS NOT NULL), '{}') AS students
           FROM therapists t
           JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = $1 AND ty.active
           LEFT JOIN therapist_students ts ON ts.therapist_id = t.id AND ts.school_year_id = $1
           LEFT JOIN students s ON s.id = ts.student_id
          GROUP BY t.id ORDER BY t.name`, [year.id])).rows;
    const students = (await db.query(
        `SELECT s.public_id, s.name, e.grade FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND (s.active OR NOT $2::boolean) ORDER BY s.name`,
        [year.id, year.is_current])).rows;
    const bells = (await db.query(
        `SELECT to_char(coalesce(o.starts_at, b.starts_at), 'HH24:MI') AS starts_at, coalesce(o.minutes, b.minutes) AS minutes
           FROM bell_periods b
           LEFT JOIN bell_period_overrides o ON o.bell_period_id = b.id AND o.school_year_id = $1
          WHERE b.schedule = 'kabinet' ORDER BY b.ordinal`, [year.id])).rows
        .filter((b: any) => Number(b.minutes) === 40);
    const sessions: Session[] = (await db.query(
        `SELECT sl.day, sl.time_slot, sl.therapist_id, t.name AS therapist_name, s.public_id
           FROM schedule_slots sl JOIN students s ON s.id = sl.student_id JOIN therapists t ON t.id = sl.therapist_id
          WHERE sl.school_year_id = $1`, [year.id])).rows;

    const own = sessions.filter((s) => s.therapist_id === therapistId);
    const current: Record<string, string[]> = {};
    const validKeys: string[] = [];
    const locked: string[] = [];
    for (const day of DAYS) {
        for (const bell of bells) {
            const start = minutesOf(bell.starts_at);
            if (!Number.isFinite(start)) continue;
            const full = `${bell.starts_at}-${timeOf(start + 40)}`;
            const halves = halvesOf(full);
            if (!halves) continue;
            const key = `${day}|${full}`;
            validKeys.push(key);
            const ids = blockIds(own.filter((s) => s.day === day), full, halves);
            if (ids == null) locked.push(key);
            else if (ids.length) current[key] = ids;
        }
    }
    return { year: year.label, therapists, students, current, validKeys, locked, sessions };
}

// ── the items the administrator decides ─────────────────────────────────────

export type ItemState = 'clean' | 'changed' | 'conflict' | 'refused';
export type Item = {
    key: string;
    type: 'block' | 'pupil' | 'caseload';
    state: ItemState;
    day?: string; time?: string;
    from?: string[];
    to?: Array<string | { create: string }>;
    name?: string; publicId?: string;
    reasons: string[];
    decision?: { decision: string; outcome: string | null; decided_by: string; decided_at: string } | null;
};

const overlaps = (a: string, b: string) => {
    const x = slotBell(a); const y = slotBell(b);
    if (!x || !y) return false;
    const xs = minutesOf(x.startsAt); const ys = minutesOf(y.startsAt);
    return xs < ys + y.minutes && ys < xs + x.minutes;
};

/**
 * Turn one stored cabinet answer into items, each checked against `ctx` —
 * the database as it is NOW. A child placed in a term where another therapist
 * already has them is a conflict: the owner's example, and until now only
 * counted by Кабинети, never stopped.
 */
export function cabinetItems(reply: any, ctx: CabinetContext): { errors: string[]; therapist: { id: number; name: string } | null; note: string; unchanged: number; items: Item[] } {
    // The numeric id differs between machines; the name is the person. Resolve
    // it here to this database's id before the planner compares anything.
    const wanted = personKey('therapist', reply?.therapist?.name);
    const local = ctx.therapists.filter((t) => personKey('therapist', t.name) === wanted);
    const resolved = local.length === 1
        ? { ...reply, therapist: { ...reply.therapist, id: local[0].id, name: local[0].name } }
        : reply;
    const planned = formPlanner().plan(resolved, ctx);
    const names = new Map(ctx.students.map((s) => [s.public_id, s.name]));
    const items: Item[] = [];
    if (planned.errors.length || !planned.therapist) {
        return { errors: planned.errors.length ? planned.errors : ['терапевтот не е препознаен'], therapist: null, note: '', unchanged: 0, items };
    }
    const therapistId = planned.therapist.id;
    const elsewhere = (day: string, time: string, ids: Array<string | { create: string }>) => {
        const out: string[] = [];
        for (const id of ids) {
            if (typeof id !== 'string') continue;
            for (const s of ctx.sessions) {
                if (s.public_id === id && s.day === day && s.therapist_id !== therapistId && overlaps(s.time_slot, time)) {
                    out.push(`${names.get(id) || id} е веќе кај ${s.therapist_name} (${s.time_slot})`);
                }
            }
        }
        return out;
    };

    for (const p of planned.newPupils) {
        if (p.match === 'create') {
            items.push({ key: `pupil:${personKey('new', p.name)}`, type: 'pupil', state: 'clean', name: p.name, reasons: ['нов ученик под набљудување'] });
        } else if (p.match === 'ambiguous') {
            items.push({ key: `pupil:${personKey('new', p.name)}`, type: 'pupil', state: 'refused', name: p.name, reasons: ['повеќе деца го носат ова име — се поврзува рачно'] });
        }
    }
    const placed = new Set<string>();
    for (const c of planned.changes) {
        const reasons = elsewhere(c.day, c.time, c.to);
        c.to.forEach((id) => { if (typeof id === 'string') placed.add(id); });
        items.push({ key: `block:${c.key}`, type: 'block', state: reasons.length ? 'conflict' : 'clean', day: c.day, time: c.time, from: c.from, to: c.to, reasons });
    }
    for (const c of planned.conflicts) {
        const reasons = ['сменето во базата откако е направен формуларот (формуларот: ' +
            (c.baseline.map((id) => names.get(id) || id).join(' + ') || 'празно') + ')'].concat(elsewhere(c.day, c.time, c.to));
        items.push({ key: `block:${c.key}`, type: 'block', state: 'changed', day: c.day, time: c.time, from: c.from, to: c.to, reasons });
    }
    for (const s of planned.skipped) {
        items.push({ key: `block:${s.key}`, type: 'block', state: 'refused', day: s.day, time: s.time, reasons: [s.reason] });
    }
    // A pupil placed in a block joins the list with that block; only the
    // ones named without a term are separate items.
    for (const id of planned.caseloadAdds) {
        if (placed.has(id)) continue;
        items.push({ key: `caseload:${id}`, type: 'caseload', state: 'clean', publicId: id, name: names.get(id) || id, reasons: ['на списокот на терапевтот'] });
    }
    return { errors: [], therapist: planned.therapist, note: planned.note, unchanged: planned.unchanged, items };
}
