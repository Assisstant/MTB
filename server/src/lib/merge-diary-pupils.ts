/**
 * One child, two roster rows: giving the diary back its single pupil.
 *
 * On 11 Sep 2026 the annual list was entered as NEW rows instead of onto the
 * existing ones. The old row kept the diary number (`sdnevnik_id`) and the
 * diary's history; the new one got the class, the year's enrolment and the
 * terms in Кабинети. The diary then admitted the new row as a new pupil, so it
 * held the child twice -- or once, under a number the database did not know.
 *
 * That two rows are one child is NOT decided here. The caller names each pair
 * by row id, because the owner said so (2 Oct 2026); nothing in this file
 * compares names (rule 2).
 *
 * What "the same" means, and what it does not:
 *   - the CURRENT row takes the diary number the child always had, and
 *     everything the diary owns moves onto it (marks, the week, dossier,
 *     assessments, triage, audiograms, progress);
 *   - in the diary's document the active pupil takes that number, its earlier
 *     self in "former" or the archive is folded into it, and every term, mark
 *     and record follows;
 *   - the old row is left as it is otherwise -- inactive, with last year's
 *     enrolment and schedule. People are never deleted, and the shared
 *     directory is Podatoci's to tidy, not the diary's.
 *
 * The document is then written back with a new version, so the browser that
 * holds the diary sees "the server changed" and pulls it (docs/SYNC.md), and
 * projected through the same `projectPayload` a save uses. Everything happens
 * on the client it is given: the caller owns the transaction.
 */
import { projectPayload, type Report } from './import-core.js';

export interface MergePair { oldRow: number; newRow: number; }
export interface MarkFromTable { date: string; sdnevnikId: string; slotKey: string; }
export interface MergePlan {
    pairs: MergePair[];
    /**
     * Also take every pair the diary itself points at: an active pupil whose
     * bridge names one row while its diary number sits on ANOTHER. Both are
     * identity links the diary holds for one entry -- no name is compared.
     * The owner's word covers them (2 Oct 2026): "similar records are the same".
     */
    bridged?: boolean;
    marks: MarkFromTable[];
    updatedBy: string;
}

export interface DiaryAgreement {
    pupils: number; linked: number;
    terms: number; termsDifferent: string[];
    marksAgree: number; marksOnlyInDocument: string[]; marksOnlyInTable: string[]; marksDifferent: string[];
    /** Marks under a diary number no roster row carries: they cannot reach a table, and never could. */
    marksOfUnknownPupils: number;
}
export interface MergeResult {
    lines: string[]; before: DiaryAgreement; after: DiaryAgreement;
    version: number; projection: Report; backup: unknown;
}

/** Tables whose rows are the diary's own facts about a pupil. */
const DIARY_TABLES = ['attendance', 'diary_schedule', 'student_records', 'assessments',
    'triage_tests', 'audiograms', 'student_plan_progress'];
const CARRIED = ['planId', 'planType', 'needsTrijazen', 'disabilityType', 'assessmentTemplateId'];

class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };
export const isRefusal = (err: unknown): err is Error => err instanceof Refusal;

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);
const statusOf = (rec: unknown): string | null => {
    const s = typeof rec === 'string' ? rec : (rec && typeof rec === 'object' ? (rec as any).status : null);
    return s === 'present' || s === 'absent' ? s : null;
};

/** Every place the document names a pupil by number moves from one number to another. */
function renumber(doc: any, from: unknown, to: number) {
    const week = (w: any) => {
        if (!w || typeof w !== 'object') return;
        for (const day of Object.keys(w)) {
            if (!Array.isArray(w[day])) continue;
            w[day] = w[day].map((slot: any) => (Array.isArray(slot) ? slot.map((id) => (same(id, from) ? to : id)) : slot));
        }
    };
    week(doc.schedule);
    for (const w of Object.values(doc.scheduleHistory || {})) week(w);

    // A key that exists under both numbers is two answers; merge only what cannot clash.
    const moveKey = (holder: any, where: string, merge: (mine: any, theirs: any, at: string) => any) => {
        if (!holder || typeof holder !== 'object' || !(String(from) in holder)) return;
        const moving = holder[String(from)];
        delete holder[String(from)];
        holder[String(to)] = String(to) in holder ? merge(holder[String(to)], moving, where) : moving;
    };
    const mergeSlots = (mine: any, theirs: any, at: string) => {
        for (const [slot, rec] of Object.entries(theirs || {})) {
            if (statusOf(mine?.[slot]) && statusOf(rec) && statusOf(mine[slot]) !== statusOf(rec)) {
                refuse(`the two numbers disagree about the mark at ${at} ${slot}`);
            }
            if (!statusOf(mine?.[slot])) mine[slot] = rec;
        }
        return mine;
    };
    const mergePlans = (mine: any, theirs: any, at: string) => {
        for (const [plan, entries] of Object.entries(theirs || {})) {
            if (list(mine?.[plan]).length && list(entries).length) refuse(`both numbers carry progress for plan ${plan} (${at})`);
            if (!list(mine?.[plan]).length) mine[plan] = entries;
        }
        return mine;
    };
    for (const [date, byPupil] of Object.entries(doc.attendance || {})) moveKey(byPupil, date, mergeSlots);
    moveKey(doc.studentProgress, 'this year', mergePlans);
    for (const [year, byPupil] of Object.entries(doc.progressArchive || {})) moveKey(byPupil, year, mergePlans);

    for (const key of ['assessments', 'trijazenTestovi']) {
        for (const r of list(doc[key])) if (r && same(r.studentId, from)) r.studentId = to;
    }
    const dossiers = list(doc.student_records);
    const moving = dossiers.filter((r) => r && same(r.id, from));
    if (moving.length && dossiers.some((r) => r && same(r.id, to))) refuse('both numbers carry a dossier');
    moving.forEach((r) => { r.id = to; });
}

/** Does the document say what the tables say? Read only. */
export async function diaryAgreement(client: any, doc: any): Promise<DiaryAgreement> {
    const year = (await client.query('SELECT id FROM school_years WHERE is_current')).rows[0]?.id ?? null;
    const linkedIds = new Set<string>((await client.query(
        'SELECT sdnevnik_id::text AS sdn FROM students WHERE sdnevnik_id IS NOT NULL')).rows.map((r: any) => r.sdn));
    const pupils = list(doc.students);

    const table: Record<string, string[]> = {};
    for (const r of (await client.query(
        `SELECT d.day, d.position, s.sdnevnik_id::text AS sdn
           FROM diary_schedule d JOIN students s ON s.id = d.student_id
          WHERE d.school_year_id = $1 ORDER BY d.day, d.position, d.ordinal`, [year])).rows) {
        (table[`${r.day}|${r.position}`] ||= []).push(r.sdn);
    }
    let terms = 0;
    const termsDifferent: string[] = [];
    for (const [day, slots] of Object.entries(doc.schedule || {})) {
        list(slots).forEach((slot, position) => {
            const mine = list(slot).map(String);
            const theirs = table[`${day}|${position}`] || [];
            if (mine.length) terms++;
            if (JSON.stringify(mine) !== JSON.stringify(theirs)) termsDifferent.push(`${day} ${position + 1}`);
        });
    }

    const inTable = new Map<string, string>();
    for (const r of (await client.query(
        `SELECT a.date, a.slot_key, a.status, s.sdnevnik_id::text AS sdn
           FROM attendance a JOIN students s ON s.id = a.student_id WHERE s.sdnevnik_id IS NOT NULL`)).rows) {
        inTable.set(`${r.date}|${r.sdn}|${r.slot_key}`, r.status);
    }
    const seen = new Set<string>();
    let marksAgree = 0, marksOfUnknownPupils = 0;
    const marksOnlyInDocument: string[] = [], marksDifferent: string[] = [];
    for (const [date, byPupil] of Object.entries(doc.attendance || {})) {
        for (const [sid, bySlot] of Object.entries((byPupil as any) || {})) {
            for (const [slot, rec] of Object.entries((bySlot as any) || {})) {
                const status = statusOf(rec);
                if (!status) continue;
                const key = `${date}|${sid}|${slot}`;
                seen.add(key);
                if (!linkedIds.has(sid)) marksOfUnknownPupils++;
                else if (!inTable.has(key)) marksOnlyInDocument.push(key);
                else if (inTable.get(key) !== status) marksDifferent.push(key);
                else marksAgree++;
            }
        }
    }
    return {
        pupils: pupils.length, linked: pupils.filter((s) => linkedIds.has(String(s?.id))).length,
        terms, termsDifferent, marksAgree, marksOnlyInDocument, marksDifferent, marksOfUnknownPupils,
        marksOnlyInTable: [...inTable.keys()].filter((k) => !seen.has(k))
    };
}

export async function mergeDiaryPupils(client: any, plan: MergePlan): Promise<MergeResult> {
    const lines: string[] = [];
    const state = (await client.query(
        `SELECT version, payload FROM app_state WHERE app = 'sdnevnik' FOR UPDATE`)).rows[0];
    if (!state) refuse('the database holds no diary document');
    const backup: any = { version: state.version, payload: structuredClone(state.payload), rows: {} };
    const doc = structuredClone(state.payload);
    const before = await diaryAgreement(client, doc);

    const year = (await client.query('SELECT id FROM school_years WHERE is_current')).rows[0]?.id;
    if (year == null) refuse('no current school year is set');
    const tables: string[] = (await client.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'student_id' AND table_name = ANY($1)`,
        [DIARY_TABLES])).rows.map((r: any) => r.table_name);

    const mergePair = async ({ oldRow, newRow }: MergePair) => {
        const rows = (await client.query(
            `SELECT s.id, s.public_id, s.sdnevnik_id::text AS sdn, s.active, s.plan_id,
                    EXISTS (SELECT 1 FROM student_enrollments e
                             WHERE e.student_id = s.id AND e.school_year_id = $2 AND e.active) AS enrolled
               FROM students s WHERE s.id = ANY($1) ORDER BY s.id FOR UPDATE OF s`, [[oldRow, newRow], year])).rows;
        const o = rows.find((r: any) => r.id === oldRow), n = rows.find((r: any) => r.id === newRow);
        const at = `pair ${oldRow}→${newRow}`;
        if (!o || !n || oldRow === newRow) refuse(`${at}: both rows must exist and differ`);
        if (o.sdn == null) refuse(`${at}: the old row carries no diary number -- there is nothing to hand over`);
        if (n.sdn != null) refuse(`${at}: the current row already carries diary number ${n.sdn}`);
        // Enrolment decides, not `students.active`: that flag is global and the
        // diary's own saves kept it on for a row the year's list had replaced.
        if (o.enrolled) refuse(`${at}: the old row is on this year's list too -- that is a second pupil, not a leftover`);
        if (!n.enrolled) refuse(`${at}: the current row is not on this year's list`);
        backup.rows[at] = { students: rows };
        for (const t of tables) {
            const held = (await client.query(`SELECT * FROM ${t} WHERE student_id = ANY($1)`, [[oldRow, newRow]])).rows;
            backup.rows[at][t] = held;
            if (held.some((r: any) => r.student_id === newRow)) {
                refuse(`${at}: the current row already has rows in ${t} -- merging would have to choose between them`);
            }
        }

        const oldId = Number(o.sdn);
        const active = list(doc.students).filter((s) => s && s.rasporediStudentId === n.public_id);
        if (active.length !== 1) refuse(`${at}: the diary has ${active.length} active pupils on the current row, expected 1`);
        const pupil = active[0];
        if (list(doc.students).some((s) => s !== pupil && same(s?.id, oldId))) {
            refuse(`${at}: another ACTIVE diary pupil already uses number ${oldId}`);
        }
        const wasId = pupil.id;
        let folded = '';
        for (const key of ['formerCaseloadStudents', 'archivedStudents']) {
            const earlier = list(doc[key]).filter((s) => s && same(s.id, oldId));
            if (!earlier.length) continue;
            for (const field of CARRIED) {
                const empty = pupil[field] == null || pupil[field] === '' || pupil[field] === false;
                if (empty && earlier[0][field] != null) pupil[field] = earlier[0][field];
            }
            doc[key] = list(doc[key]).filter((s) => !earlier.includes(s));
            folded += ` its earlier self in ${key} is folded in;`;
        }
        if (!same(wasId, oldId)) renumber(doc, wasId, oldId);
        pupil.id = oldId;

        let moved = 0;
        for (const t of tables) {
            moved += (await client.query(`UPDATE ${t} SET student_id = $2 WHERE student_id = $1`, [oldRow, newRow])).rowCount ?? 0;
        }
        // The old row stops being a pupil of today: no diary number, not active.
        // It keeps its past years; nothing is deleted.
        await client.query('UPDATE students SET sdnevnik_id = NULL, active = false, updated_at = now() WHERE id = $1', [oldRow]);
        await client.query(
            'UPDATE students SET sdnevnik_id = $2, plan_id = COALESCE(plan_id, $3), updated_at = now() WHERE id = $1',
            [newRow, oldId, o.plan_id]);
        lines.push(`${at}: diary number ${oldId} now belongs to the current row (the diary held it as ${wasId});${folded} ${moved} diary rows moved`);
    };
    for (const pair of plan.pairs) await mergePair(pair);

    if (plan.bridged) {
        for (const pupil of list(doc.students)) {
            const id = Number(pupil?.id);
            if (!pupil?.rasporediStudentId || !Number.isSafeInteger(id) || id <= 0) continue;
            const byBridge = (await client.query(
                'SELECT id, sdnevnik_id FROM students WHERE public_id = $1', [pupil.rasporediStudentId])).rows[0];
            const byNumber = (await client.query('SELECT id FROM students WHERE sdnevnik_id = $1', [id])).rows[0];
            if (!byBridge || !byNumber || byBridge.id === byNumber.id || byBridge.sdnevnik_id != null) continue;
            await mergePair({ oldRow: byNumber.id, newRow: byBridge.id });
        }
    }

    for (const m of plan.marks) {
        const row = (await client.query(
            `SELECT a.status, a.time_slot FROM attendance a JOIN students s ON s.id = a.student_id
              WHERE s.sdnevnik_id = $1 AND a.date = $2 AND a.slot_key = $3`, [m.sdnevnikId, m.date, m.slotKey])).rows[0];
        const at = `mark ${m.date} ${m.slotKey}`;
        if (!row) refuse(`${at}: the table holds no such mark`);
        if (!list(doc.students).some((s) => same(s?.id, m.sdnevnikId))) refuse(`${at}: the diary has no active pupil ${m.sdnevnikId}`);
        const day = ((doc.attendance ||= {})[m.date] ||= {});
        const slots = (day[m.sdnevnikId] ||= {});
        if (statusOf(slots[m.slotKey])) refuse(`${at}: the diary already has a mark there`);
        slots[m.slotKey] = { status: row.status, date: m.date, ...(row.time_slot ? { time: row.time_slot } : {}) };
        lines.push(`${at}: „${row.status}" taken from the table into the diary`);
    }

    const version = Number(state.version) + 1;
    doc._meta = { ...(doc._meta || {}), savedAt: new Date().toISOString(), reason: 'merge_diary_pupils' };
    await client.query(
        `UPDATE app_state SET version = $1, payload = $2, updated_at = now(), updated_by = $3 WHERE app = 'sdnevnik'`,
        [version, JSON.stringify(doc), plan.updatedBy]);
    // The same projection a save from the diary runs: the document and the
    // tables are one state, and this is what makes them one again.
    const { report } = await projectPayload(client, doc, { rosterOwned: true });
    const after = await diaryAgreement(client, doc);
    return { lines, before, after, version, projection: report, backup };
}
