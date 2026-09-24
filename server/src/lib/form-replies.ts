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
 * Кабинети used when it wrote answers directly; a class answer by `plan()` in
 * `mtb-class-form.js`. They are loaded here the way their tests load them, so
 * the file on a colleague's desk and the queue cannot read an answer two ways.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
    unchanged: number; caseloadAdds: string[]; caseloadRemovals?: string[];
};
type Planner = { REPLY: string; VERSION: number; plan: (reply: unknown, ctx: unknown) => Planned };

type Cell = { subject: string | null; teacher?: string | null; class?: string } | null;
type ClassChange = { key: string; day: string; ordinal: number; from: Cell; to: Cell; reasons: string[] };
type ClassPlanned = {
    errors: string[]; class: string | null; homeroom: string | null; note: string; unchanged: number;
    changes: ClassChange[];
    conflicts: Array<ClassChange & { baseline: Cell }>;
    skipped: Array<{ key: string; day: string; ordinal: number; reason: string }>;
    reports: Array<{ name: string; generation: string | null; text: string }>;
};
type ClassPlanner = { REPLY: string; VERSION: number; plan: (reply: unknown, ctx: unknown) => ClassPlanned };

type Slot = { class: string; subject: string | null } | null;
type TeacherChange = { key: string; day: string; ordinal: number; from: Slot; to: Slot; reasons: string[]; together: string | null };
type TeacherPlanned = {
    errors: string[]; teacher: string | null; note: string; unchanged: number;
    changes: TeacherChange[];
    conflicts: Array<TeacherChange & { baseline: Slot }>;
    skipped: Array<{ key: string; day: string; ordinal: number; reason: string }>;
};
type TeacherPlanner = { REPLY: string; VERSION: number; plan: (reply: unknown, ctx: unknown) => TeacherPlanned };

let planner: Planner | null = null;
let classPlanner: ClassPlanner | null = null;
let teacherPlanner: TeacherPlanner | null = null;

function repoFile(name: string): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const up of ['../../..', '../../../..']) {
        const candidate = path.resolve(here, up, name);
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(`${name} is not where the server expects the repository root`);
}

function loadForms() {
    const sandbox: { window: { MTBScheduleForm?: Planner; MTBClassForm?: ClassPlanner; MTBTeacherForm?: TeacherPlanner } } = { window: {} };
    const context = vm.createContext(sandbox);
    vm.runInContext(readFileSync(repoFile('mtb-schedule-form.js'), 'utf8'), context);
    vm.runInContext(readFileSync(repoFile('mtb-class-form.js'), 'utf8'), context);
    const form = sandbox.window.MTBScheduleForm as Planner;
    const cls = sandbox.window.MTBClassForm as ClassPlanner;
    // Results are made in another realm; hand them on as plain data.
    planner = { REPLY: form.REPLY, VERSION: form.VERSION, plan: (r, c) => JSON.parse(JSON.stringify(form.plan(r, c))) };
    classPlanner = { REPLY: cls.REPLY, VERSION: cls.VERSION, plan: (r, c) => JSON.parse(JSON.stringify(cls.plan(r, c))) };
    const own = sandbox.window.MTBTeacherForm as TeacherPlanner;
    teacherPlanner = { REPLY: own.REPLY, VERSION: own.VERSION, plan: (r, c) => JSON.parse(JSON.stringify(own.plan(r, c))) };
}

export function teacherFormPlanner(): TeacherPlanner {
    if (!teacherPlanner) loadForms();
    return teacherPlanner!;
}

export function formPlanner(): Planner {
    if (!planner) loadForms();
    return planner!;
}

export function classFormPlanner(): ClassPlanner {
    if (!classPlanner) loadForms();
    return classPlanner!;
}

// ── who an answer is about ──────────────────────────────────────────────────

/** Same person on every machine: kind + name, normalised as a pupil key is. */
export const personKey = (kind: string, name: unknown) =>
    kind + ':' + String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');

export type Described =
    | { ok: true; kind: 'cabinet' | 'class' | 'teacher'; year: string; aboutKey: string; aboutName: string; madeAt: string | null; filledAt: string | null }
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
    if (reply.kind === classFormPlanner().REPLY) {
        // The class is the subject of the answer, by its label: the id is
        // this machine's, the label is the school's.
        const label = String(reply.class?.label || '').replace(/\s+/g, ' ').trim();
        if (!label) return { ok: false, error: 'одговорот не кажува за кое одделение е' };
        if (!reply.year) return { ok: false, error: 'одговорот не кажува за која учебна година е' };
        const homeroom = String(reply.homeroom || '').trim();
        return {
            ok: true, kind: 'class', year: String(reply.year),
            aboutKey: personKey('class', label), aboutName: homeroom ? `${label} · ${homeroom}` : label,
            madeAt: isoOrNull(reply.formGeneratedAt), filledAt: isoOrNull(reply.savedAt)
        };
    }
    if (reply.kind === teacherFormPlanner().REPLY) {
        const name = String(reply.teacher?.name || '').replace(/\s+/g, ' ').trim();
        if (!name) return { ok: false, error: 'одговорот не кажува за кој наставник е' };
        if (!reply.year) return { ok: false, error: 'одговорот не кажува за која учебна година е' };
        return {
            ok: true, kind: 'teacher', year: String(reply.year),
            aboutKey: personKey('teacher', name), aboutName: name,
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

export type ItemState = 'clean' | 'changed' | 'conflict' | 'refused' | 'report';
export type Item = {
    key: string;
    type: 'block' | 'pupil' | 'caseload' | 'uncaseload' | 'lesson' | 'mylesson' | 'report';
    state: ItemState;
    day?: string; time?: string; ordinal?: number;
    from?: string[];
    to?: Array<string | { create: string }>;
    fromCell?: Cell; toCell?: Cell; lessonId?: number | null; together?: string | null;
    name?: string; publicId?: string; generation?: string | null; text?: string;
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
    for (const id of planned.caseloadRemovals || []) {
        items.push({ key: `uncaseload:${id}`, type: 'uncaseload', state: 'clean', publicId: id, name: names.get(id) || id,
                     reasons: ['одштиклиран во формуларот — излегува од списокот на терапевтот (досието останува)'] });
    }
    return { errors: [], therapist: planned.therapist, note: planned.note, unchanged: planned.unchanged, items };
}

// ── a class's week ──────────────────────────────────────────────────────────

export type ClassContext = {
    year: string;
    classes: string[];
    validKeys: string[];
    doubled: string[];
    current: Record<string, Cell>;
    ids: Record<string, number>;
    teachers: string[];
    busy: Record<string, Array<{ teacher: string; class: string }>>;
};

export async function classContext(db: Queryable, year: { id: number; label: string }, label: string): Promise<ClassContext> {
    const classes = (await db.query(
        `SELECT c.label FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active ORDER BY c.sort_key, c.label`, [year.id])).rows.map((r: any) => r.label);
    const ordinals = (await db.query(
        `SELECT ordinal FROM bell_periods WHERE schedule = 'nastava-am' ORDER BY ordinal`)).rows.map((r: any) => Number(r.ordinal));
    const teachers = (await db.query(
        `SELECT t.name FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
          ORDER BY t.name`, [year.id])).rows.map((r: any) => r.name);
    const lessons = (await db.query(
        `SELECT l.id, l.day, l.ordinal, c.label AS class, l.subject, t.name AS teacher
           FROM lessons l JOIN school_classes c ON c.id = l.class_id LEFT JOIN teachers t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1`, [year.id])).rows;
    const validKeys = DAYS.flatMap((day) => ordinals.map((o) => `${day}|${o}`));
    const current: Record<string, Cell> = {};
    const ids: Record<string, number> = {};
    const count = new Map<string, number>();
    const busy: ClassContext['busy'] = {};
    for (const l of lessons) {
        const key = `${l.day}|${l.ordinal}`;
        if (l.teacher) (busy[key] ||= []).push({ teacher: l.teacher, class: l.class });
        if (l.class !== label) continue;
        count.set(key, (count.get(key) || 0) + 1);
        current[key] = { subject: l.subject ?? null, teacher: l.teacher ?? null };
        ids[key] = l.id;
    }
    const doubled = Array.from(count.entries()).filter(([, n]) => n > 1).map(([k]) => k);
    doubled.forEach((k) => { delete current[k]; delete ids[k]; });
    return { year: year.label, classes, validKeys, doubled, current, ids, teachers, busy };
}

/**
 * One stored class answer as items, checked against the database NOW. A
 * teacher already teaching another class in that period is a conflict; a
 * cell changed in Уреди настава since the form was made is „changed"; a
 * pupil report is only a note for the administrator — the owner decided the
 * class form never moves a child.
 */
export function classItems(reply: any, ctx: ClassContext): { errors: string[]; class: string | null; note: string; unchanged: number; items: Item[] } {
    const planned = classFormPlanner().plan(reply, ctx);
    const items: Item[] = [];
    if (planned.errors.length || !planned.class) {
        return { errors: planned.errors.length ? planned.errors : ['одделението не е препознаено'], class: null, note: '', unchanged: 0, items };
    }
    const show = (c: Cell) => c ? (c.subject || '(без предмет)') + (c.teacher ? ` · ${c.teacher}` : '') : 'празно';
    for (const c of planned.changes) {
        items.push({ key: `lesson:${c.key}`, type: 'lesson', state: c.reasons.length ? 'conflict' : 'clean', day: c.day, ordinal: c.ordinal,
                     fromCell: c.from, toCell: c.to, lessonId: ctx.ids[c.key] ?? null, reasons: c.reasons });
    }
    for (const c of planned.conflicts) {
        items.push({ key: `lesson:${c.key}`, type: 'lesson', state: 'changed', day: c.day, ordinal: c.ordinal,
                     fromCell: c.from, toCell: c.to, lessonId: ctx.ids[c.key] ?? null,
                     reasons: [`сменето во базата откако е направен формуларот (формуларот: ${show(c.baseline)})`].concat(c.reasons) });
    }
    for (const s of planned.skipped) {
        items.push({ key: `lesson:${s.key}`, type: 'lesson', state: 'refused', day: s.day, ordinal: s.ordinal, reasons: [s.reason] });
    }
    for (const r of planned.reports) {
        items.push({ key: `report:${personKey('pupil', r.name)}`, type: 'report', state: 'report', name: r.name, generation: r.generation, text: r.text,
                     reasons: ['се поправа рачно во Податоци → Ученици; од тука не се менува ништо'] });
    }
    return { errors: [], class: planned.class, note: planned.note, unchanged: planned.unchanged, items };
}

// ── a teacher's own week ────────────────────────────────────────────────────

export type TeacherContext = {
    year: string;
    teachers: string[];
    classes: string[];
    validKeys: string[];
    current: Record<string, Slot>;
    doubled: string[];
    occupied: Record<string, Array<{ class: string; teacher: string; subject: string | null }>>;
};

export async function teacherContext(db: Queryable, year: { id: number; label: string }, name: string): Promise<TeacherContext> {
    const classes = (await db.query(
        `SELECT c.label FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active ORDER BY c.sort_key, c.label`, [year.id])).rows.map((r: any) => r.label);
    const ordinals = (await db.query(
        `SELECT ordinal FROM bell_periods WHERE schedule = 'nastava-am' ORDER BY ordinal`)).rows.map((r: any) => Number(r.ordinal));
    const teachers = (await db.query(
        `SELECT t.name FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
          ORDER BY t.name`, [year.id])).rows.map((r: any) => r.name);
    const lessons = (await db.query(
        `SELECT l.day, l.ordinal, c.label AS class, l.subject, t.name AS teacher
           FROM lessons l JOIN school_classes c ON c.id = l.class_id JOIN teachers t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1`, [year.id])).rows;
    const low = (v: string) => v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
    const me = low(name);
    const current: Record<string, Slot> = {};
    const count = new Map<string, number>();
    const occupied: TeacherContext['occupied'] = {};
    for (const l of lessons) {
        const key = `${l.day}|${l.ordinal}`;
        (occupied[key] ||= []).push({ class: l.class, teacher: l.teacher, subject: l.subject ?? null });
        if (low(l.teacher) !== me) continue;
        count.set(key, (count.get(key) || 0) + 1);
        current[key] = { class: l.class, subject: l.subject ?? null };
    }
    const doubled = Array.from(count.entries()).filter(([, n]) => n > 1).map(([k]) => k);
    doubled.forEach((k) => { delete current[k]; });
    return { year: year.label, teachers, classes, validKeys: DAYS.flatMap((d) => ordinals.map((o) => `${d}|${o}`)), current, doubled, occupied };
}

/**
 * One teacher's own week as items, checked against every lesson NOW. Another
 * teacher in that class then is co-teaching when the subject is the same (one
 * other, never two) and a conflict otherwise.
 */
export function teacherItems(reply: any, ctx: TeacherContext): { errors: string[]; teacher: string | null; note: string; unchanged: number; items: Item[] } {
    const planned = teacherFormPlanner().plan(reply, ctx);
    const items: Item[] = [];
    if (planned.errors.length || !planned.teacher) {
        return { errors: planned.errors.length ? planned.errors : ['наставникот не е препознаен'], teacher: null, note: '', unchanged: 0, items };
    }
    const show = (c: Slot) => c ? `${c.class} · ${c.subject || '(без предмет)'}` : 'слободен час';
    const info = (c: TeacherChange) => c.together ? [`заедно со ${c.together} (двајца наставници)`] : [];
    for (const c of planned.changes) {
        items.push({ key: `mylesson:${c.key}`, type: 'mylesson', state: c.reasons.length ? 'conflict' : 'clean', day: c.day, ordinal: c.ordinal,
                     fromCell: c.from, toCell: c.to, together: c.together, reasons: c.reasons.concat(info(c)) });
    }
    for (const c of planned.conflicts) {
        items.push({ key: `mylesson:${c.key}`, type: 'mylesson', state: 'changed', day: c.day, ordinal: c.ordinal,
                     fromCell: c.from, toCell: c.to, together: c.together,
                     reasons: [`сменето во базата откако е направен формуларот (формуларот: ${show(c.baseline)})`].concat(c.reasons, info(c)) });
    }
    for (const s of planned.skipped) {
        items.push({ key: `mylesson:${s.key}`, type: 'mylesson', state: 'refused', day: s.day, ordinal: s.ordinal, reasons: [s.reason] });
    }
    return { errors: [], teacher: planned.teacher, note: planned.note, unchanged: planned.unchanged, items };
}

/**
 * Written at once, without the administrator (owner, 24 Sep 2026: colleagues
 * answer for their own data; it is enough to know who entered it). Only what
 * is theirs and touches nobody else: a clean term, a clean lesson, their own
 * list. A new child (rule 2 — a person decides who a typed name is), a pupil
 * report, anything changed meanwhile or in conflict waits for the
 * administrator.
 */
export function selfApplies(item: Item): boolean {
    if (item.state !== 'clean' || item.decision) return false;
    if (item.type === 'block') return (item.to || []).every((x) => typeof x === 'string');
    return ['caseload', 'uncaseload', 'lesson', 'mylesson'].includes(item.type);
}

// ── whose answer it is: the PIN signature ───────────────────────────────────

export type Signed = { ok: true; kind: 'therapist' | 'teacher'; id: number; name: string; created: boolean } | { ok: false; error: string };

const stableText = (v: unknown): string => {
    const sorted = (x: any): any => Array.isArray(x) ? x.map(sorted)
        : x && typeof x === 'object' ? Object.keys(x).sort().reduce((o: any, k) => { o[k] = sorted(x[k]); return o; }, {}) : x;
    return JSON.stringify(sorted(v));
};

/**
 * Nobody may bring in an answer in a colleague's name (owner, 24 Sep 2026).
 * The form signs the answer with HMAC-SHA256 keyed by scrypt(PIN, salt) — the
 * very value `evidence_logins.pin_hash` holds — so the check needs nothing the
 * server does not already have. No signature, another person's salt, or a
 * wrong PIN: the answer is not stored at all.
 *
 * A person with no PIN yet may create one in the form: the answer then carries
 * the new key, it must verify with that key, and it is stored as their PIN
 * (the same one Евидентен лист uses). Only when there is none — an existing
 * PIN is never replaced from a file.
 */
export async function verifySignature(db: Queryable, reply: any, d: Extract<Described, { ok: true }>): Promise<Signed> {
    const sig = reply?.signature;
    if (!sig || typeof sig !== 'object' || typeof sig.value !== 'string' || typeof sig.salt !== 'string') {
        return { ok: false, error: 'одговорот не е потпишан со PIN — пополни го во нов формулар' };
    }
    const kind = sig.by?.kind === 'teacher' ? 'teacher' : sig.by?.kind === 'therapist' ? 'therapist' : null;
    const name = String(sig.by?.name || '').trim();
    if (!kind || !name) return { ok: false, error: 'потписот не кажува кој пополнил' };
    // The signer must be the person the answer is about; a class answer may
    // be filled in by any teacher, whose name is then the author.
    const subject = d.kind === 'cabinet' ? ['therapist', reply.therapist?.name] : d.kind === 'teacher' ? ['teacher', reply.teacher?.name] : ['teacher', name];
    if (subject[0] !== kind || personKey(kind, subject[1]) !== personKey(kind, name)) {
        return { ok: false, error: `потписот е на ${name}, а одговорот е за ${subject[1]}` };
    }
    const table = kind === 'teacher' ? 'teachers' : 'therapists';
    const column = kind === 'teacher' ? 'teacher_id' : 'therapist_id';
    const people = (await db.query(`SELECT id, name FROM ${table} WHERE lower(btrim(name)) = lower(btrim($1))`, [name])).rows;
    if (people.length !== 1) return { ok: false, error: `${name} не е во базата` };
    const person = people[0];
    const login = (await db.query(`SELECT pin_salt, pin_hash FROM evidence_logins WHERE ${column} = $1`, [person.id])).rows[0];
    let key: string;
    let created = false;
    if (login) {
        if (login.pin_salt !== sig.salt) {
            return { ok: false, error: `PIN-от на ${person.name} е сменет или создаден откако е направен формуларот — пополни го во нов формулар` };
        }
        key = login.pin_hash;
    } else {
        if (typeof sig.newPin !== 'string' || !/^[0-9a-f]{64}$/.test(sig.newPin) || !/^[0-9a-f]{32}$/.test(sig.salt)) {
            return { ok: false, error: `${person.name} нема PIN — формуларот мора да создаде PIN` };
        }
        key = sig.newPin;
        created = true;
    }
    const body = { ...reply };
    delete body.signature;
    const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(stableText(body), 'utf8').digest();
    const offered = Buffer.from(String(sig.value), 'hex');
    if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) {
        return { ok: false, error: 'PIN-от не се совпаѓа — одговорот не е внесен' };
    }
    if (created) {
        const stored = await db.query(
            `INSERT INTO evidence_logins (${column}, pin_salt, pin_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`,
            [person.id, sig.salt, key]);
        if (!stored.rowCount) return { ok: false, error: `${person.name} во меѓувреме доби PIN — пополни го во нов формулар` };
    }
    return { ok: true, kind, id: person.id, name: person.name, created };
}

/** Every person's PIN salt (never a hash) — what a form needs to sign with. */
export async function signers(db: Queryable): Promise<Array<{ kind: 'therapist' | 'teacher'; name: string; salt: string | null }>> {
    return (await db.query(
        `SELECT 'therapist' AS kind, t.name, l.pin_salt AS salt FROM therapists t LEFT JOIN evidence_logins l ON l.therapist_id = t.id
         UNION ALL
         SELECT 'teacher', t.name, l.pin_salt FROM teachers t LEFT JOIN evidence_logins l ON l.teacher_id = t.id
         ORDER BY 1, 2`)).rows;
}
