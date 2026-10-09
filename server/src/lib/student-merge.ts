/**
 * One child, two rows in `students` — found, put to a person, merged.
 *
 * The owner, 4 Oct 2026: surnames are often typed with and without a „в"
 * (Петкоски / Петковски), and „да имаме две деца, односно два записи, е многу
 * поголем проблем" than a misspelt surname, which is easily fixed after a
 * merge. So this file does two things, and neither decides alone:
 *
 *   - `lookAlikePairs` lists rows whose names match or differ by one letter
 *     per part. It never merges. The person answers „Спои" or „Не се исти".
 *   - `mergeStudents` moves EVERYTHING that points at the row being folded in
 *     onto the row being kept, in one transaction: every table that references
 *     `students` (the list in roster-purge.ts, which its suite checks against
 *     `pg_constraint`), the arrangement keys in `roster_order`, the diary
 *     number, and the diary's own document. Where both rows hold the same fact
 *     (two enrolments for one year, two marks for one lesson), the kept row's
 *     wins — except an inactive enrolment, which gives way to an active one.
 *     The folded row is never deleted (people are not): it is left inactive,
 *     with no diary number and nothing pointing at it, and `left_reason` says
 *     `merged:<kept public_id>` so the merge can be traced.
 *
 * `lib/merge-diary-pupils.ts` (`npm run diary:merge`) is the narrower,
 * older tool for one shape of this — an old row with the diary's history and
 * a new row on this year's list. This is the general one, behind a person's
 * click in Податоци.
 */
import { PURGE } from '../routes/roster-purge.js';

/**
 * For each table that references a pupil, the OTHER columns of the unique key
 * that contains `student_id`. Two rows with the same values there are one fact
 * held twice; the kept row's copy stays. A table not named here has no such
 * key and its rows simply move. `student-merge.e2e.ts` compares this with the
 * live constraints, so a migration that adds one cannot slip past.
 */
export const SAME_FACT: Record<string, string[]> = {
    student_enrollments: ['school_year_id'],
    attendance: ['date', 'slot_key'],
    cabinet_attendance_pupils: ['school_year_id', 'therapist_id', 'day'],
    class_attendance: ['school_year_id', 'class_id', 'day'],
    diary_schedule: ['school_year_id', 'day', 'position'],
    evidence_sheets: ['school_year_id'],
    student_plan_progress: ['activity_id'],
    student_records: [],
    therapist_students: ['school_year_id', 'therapist_id']
};

/** The tables that reference a pupil, with their column — one list, roster-purge's. */
export function pupilTables(): Record<string, string> {
    return { ...PURGE.student.sweep, ...PURGE.student.refuse };
}

class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };
export const isMergeRefusal = (err: unknown): err is Error => err instanceof Refusal;

// ── look-alike names ───────────────────────────────────────────────────────

/** The name without a class written in front of it or a note in brackets after it. */
export function nameKey(value: unknown): string {
    let n = String(value ?? '');
    const cut = n.indexOf(' - ');
    if (cut > -1 && /^\s*(?:(?:[IVXІХ]+|\d+)(?![A-Za-zЀ-ӿ])|подготвит|комбинир|модифиц|предучил)/i.test(n.slice(0, cut))) n = n.slice(cut + 3);
    n = n.replace(/\s*\([^)]*\)\s*$/, '');
    return n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
}

function distance(a: string, b: string): number {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let k = 1; k <= b.length; k++) {
            cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * The same name, or one letter apart in a part of it, with at least one part
 * exactly the same; parts shorter than four letters must match. Also with the
 * two parts the other way round. The SAME rule as `namesLookAlike` in
 * S-Dnevnik.html, which has to work without a server — keep the two equal.
 */
export function namesLookAlike(a: unknown, b: unknown): boolean {
    const ta = nameKey(a).split(' ').filter(Boolean);
    const tb = nameKey(b).split(' ').filter(Boolean);
    if (!ta.length || ta.length !== tb.length) return false;
    if (ta.join(' ') === tb.join(' ')) return true;
    const close = (x: string[], y: string[]) => {
        let total = 0, exact = 0;
        for (let i = 0; i < x.length; i++) {
            const d = distance(x[i], y[i]);
            if (d === 0) { exact++; continue; }
            if (d > 1 || Math.min(x[i].length, y[i].length) < 4) return false;
            total += d;
        }
        return exact > 0 && total <= 2;
    };
    return close(ta, tb) || (tb.length === 2 && close(ta, [tb[1], tb[0]]));
}

export interface PupilFacts {
    public_id: string; name: string; grade: string | null; kind: string | null;
    enrolled: boolean; last_year: string | null; diary: boolean;
    therapists: string[]; terms: number; marks: number; records: number;
}

/**
 * Rows on this year's list, and every pupil still at school who was ever on a
 * list (where the 11 September duplicates live), paired by name. A pair needs
 * at least one row on this year's list: two old rows are history.
 */
export async function lookAlikePairs(client: any, yearId: number): Promise<{ a: PupilFacts; b: PupilFacts }[]> {
    const { rows } = await client.query(
        `WITH y AS (SELECT id, starts_on FROM school_years WHERE id = $1)
         SELECT s.id, s.public_id, s.name, s.sdnevnik_id IS NOT NULL AS diary,
                cur.grade, cur.kind, coalesce(cur.active, false) AS enrolled,
                (SELECT sy.label FROM student_enrollments e JOIN school_years sy ON sy.id = e.school_year_id
                  WHERE e.student_id = s.id AND e.active ORDER BY sy.starts_on DESC LIMIT 1) AS last_year,
                coalesce((SELECT array_agg(DISTINCT t.name ORDER BY t.name) FROM therapist_students ts
                           JOIN therapists t ON t.id = ts.therapist_id
                          WHERE ts.student_id = s.id AND ts.school_year_id = $1), '{}') AS therapists,
                (SELECT count(*)::int FROM schedule_slots sl WHERE sl.student_id = s.id AND sl.school_year_id = $1) AS terms,
                (SELECT count(*)::int FROM attendance a WHERE a.student_id = s.id) AS marks,
                ((SELECT count(*) FROM assessments x WHERE x.student_id = s.id) +
                 (SELECT count(*) FROM triage_tests x WHERE x.student_id = s.id) +
                 (SELECT count(*) FROM student_records x WHERE x.student_id = s.id) +
                 (SELECT count(*) FROM evidence_sheets x WHERE x.student_id = s.id))::int AS records
           FROM students s
           CROSS JOIN y
           LEFT JOIN student_enrollments cur ON cur.student_id = s.id AND cur.school_year_id = y.id
          WHERE coalesce(cur.active, false)
             OR (s.active AND EXISTS (SELECT 1 FROM student_enrollments e WHERE e.student_id = s.id))
          ORDER BY s.id`,
        [yearId]
    );
    const pairs: { a: PupilFacts; b: PupilFacts }[] = [];
    const facts = (r: any): PupilFacts => ({
        public_id: r.public_id, name: r.name, grade: r.grade, kind: r.kind, enrolled: r.enrolled,
        last_year: r.last_year, diary: r.diary, therapists: r.therapists, terms: r.terms, marks: r.marks, records: r.records
    });
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (!rows[i].enrolled && !rows[j].enrolled) continue;
            if (!namesLookAlike(rows[i].name, rows[j].name)) continue;
            pairs.push({ a: facts(rows[i]), b: facts(rows[j]) });
        }
    }
    return pairs;
}

// ── the merge ──────────────────────────────────────────────────────────────

export interface MergeOutcome {
    kept: string; folded: string;
    moved: Record<string, number>;
    /** One fact held by both rows: the kept row's copy stayed. */
    sameFact: Record<string, number>;
    /** Of those, marks where the two rows disagreed (the kept row's mark stayed). */
    marksDiffered: number;
    diaryNumber: string | null;
    diary: string;
    /** Terms the child now has twice at one time (one booked under each row). */
    clashes: string[];
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);
const empty = (v: unknown) => v == null || v === '';
const CARRIED = ['planId', 'planType', 'needsTrijazen', 'disabilityType', 'assessmentTemplateId'];

/**
 * The diary's document: diary number `from` becomes `to`, the pupil held
 * under `from` is folded into the one under `to`, and every pupil bridged to
 * the folded row is bridged to the kept one. Where both numbers hold
 * something in one place, `to`'s stays (the owner: merge, then correct).
 */
export function mergeInDiaryDocument(doc: any, o: { from: string | null; to: string | null; foldedPublicId: string; keptPublicId: string }): string[] {
    const said: string[] = [];
    for (const key of ['students', 'formerCaseloadStudents', 'archivedStudents']) {
        for (const p of list(doc[key])) if (p && p.rasporediStudentId === o.foldedPublicId) p.rasporediStudentId = o.keptPublicId;
    }
    if (o.from == null || o.to == null || o.from === o.to) return said;
    const from = o.from, to = Number(o.to);

    const where = (id: string) => {
        for (const key of ['students', 'formerCaseloadStudents', 'archivedStudents']) {
            const at = list(doc[key]).findIndex((p) => p && same(p.id, id));
            if (at >= 0) return { key, at, pupil: doc[key][at] };
        }
        return null;
    };
    const g = where(from), k = where(String(to));
    if (g && k) {
        for (const f of CARRIED) if ((empty(k.pupil[f]) || k.pupil[f] === false) && !empty(g.pupil[f])) k.pupil[f] = g.pupil[f];
        doc[g.key].splice(g.at, 1);
        // The kept pupil is in the diary's active list if either of them was.
        if (g.key === 'students' && k.key !== 'students') {
            const again = where(String(to))!;
            doc[again.key].splice(again.at, 1);
            delete again.pupil._formerCaseload;
            list(doc.students).splice(Math.min(g.at, list(doc.students).length), 0, again.pupil);
        }
        said.push(`the diary's two pupils ${from} and ${to} are one`);
    } else if (g) {
        g.pupil.id = to;
        said.push(`the diary's pupil ${from} is now ${to}`);
    }

    const week = (w: any) => {
        if (!w || typeof w !== 'object') return;
        for (const day of Object.keys(w)) {
            if (!Array.isArray(w[day])) continue;
            w[day] = w[day].map((slot: any) => {
                if (!Array.isArray(slot)) return slot;
                const out: any[] = [];
                for (const id of slot) {
                    const v = same(id, from) ? to : id;
                    if (!out.some((x) => same(x, v))) out.push(v);
                }
                return out;
            });
        }
    };
    week(doc.schedule);
    for (const w of Object.values(doc.scheduleHistory || {})) week(w);
    // Weeks pasted ahead of time (5 Oct 2026): a plan, like `schedule`.
    for (const w of Object.values(doc.planFrom || {})) week(w);

    for (const byPupil of Object.values(doc.attendance || {}) as any[]) {
        if (!byPupil || typeof byPupil !== 'object' || !(from in byPupil)) continue;
        const moving = byPupil[from];
        delete byPupil[from];
        if (!(String(to) in byPupil)) { byPupil[to] = moving; continue; }
        for (const [slot, rec] of Object.entries(moving || {})) if (!(slot in byPupil[to])) byPupil[to][slot] = rec;
    }
    const progress = (holder: any) => {
        if (!holder || typeof holder !== 'object' || !(from in holder)) return;
        const moving = holder[from] || {};
        delete holder[from];
        const into = (holder[to] ||= {});
        // One fact per activity index, with the kept pupil's record winning.
        // Real diary entries are {index,date,time}, not just numbers: Set on
        // those objects compares references and counts identical work twice.
        for (const [plan, entries] of Object.entries(moving)) {
            const seen = new Set<string>();
            into[plan] = [...list(into[plan]), ...list(entries)].filter(entry => {
                const index = entry && typeof entry === 'object' ? entry.index : entry;
                const key = typeof index === 'number' && Number.isInteger(index)
                    ? `activity:${index}` : `legacy:${JSON.stringify(entry)}`;
                if (seen.has(key)) return false;
                seen.add(key); return true;
            });
        }
    };
    progress(doc.studentProgress);
    for (const byPupil of Object.values(doc.progressArchive || {})) progress(byPupil);
    for (const key of ['assessments', 'trijazenTestovi']) for (const r of list(doc[key])) if (r && same(r.studentId, from)) r.studentId = to;
    const dossiers = list(doc.student_records);
    const theirs = dossiers.find((r) => r && same(r.id, from));
    const ours = dossiers.find((r) => r && same(r.id, to));
    if (theirs && !ours) theirs.id = to;
    else if (theirs && ours) {
        for (const [f, v] of Object.entries(theirs)) if (f !== 'id' && empty(ours[f]) && !empty(v)) ours[f] = v;
        dossiers.splice(dossiers.indexOf(theirs), 1);
    }
    return said;
}

/**
 * Fold row `foldPublicId` into row `keepPublicId`. The caller owns the
 * transaction (BEGIN … COMMIT); everything here runs on its client.
 */
export async function mergeStudents(client: any, keepPublicId: string, foldPublicId: string, updatedBy: string): Promise<MergeOutcome> {
    if (!keepPublicId || !foldPublicId || keepPublicId === foldPublicId) refuse('two different pupils are needed');
    // Same order as state.ts: diary first, pupils second. The advisory lock
    // covers a first save too, when there is no app_state row to lock yet.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('app_state:sdnevnik'))`);
    const state = (await client.query(`SELECT version, payload FROM app_state WHERE app = 'sdnevnik' FOR UPDATE`)).rows[0];
    // Lock the identity rows in id order before reading their related records.
    const rows = (await client.query(
        `SELECT id, public_id, sdnevnik_id::text AS sdn, plan_id, name, active, left_reason FROM students
          WHERE public_id = ANY($1) ORDER BY id FOR UPDATE`, [[keepPublicId, foldPublicId]])).rows;
    const k = rows.find((r: any) => r.public_id === keepPublicId);
    const g = rows.find((r: any) => r.public_id === foldPublicId);
    if (!k || !g) refuse('one of the two pupils is not in the database');
    if ([k, g].some(r => String(r.left_reason || '').startsWith('merged:'))) {
        refuse('Еден од записите веќе е споен. Освежете го списокот пред повторно спојување.');
    }

    const out: MergeOutcome = { kept: k.public_id, folded: g.public_id, moved: {}, sameFact: {}, marksDiffered: 0, diaryNumber: null, diary: '', clashes: [] };
    const tables = pupilTables();
    const present = new Set<string>((await client.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'student_id' AND table_name = ANY($1)`,
        [Object.keys(tables)])).rows.map((r: any) => r.table_name));

    // An active enrolment beats an inactive one for the same year, whichever row holds it.
    if (present.has('student_enrollments')) {
        await client.query(
            `DELETE FROM student_enrollments k USING student_enrollments g
              WHERE k.student_id = $1 AND g.student_id = $2 AND k.school_year_id = g.school_year_id
                AND NOT k.active AND g.active`, [k.id, g.id]);
    }
    // One dossier: the kept one, with what only the other one says filled in.
    if (present.has('student_records')) {
        const cols: string[] = (await client.query(
            `SELECT column_name, data_type FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'student_records'
                AND column_name NOT IN ('student_id', 'updated_at')`)).rows
            .map((c: any) => c.data_type === 'text'
                ? `${c.column_name} = coalesce(nullif(k.${c.column_name}, ''), g.${c.column_name})`
                : `${c.column_name} = coalesce(k.${c.column_name}, g.${c.column_name})`);
        if (cols.length) {
            await client.query(
                `UPDATE student_records k SET ${cols.join(', ')}, updated_at = now()
                   FROM student_records g WHERE k.student_id = $1 AND g.student_id = $2`, [k.id, g.id]);
        }
    }
    // One евидентен лист per year: if both rows have one, the empty one gives way;
    // two filled sheets are two documents a person has to read, not a merge.
    if (present.has('evidence_sheets')) {
        const both = (await client.query(
            `SELECT k.id AS kid, g.id AS gid, k.school_year_id,
                    (SELECT count(*) FROM evidence_scores x WHERE x.sheet_id = k.id) + (SELECT count(*) FROM evidence_panels x WHERE x.sheet_id = k.id)
                  + (SELECT count(*) FROM evidence_sheet_sections x WHERE x.sheet_id = k.id) + (SELECT count(*) FROM evidence_contacts x WHERE x.sheet_id = k.id)
                  + (SELECT count(*) FROM evidence_examiners x WHERE x.sheet_id = k.id) AS kfill,
                    (SELECT count(*) FROM evidence_scores x WHERE x.sheet_id = g.id) + (SELECT count(*) FROM evidence_panels x WHERE x.sheet_id = g.id)
                  + (SELECT count(*) FROM evidence_sheet_sections x WHERE x.sheet_id = g.id) + (SELECT count(*) FROM evidence_contacts x WHERE x.sheet_id = g.id)
                  + (SELECT count(*) FROM evidence_examiners x WHERE x.sheet_id = g.id) AS gfill
               FROM evidence_sheets k JOIN evidence_sheets g ON g.school_year_id = k.school_year_id
              WHERE k.student_id = $1 AND g.student_id = $2`, [k.id, g.id])).rows;
        for (const s of both) {
            if (Number(s.kfill) > 0 && Number(s.gfill) > 0) {
                refuse('both pupils have a filled евидентен лист for the same year — read both and empty one first');
            }
            if (Number(s.kfill) === 0 && Number(s.gfill) > 0) await client.query('DELETE FROM evidence_sheets WHERE id = $1', [s.kid]);
        }
    }
    if (present.has('attendance')) {
        out.marksDiffered = Number((await client.query(
            `SELECT count(*) FROM attendance k JOIN attendance g ON g.date = k.date AND g.slot_key = k.slot_key
              WHERE k.student_id = $1 AND g.student_id = $2 AND g.status IS DISTINCT FROM k.status`, [k.id, g.id])).rows[0].count);
    }

    for (const [table, column] of Object.entries(tables)) {
        if (!present.has(table)) continue;
        const key = SAME_FACT[table];
        if (key) {
            const match = key.map((c) => `g.${c} IS NOT DISTINCT FROM k.${c}`).join(' AND ');
            const dropped = (await client.query(
                `DELETE FROM ${table} g USING ${table} k
                  WHERE g.${column} = $2 AND k.${column} = $1${match ? ' AND ' + match : ''}`, [k.id, g.id])).rowCount ?? 0;
            if (dropped) out.sameFact[table] = dropped;
        }
        const moved = (await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [k.id, g.id])).rowCount ?? 0;
        if (moved) out.moved[table] = moved;
    }

    // The arrangement keys name a pupil by public_id, in each list it is in.
    if ((await client.query(`SELECT to_regclass('roster_order') IS NOT NULL AS ok`)).rows[0].ok) {
        await client.query(
            `DELETE FROM roster_order g USING roster_order k
              WHERE g.member_key = $2 AND k.member_key = $1 AND k.list = g.list AND k.school_year_id = g.school_year_id`,
            [k.public_id, g.public_id]);
        await client.query('UPDATE roster_order SET member_key = $1 WHERE member_key = $2', [k.public_id, g.public_id]);
    }

    // The diary number: the kept row keeps its own, or takes the other's.
    const diaryTo = k.sdn ?? g.sdn;
    await client.query(
        `UPDATE students SET sdnevnik_id = NULL, active = false, left_at = now(),
                left_reason = $2, updated_at = now() WHERE id = $1`, [g.id, `merged:${k.public_id}`]);
    // Still at school if either of them was; an archived pair stays archived.
    await client.query(
        `UPDATE students SET sdnevnik_id = $2, plan_id = coalesce(plan_id, $3), updated_at = now(),
                left_at = CASE WHEN $4 AND NOT active THEN NULL ELSE left_at END,
                left_year = CASE WHEN $4 AND NOT active THEN NULL ELSE left_year END,
                left_reason = CASE WHEN $4 AND NOT active THEN NULL ELSE left_reason END,
                active = active OR $4
          WHERE id = $1`,
        [k.id, diaryTo, g.plan_id, g.active === true]);
    out.diaryNumber = diaryTo;

    // Two terms at one time for the one child now — said, not undone: a person
    // frees one in „Термини".
    out.clashes = (await client.query(
        `SELECT a.day, a.time_slot FROM schedule_slots a JOIN schedule_slots b
             ON b.school_year_id = a.school_year_id AND b.day = a.day AND b.time_slot = a.time_slot
            AND b.student_id = a.student_id AND b.id > a.id
          WHERE a.student_id = $1 ORDER BY a.day_order, a.time_slot`, [k.id])).rows.map((r: any) => `${r.day} ${r.time_slot}`);

    // The diary's document, so the browser that holds it pulls the same picture.
    if (state && state.payload && typeof state.payload === 'object') {
        const doc = structuredClone(state.payload);
        const before = JSON.stringify(doc);
        const said = mergeInDiaryDocument(doc, {
            from: k.sdn && g.sdn && k.sdn !== g.sdn ? g.sdn : null,
            to: k.sdn && g.sdn && k.sdn !== g.sdn ? k.sdn : null,
            foldedPublicId: g.public_id, keptPublicId: k.public_id
        });
        if (JSON.stringify(doc) !== before) {
            doc._meta = { ...(doc._meta || {}), savedAt: new Date().toISOString(), reason: 'merge_students' };
            await client.query(
                `UPDATE app_state SET version = $1, payload = $2, updated_at = now(), updated_by = $3 WHERE app = 'sdnevnik'`,
                [Number(state.version) + 1, JSON.stringify(doc), updatedBy]);
            out.diary = said.length ? said.join('; ') : 'the diary now points at the kept pupil';
        }
    }
    return out;
}
