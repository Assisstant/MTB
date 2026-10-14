/**
 * A pupil's action plan, part by part (061; owner, 14 Oct 2026).
 *
 * ONE WRITER. Every change of a part — a colleague's save, a confirmation, the
 * administrator's „Врати" and „Премести" — goes through `applyPart`, inside the
 * caller's transaction, and leaves its row in `pupil_plan_changes` there. The
 * record therefore cannot say something the plan does not hold.
 *
 * A part is compared by its CONTENT, with the keys in one order: jsonb hands
 * an object back with its keys rearranged, and text compared as stored would
 * call an untouched part changed.
 */
import { z } from 'zod';

type Queryable = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };

export const PART = /^(cabinets|phaseA|iop|yearEnd|review:[1-4]|goal:[a-z0-9_]{1,40}|marks:[a-z0-9_]{1,40}:[1-4])$/;
export type PartKind = 'cabinets' | 'phaseA' | 'iop' | 'yearEnd' | 'review' | 'goal' | 'marks';

export function partOf(part: string): { kind: PartKind; code?: string; quarter?: number } | null {
    if (!PART.test(part)) return null;
    const [kind, a, b] = part.split(':');
    if (kind === 'review') return { kind, quarter: Number(a) };
    if (kind === 'goal') return { kind, code: a };
    if (kind === 'marks') return { kind, code: a, quarter: Number(b) };
    return { kind: kind as PartKind };
}

/** What one person finishes and says so: everything except the list of cabinets and a cabinet's goals. */
export const confirmable = (part: string) => ['phaseA', 'iop', 'yearEnd', 'review', 'marks'].includes(partOf(part)?.kind || '');

// Clinical free text is kept exactly as typed (trap 20): no trim, no collapse.
const text = z.string().max(8000).default('');
const short = z.string().max(60).default('');
// A field added after 061 (phase 3) has no default: an absent key stays absent,
// so a part written before it compares equal to itself (see `keepAdded`).
const added = z.string().max(8000).optional();
const code = z.string().regex(/^[a-z0-9_]{1,40}$/);
const SHAPES: Record<PartKind, z.ZodTypeAny> = {
    cabinets: z.object({ codes: z.array(code).max(30).refine((list) => new Set(list).size === list.length).default([]) }).strict(),
    phaseA: z.object({ date: short, observation: text, diagnostics: text, teamConf: text }).strict(),
    iop: z.object({ program: short, goals: text, strategies: text, adaptations: text, assistant: text }).strict(),
    yearEnd: z.object({ summary: text, transition: text, summerNotes: text }).strict(),
    // „Исход" and „Одлука" of the quarter's review (phase 3, owner 14 Oct 2026): free text, optional.
    review: z.object({ date: short, iopEval: text, outcome: added, decision: added, revision: text, report: text, parentMeeting: text }).strict(),
    goal: z.object({ baseline: text, goals: text }).strict(),
    // The old project's three measures of an area, all optional: `level` and `baseline` on the scale
    // 0 „не реагира" … 4 „самостојно" (baseline = where the pupil started), `stage` the developmental
    // level 0 „почетно" … 3 „постигнато". null is named and not yet assessed. `note` is the area's own for this quarter.
    marks: z.object({
        rows: z.array(z.object({
            label: z.string().min(1).max(200),
            level: z.number().int().min(0).max(4).nullable().default(null),
            baseline: z.number().int().min(0).max(4).nullable().default(null),
            stage: z.number().int().min(0).max(3).nullable().default(null),
            note: z.string().max(2000).default('')
        }).strict()).max(40).default([]),
        note: text
    }).strict()
};

export function parsePart(part: string, data: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
    const kind = partOf(part)?.kind;
    if (!kind) return { ok: false };
    const parsed = SHAPES[kind].safeParse(data);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** The fields each kind of part gained after 061, which a page loaded before them does not send. */
export const ADDED: Partial<Record<PartKind, string[]>> = { review: ['outcome', 'decision'] };

/**
 * Missing from a write is not the same as emptied (trap 11). A page opened
 * before a field existed sends the part without it, and its save must not
 * erase what a newer page wrote there: an absent added field keeps what the
 * part holds. An added field that is empty is left out, so a part nobody has
 * filled them in keeps the shape it had before they existed.
 */
export function keepAdded(part: string, data: Record<string, unknown>, current: Record<string, unknown> | null | undefined) {
    const kind = partOf(part)?.kind, out = { ...data };
    for (const key of (kind && ADDED[kind]) || []) {
        if (!(key in out) && current && key in current) out[key] = current[key];
        if (out[key] === '' || out[key] === undefined) delete out[key];
    }
    return out;
}

/** Nothing written in it: no text, no cabinet, no area. A row that holds this reads as „празно". */
export function isEmpty(data: unknown): boolean {
    if (data == null) return true;
    if (typeof data === 'string') return data.trim() === '';
    if (Array.isArray(data)) return data.length === 0;
    if (typeof data === 'object') return Object.values(data as object).every(isEmpty);
    return false;
}

const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]))
    : value;
export const canon = (value: unknown) => JSON.stringify(ordered(value ?? null));

export type Confirmed = { by: string; employeeId: number | null; at: string };
/** A part as the record keeps it. */
export type PartState = { data: Record<string, unknown>; by: string; confirmed: Confirmed | null };
export type PartRow = PartState & { version: number; updatedAt: string };

const rowOf = (r: any): PartRow => ({
    data: r.data, by: r.updated_by, version: r.version, updatedAt: new Date(r.updated_at).toISOString(),
    confirmed: r.confirmed_at ? { by: r.confirmed_by, employeeId: r.confirmed_by_employee, at: new Date(r.confirmed_at).toISOString() } : null
});
export const stateOf = (row: PartRow | null): PartState | null => row && { data: row.data, by: row.by, confirmed: row.confirmed };
/** The same part: the same content, confirmed by the same person at the same moment (or by nobody). */
export const sameState = (a: PartState | null, b: PartState | null) =>
    canon(a && { data: a.data, confirmed: a.confirmed && { by: a.confirmed.by, at: a.confirmed.at } })
    === canon(b && { data: b.data, confirmed: b.confirmed && { by: b.confirmed.by, at: b.confirmed.at } });

export type Where = { yearId: number; studentId: number; part: string };

/** The part now, locked for this transaction — also where there is no row yet to lock. */
export async function lockPart(client: Queryable, where: Where): Promise<PartRow | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [`pupil-plan:${where.yearId}:${where.studentId}:${where.part}`]);
    return readPart(client, where, ' FOR UPDATE');
}

export async function readPart(db: Queryable, where: Where, lock = ''): Promise<PartRow | null> {
    const { rows } = await db.query(
        `SELECT data, version, updated_at, updated_by, confirmed_at, confirmed_by, confirmed_by_employee
           FROM pupil_plan_parts WHERE school_year_id = $1 AND student_id = $2 AND part = $3${lock}`,
        [where.yearId, where.studentId, where.part]);
    return rows[0] ? rowOf(rows[0]) : null;
}

export type Change = Where & {
    kind: 'write' | 'confirm' | 'unconfirm' | 'undo' | 'move';
    author: { employeeId: number | null; name: string };
    /** What the part is to hold. */
    next: PartState;
    /** The part as `lockPart` returned it, in this same transaction. */
    current: PartRow | null;
    undoOf?: number | null;
    /** Why, as the colleague typed it (062). Passed only where the column exists (`hasReasons`). */
    reason?: string | null;
};

const REASON = `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('pupil_plan_changes') AND attname = 'reason' AND NOT attisdropped`;
let reasons = false;
/**
 * Does this database keep a reason with a change (062)? Asked of the table the
 * write will resolve to (trap 41). Remembered once it is yes: a column is not
 * taken away again, and a server that meets the migration later finds it.
 */
export async function hasReasons(db: Queryable): Promise<boolean> {
    if (!reasons) reasons = (await db.query(REASON)).rows.length > 0;
    return reasons;
}
/** A reason as kept: as typed, up to 500 characters; nothing for none or only spaces. */
export const reasonOf = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;

/**
 * Write the part and its row in the record. Returns null where nothing would
 * change — a save of what is already there is not a change and leaves no row.
 */
export async function applyPart(client: Queryable, change: Change): Promise<{ version: number; changeId: number } | null> {
    const before = stateOf(change.current);
    if (before ? sameState(before, change.next) : isEmpty(change.next.data)) return null;
    const version = (change.current?.version ?? 0) + 1;
    const c = change.next.confirmed;
    await client.query(
        `INSERT INTO pupil_plan_parts (school_year_id, student_id, part, data, version, updated_by, confirmed_at, confirmed_by, confirmed_by_employee)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
         ON CONFLICT (school_year_id, student_id, part) DO UPDATE
            SET data = EXCLUDED.data, version = EXCLUDED.version, updated_at = now(), updated_by = EXCLUDED.updated_by,
                confirmed_at = EXCLUDED.confirmed_at, confirmed_by = EXCLUDED.confirmed_by,
                confirmed_by_employee = EXCLUDED.confirmed_by_employee`,
        [change.yearId, change.studentId, change.part, JSON.stringify(change.next.data), version, change.next.by,
            c ? c.at : null, c ? c.by : null, c ? c.employeeId : null]);
    // The column is named only when there is a reason, so a database without 062 is written as before.
    const reason = change.reason ? [change.reason] : [];
    const { rows } = await client.query(
        `INSERT INTO pupil_plan_changes (school_year_id, student_id, part, kind, author_employee_id, author_name, before, after, undo_of${reason.length ? ', reason' : ''})
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9${reason.length ? ', $10' : ''}) RETURNING id`,
        [change.yearId, change.studentId, change.part, change.kind, change.author.employeeId, change.author.name,
            before ? JSON.stringify(before) : null, JSON.stringify(change.next), change.undoOf ?? null, ...reason]);
    return { version, changeId: Number(rows[0].id) };
}

/** Sep–Nov, Dec–Feb, Mar–Apr, May–Aug: the quarter a date falls in. */
export function quarterOf(date: Date): number {
    const month = date.getMonth() + 1;
    return month >= 9 && month <= 11 ? 1 : month === 12 || month <= 2 ? 2 : month <= 4 ? 3 : 4;
}
