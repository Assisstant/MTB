/**
 * Shared core for turning app state (Unified Sync / S-Dnevnik JSON) into
 * relational rows.
 *
 * Used by two callers:
 *   - scripts/import-json.ts   one-off imports from files, with a full report
 *   - routes/state.ts          every save from the apps, so the tables stay
 *                              current without anyone running a script
 *
 * Identity reconciliation lives here because both callers must resolve
 * students the same way; two implementations would drift and silently create
 * duplicate people.
 *
 * The dataset is small by nature (tens of students, ten therapists, a few
 * hundred slots), so each save simply re-projects the whole state instead of
 * computing diffs. At this size that is both faster to run and far easier to
 * reason about than incremental updates.
 */

import {
    upsertDossier, upsertScaleTemplate, upsertAssessment, upsertTriage, upsertAudiogram
} from './records.js';

/** Both apps carry a non-student placeholder at the top of the list. */
export const PLACEHOLDERS = new Set(['Избери Ученик', 'Select Student']);

/** Only for sorting — the day label itself is stored as the app writes it. */
export const DAY_ORDER: Record<string, number> = {
    'понеделник': 1, 'вторник': 2, 'среда': 3, 'четврток': 4, 'петок': 5, 'сабота': 6, 'недела': 7,
    'pon': 1, 'vto': 2, 'sre': 3, 'cet': 4, 'pet': 5
};

/** Collected per run — never module-level, or a long-lived server would leak findings between saves. */
export interface Report {
    notes: string[];
    problems: string[];
}
export const newReport = (): Report => ({ notes: [], problems: [] });

export type MatchTier = 'bridge-id' | 'exact-name' | 'bare-name' | 'name+grade' | 'rasporedi-only' | 'sdnevnik-only';

export interface SdnRecord {
    id: number;
    name: string;
    grade: string | null;
    rasporediStudentId: string;
}

export interface CanonicalStudent {
    publicId: string;
    name: string;
    grade: string | null;
    sdnevnikId: number | null;
    matchedBy: MatchTier;
    idWasGenerated: boolean;
}

export function norm(value: unknown): string {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
}

/**
 * Strips the grade prefix ("IV-а - Име") and any trailing category suffix
 * ("Име (над.)") so a Rasporedi display name can be compared with the plain
 * name S-Dnevnik stores.
 */
export function bareName(value: unknown): string {
    let n = String(value ?? '');
    const i = n.indexOf(' - ');
    if (i > -1 && i <= 10) n = n.slice(i + 3);
    n = n.replace(/\s*\([^)]*\)\s*$/, '');
    return norm(n);
}

export function normGrade(value: unknown): string {
    return norm(String(value ?? '').replace(/[()]/g, '').replace(/\.$/, ''));
}

/**
 * „АНА ТЕСТОВА" -> „Ана Тестова". Everything else is left exactly alone.
 *
 * The school's workbook types the staff in capitals, so every screen that
 * shows a teacher shouted — while `Podatoci.html` title-cases a name as it
 * saves it. That is two renderings of one fact, decided by which screen last
 * pressed a button: the twenty-one teachers imported from the workbook were
 * in capitals and the one somebody had edited was not. Worse, the unique key
 * on `teachers.name` is the exact string, so a re-import after that edit
 * would have inserted a SECOND row for the same person.
 *
 * Only an ENTIRELY uppercase name is changed. Any lower-case letter at all
 * means a person wrote it and a person's spelling wins — „Ѓорѓи МОЈСОВ" stays
 * as typed, and so does an acronym somebody meant.
 *
 * Kept identical to `personName` in `Podatoci.html`, which cannot import this
 * one: the app is a single file that must keep working with no server (rule
 * 4). Any change here has to be made there too — `reconcile.test.ts` pins the
 * cases that matter.
 */
export function personName(value: unknown): string {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    const letters = clean.replace(/[^\p{L}]/gu, '');
    if (!letters || letters !== letters.toLocaleUpperCase('mk-MK')) return clean;
    return clean.toLocaleLowerCase('mk-MK').replace(
        /(^|[\s\-‐‑–—'’])(\p{L})/gu,
        (_, before: string, letter: string) => before + letter.toLocaleUpperCase('mk-MK')
    );
}

/**
 * Mirrors stableStudentIdForName() in Rasporedi v5.0 byte for byte, so an id
 * generated here is identical to the one the app generates for the same name.
 * Without this, importing a legacy export would invent ids that diverge from
 * the ones the app assigns on its next load.
 */
export function stableStudentIdForName(name: string): string {
    const text = String(name || '').normalize('NFKC').toLocaleLowerCase('mk-MK').trim();
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a ^= c; a = Math.imul(a, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ c) >>> 0;
    }
    return `RS-${a.toString(36)}-${b.toString(36)}`;
}

export function asText(value: unknown): string | null {
    const s = value == null ? '' : String(value).trim();
    return s ? s : null;
}

/**
 * Verbatim text — never trimmed. Used for the dossier, where the content is
 * what a therapist typed: trailing newlines and spacing are theirs, not noise
 * for us to tidy away. asText() stays for identifiers and codes, where
 * trimming is what you want.
 */
export function asRawText(value: unknown): string | null {
    if (value == null) return null;
    const s = String(value);
    return s.length ? s : null;
}

/** Dates are ISO in every export seen so far; anything else becomes NULL. */
export function isoDate(value: unknown): string | null {
    const s = String(value ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

/** Attendance marks are a bare "present" string in some exports, an object in others. */
export function attendanceStatus(record: unknown): 'present' | 'absent' | null {
    const raw = typeof record === 'string' ? record : (record && typeof record === 'object' ? (record as any).status : '');
    const s = String(raw || '').trim().toLowerCase();
    return s === 'present' || s === 'absent' ? s : null;
}

export function looksLikeRasporedi(payload: any): boolean {
    const body = payload?.rasporedi ?? payload;
    return Array.isArray(body?.students) && body.students.some((s: unknown) => typeof s === 'string');
}

export function looksLikeDiary(payload: any): boolean {
    return Boolean(payload && (payload.attendance || payload.plans || payload.studentProgress || payload.student_records));
}

export function toSdnRecords(list: any[], report: Report): SdnRecord[] {
    const out: SdnRecord[] = [];
    for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        const id = Number(s.id);
        if (!Number.isFinite(id)) {
            report.problems.push(`S-Dnevnik record without a numeric id skipped: ${String(s.name || '').slice(0, 40)}`);
            continue;
        }
        out.push({
            id,
            name: String(s.name || '').trim(),
            grade: asText(s.grade),
            rasporediStudentId: String(s.rasporediStudentId || '').trim()
        });
    }
    return out;
}

export function reconcile(base: any, sdnRecords: SdnRecord[], report: Report): CanonicalStudent[] {
    const meta = (base?.studentMeta && typeof base.studentMeta === 'object') ? base.studentMeta : {};
    const rasporediNames: string[] = Array.isArray(base?.students)
        ? base.students.filter((s: unknown) => typeof s === 'string' && s && !PLACEHOLDERS.has(s))
        : [];

    const byBridgeId = new Map<string, SdnRecord>();
    const byExact = new Map<string, SdnRecord[]>();
    const byBare = new Map<string, SdnRecord[]>();
    for (const rec of sdnRecords) {
        if (rec.rasporediStudentId) byBridgeId.set(rec.rasporediStudentId, rec);
        for (const [map, key] of [[byExact, norm(rec.name)], [byBare, bareName(rec.name)]] as const) {
            if (!key) continue;
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(rec);
        }
    }

    const bareCount = new Map<string, number>();
    for (const n of rasporediNames) {
        const k = bareName(n);
        bareCount.set(k, (bareCount.get(k) || 0) + 1);
    }

    const canonical: CanonicalStudent[] = [];
    const usedPublicIds = new Map<string, string>();
    const usedSdnIds = new Map<number, string>();
    const consumedSdn = new Set<number>();

    for (const name of rasporediNames) {
        const existingId = asText(meta[name]?.studentId) ?? asText(meta[name]?.rasporediStudentId);
        const publicId = existingId ?? stableStudentIdForName(name);
        const idWasGenerated = !existingId;

        if (usedPublicIds.has(publicId)) {
            report.problems.push(`Duplicate student id "${publicId}" for both "${usedPublicIds.get(publicId)}" and "${name}" — second skipped.`);
            continue;
        }

        const gradeFromMeta = asText(meta[name]?.grade);
        let match: SdnRecord | undefined;
        let tier: MatchTier = 'rasporedi-only';

        const bridge = byBridgeId.get(publicId);
        const exact = (byExact.get(norm(name)) || []).filter((r) => !consumedSdn.has(r.id));
        const bare = (byBare.get(bareName(name)) || []).filter((r) => !consumedSdn.has(r.id));

        if (bridge && !consumedSdn.has(bridge.id)) {
            match = bridge;
            tier = 'bridge-id';
        } else if (exact.length === 1) {
            match = exact[0];
            tier = 'exact-name';
        } else if (bare.length >= 1) {
            const rasporediShare = bareCount.get(bareName(name)) || 1;
            if (bare.length === 1 && rasporediShare === 1) {
                match = bare[0];
                tier = 'bare-name';
            } else {
                const g = normGrade(gradeFromMeta);
                const narrowed = bare.filter((r) => normGrade(r.grade) === g && g !== '');
                if (narrowed.length === 1) {
                    match = narrowed[0];
                    tier = 'name+grade';
                } else {
                    report.problems.push(`"${name}" is ambiguous against S-Dnevnik (${bare.length} candidate(s) with the same name, ${rasporediShare} Rasporedi student(s) share it) — imported WITHOUT an S-Dnevnik link.`);
                }
            }
        }

        let sdnevnikId: number | null = null;
        if (match) {
            if (usedSdnIds.has(match.id)) {
                report.problems.push(`S-Dnevnik id ${match.id} would link to both "${usedSdnIds.get(match.id)}" and "${name}" — link dropped for "${name}".`);
                tier = 'rasporedi-only';
            } else {
                sdnevnikId = match.id;
                usedSdnIds.set(match.id, name);
                consumedSdn.add(match.id);
                if (tier === 'bare-name' || tier === 'name+grade') {
                    report.notes.push(`${tier}: "${name}" ↔ S-Dnevnik #${match.id} "${match.name}" (${match.grade || 'no grade'})`);
                }
            }
        }

        usedPublicIds.set(publicId, name);
        canonical.push({
            publicId, name,
            grade: gradeFromMeta ?? (match ? match.grade : null),
            sdnevnikId, matchedBy: tier, idWasGenerated
        });
    }

    for (const rec of sdnRecords) {
        if (consumedSdn.has(rec.id)) continue;
        const publicId = rec.rasporediStudentId || `sdn-${rec.id}`;
        if (usedPublicIds.has(publicId)) {
            report.problems.push(`S-Dnevnik "${rec.name}" (id ${rec.id}) collides with existing id "${publicId}" — skipped.`);
            continue;
        }
        usedPublicIds.set(publicId, rec.name);
        report.notes.push(`S-Dnevnik only: "${rec.name}" (id ${rec.id}) has no Rasporedi counterpart — imported as "${publicId}".`);
        canonical.push({
            publicId, name: rec.name, grade: rec.grade,
            sdnevnikId: rec.id, matchedBy: 'sdnevnik-only',
            idWasGenerated: !rec.rasporediStudentId
        });
    }

    return canonical;
}

/* ── who is still enrolled ────────────────────────────────────────────────
 *
 * A student leaving is an EVENT, and S-Dnevnik is the only place that knows
 * it happened: the therapist archives them there. Everything else — this
 * database, Pregled-Baza, rollover-year — used to decide for itself, which is
 * why they disagreed. They are readers now.
 *
 * "Missing from the payload" is NOT the same as "left the school": an app that
 * has not pulled yet is also missing everyone. Only an explicit archive entry
 * counts.
 */

export interface ArchivedStudent {
    sdnevnikId: number | null;
    name: string;
    grade: string | null;
    year: string | null;
    at: string | null;
    reason: string | null;
}

/** Pulls the archive out of whichever payload shape this is. */
export function readArchive(payload: any): ArchivedStudent[] {
    const raw = asArray(payload?.archivedStudents).length
        ? asArray(payload.archivedStudents)
        : asArray(payload?.sdnevnik?.archivedStudents);

    return raw.map((s: any) => {
        const meta = (s && typeof s._archived === 'object') ? s._archived : {};
        const id = Number(s?.id);
        return {
            sdnevnikId: Number.isFinite(id) ? id : null,
            name: asText(s?.name) ?? '',
            grade: asText(s?.grade),
            year: asText(meta.year),
            at: asText(meta.at),
            reason: asText(meta.reason)
        };
    }).filter((a) => a.name || a.sdnevnikId != null);
}

/**
 * Marks the archived inactive and everyone else active.
 *
 * Identity follows the same rule as everywhere else in this file: the numeric
 * S-Dnevnik id when there is one, otherwise an EXACT single name match. Two
 * students share a name in this school, so an ambiguous name is reported and
 * skipped — never guessed. Deactivating the wrong child is not a small error.
 */
export async function applyStudentStatus(
    client: any,
    canonical: CanonicalStudent[],
    archived: ArchivedStudent[],
    report: Report
): Promise<{ archived: number; restored: number }> {

    const archivedSdnIds = new Set(archived.map((a) => a.sdnevnikId).filter((n) => n != null));
    const archivedNames = new Set(archived.map((a) => norm(a.name)).filter(Boolean));

    // How many students on this roster answer to each name. There are two
    // „Јана Пробева" here, in different grades.
    const nameCount = new Map<string, number>();
    for (const c of canonical) {
        const k = norm(c.name);
        if (k) nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
    }
    const sharedArchivedNames = [...archivedNames].filter((n) => (nameCount.get(n) ?? 0) > 1);

    /**
     * Is this student one the diary has archived?
     *
     * This used to be `matched by id OR matched by name`, and the OR was wrong
     * in the one case the project already knows about. Archive one „Јана
     * Пробева" and the OTHER one — a different child, in a different grade,
     * still enrolled — matched on the name: excluded from the active list, so
     * never restored, and reported to the therapist as archived-but-still-listed.
     * A false alarm about a real child is worse than no alarm.
     *
     * So: when a student's identity is KNOWN, the id decides and the name adds
     * nothing. The name is only evidence for someone with no diary link at all,
     * and then only if it cannot mean two people — rule 2.
     */
    const alsoArchived = (c: CanonicalStudent) => {
        if (c.sdnevnikId != null) return archivedSdnIds.has(c.sdnevnikId);
        const k = norm(c.name);
        if (!archivedNames.has(k)) return false;
        return (nameCount.get(k) ?? 0) <= 1;
    };

    if (sharedArchivedNames.length) {
        report.notes.push(
            `${sharedArchivedNames.length} archived name(s) are shared by more than one student on the roster ` +
            `(${sharedArchivedNames.slice(0, 5).join(', ')}). Only the diary id decides who left; grade tells them apart.`
        );
    }

    // Anyone the roster still lists, and the diary has NOT archived, is here.
    // A student in both lists is left to the archive below: the diary owns
    // this fact, so a stale Rasporedi entry must not resurrect them each save.
    const active = canonical.filter((c) => !alsoArchived(c));

    // That overlap is the conflict the therapist actually hits — archived in
    // the diary, still on the Rasporedi list. Reported here because this is
    // the only place both sides have already been reconciled to one identity;
    // matching raw payload shapes would mean re-doing that badly.
    const stillListed = canonical.filter(alsoArchived);
    if (stillListed.length) {
        report.problems.push(
            `${stillListed.length} archived student(s) are still on the Rasporedi list ` +
            `(${stillListed.slice(0, 5).map((s) => s.name).join(', ')}). They stay archived — the diary decides. ` +
            `Remove them in Rasporedi, or restore them in S-Dnevnik.`
        );
    }

    let restored = 0;
    if (active.length) {
        const { rowCount } = await client.query(
            `UPDATE students
                SET active = true, left_at = NULL, left_year = NULL, left_reason = NULL, updated_at = now()
              WHERE public_id = ANY($1::text[]) AND active = false`,
            [active.map((c) => c.publicId)]
        );
        restored = rowCount ?? 0;
    }

    let marked = 0;
    for (const a of archived) {
        let id: number | null = null;

        if (a.sdnevnikId != null) {
            const { rows } = await client.query('SELECT id FROM students WHERE sdnevnik_id = $1', [a.sdnevnikId]);
            if (rows.length) id = rows[0].id;
        }
        if (id == null && a.name) {
            const { rows } = await client.query('SELECT id FROM students WHERE lower(btrim(name)) = $1', [norm(a.name)]);
            if (rows.length === 1) id = rows[0].id;
            else if (rows.length > 1) {
                report.problems.push(
                    `Archived student "${a.name}" matches ${rows.length} rows and has no S-Dnevnik id — left active rather than deactivating the wrong one.`
                );
                continue;
            }
        }
        if (id == null) continue;   // never seen here; nothing to deactivate

        const { rowCount } = await client.query(
            `UPDATE students
                SET active = false, left_at = $2, left_year = $3, left_reason = $4, updated_at = now()
              WHERE id = $1 AND (active OR left_year IS DISTINCT FROM $3)`,
            [id, a.at, a.year, a.reason]
        );
        marked += rowCount ?? 0;
    }

    if (marked) report.notes.push(`${marked} student(s) marked as having left.`);
    if (restored) report.notes.push(`${restored} student(s) returned to the roster.`);
    return { archived: marked, restored };
}

/**
 * Records that point at nobody.
 *
 * Reported, never repaired here. A schedule slot is a plan and may be dropped
 * by the app; progress and attendance are RECORDS of work that happened, and
 * deleting one to tidy a report would destroy the only evidence of a session.
 * The therapist decides, so all this does is make the problem visible.
 */
export function checkRosterConsistency(payload: any, archived: ArchivedStudent[], report: Report) {
    const sdn = looksLikeDiary(payload) ? payload : payload?.sdnevnik;
    if (!sdn) return;

    const living = new Set<string>();
    asArray(sdn.students).forEach((s: any) => { if (s?.id != null) living.add(String(s.id)); });

    // Leaving one therapist's current caseload is not leaving the school.
    // These students keep their clinical history and can be added back later,
    // so their records are represented even though they are not in `students`.
    const formerCaseload = new Set<string>();
    asArray(sdn.formerCaseloadStudents).forEach((s: any) => {
        if (s?.id != null) formerCaseload.add(String(s.id));
    });

    const gone = new Map<string, string>();
    archived.forEach((a) => { if (a.sdnevnikId != null) gone.set(String(a.sdnevnikId), a.name); });

    const orphanOwners = new Set<string>();
    const scan = (bag: any, depth: number) => {
        Object.keys(bag || {}).forEach((key) => {
            if (depth === 0) { scan(bag[key], 1); return; }
            if (!living.has(key) && !formerCaseload.has(key) && !gone.has(key)) orphanOwners.add(key);
        });
    };
    if (sdn.attendance && typeof sdn.attendance === 'object') scan(sdn.attendance, 0);
    Object.keys(sdn.studentProgress || {}).forEach((sid) => {
        if (!living.has(sid) && !formerCaseload.has(sid) && !gone.has(sid)) orphanOwners.add(sid);
    });

    if (orphanOwners.size) {
        report.problems.push(
            `Attendance or progress belongs to ${orphanOwners.size} student id(s) that are neither active, former caseload, nor archived ` +
            `(${[...orphanOwners].slice(0, 5).join(', ')}). Nothing was deleted — restore the student, or export a backup before clearing it.`
        );
    }
}

/** Resolves the school year every write belongs to. */
async function currentYearId(client: any): Promise<number> {
    const { rows } = await client.query('SELECT id FROM school_years WHERE is_current');
    if (rows.length === 0) throw new Error('No current school year is set (see migration 007).');
    return rows[0].id;
}

/**
 * Writes roster, therapists, schedule and (when present) the diary
 * collections. The caller owns the transaction.
 */
/**
 * Writes one student, and survives the fact that a student has TWO unique keys.
 *
 * The projection used to be a single `INSERT … ON CONFLICT (public_id)`. That
 * statement only knows how to resolve a clash on `public_id`; a clash on
 * `sdnevnik_id` is not a conflict it was told to expect, so PostgreSQL raises
 * `students_sdnevnik_id_key` and — because the whole projection runs in one
 * transaction — every table is rolled back. The blob still saves, so the apps
 * report success while the relational side quietly stays at yesterday. Observed
 * on a real machine, not hypothesised.
 *
 * It happens whenever the SAME child arrives under a DIFFERENT public_id: the
 * app regenerated the id from the name because `studentMeta` had no stored one,
 * while S-Dnevnik's bridge id still matched. Within one payload `reconcile`
 * already refuses to let two students share an `sdnevnikId`; this is the case
 * across saves, which nothing was checking.
 *
 * WHICH ID WINS, and why it is not a guess:
 *
 *   - `idWasGenerated === false` means the app carried a real stored id. It is
 *     authoritative, so the existing row's public_id is moved to it and every
 *     term, mark and dossier hanging off the row id follows for free.
 *   - `idWasGenerated === true` means the id was computed from the name because
 *     nothing better was available. A guess must not overwrite a stored fact,
 *     so the database keeps its public_id and the row is used as it stands.
 *
 * And when BOTH ids already exist on DIFFERENT rows, this refuses. Merging two
 * rows would fold two people together with no way back — rule 2: ambiguity is
 * reported and left alone, never merged.
 */
async function upsertStudentRow(
    client: any, s: CanonicalStudent, rosterOwned: boolean, report: Report
): Promise<number | null> {
    const bySdn = s.sdnevnikId == null ? null : (await client.query(
        'SELECT id, public_id FROM students WHERE sdnevnik_id = $1', [s.sdnevnikId]
    )).rows[0] ?? null;
    const byPublic = (await client.query(
        'SELECT id, public_id FROM students WHERE public_id = $1', [s.publicId]
    )).rows[0] ?? null;

    if (bySdn && byPublic && bySdn.id !== byPublic.id) {
        report.problems.push(
            `"${s.name}" matches two different rows — diary id ${s.sdnevnikId} is on "${bySdn.public_id}" ` +
            `while "${s.publicId}" is another student. Left untouched; a human has to say which is which.`
        );
        return null;
    }

    const existing = bySdn ?? byPublic;

    if (!existing) {
        const { rows } = await client.query(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [s.publicId, s.sdnevnikId, s.name, s.grade]
        );
        return rows[0].id;
    }

    // The row was found by the diary link but is filed under another public_id.
    const movePublicId = existing.public_id !== s.publicId && !s.idWasGenerated;
    if (existing.public_id !== s.publicId && s.idWasGenerated) {
        report.notes.push(
            `"${s.name}" arrived with an id computed from the name ("${s.publicId}") while the database ` +
            `has "${existing.public_id}". Kept the stored one — a generated id does not overrule a saved one.`
        );
    }

    await client.query(
        rosterOwned
            ? `UPDATE students
                  SET public_id = CASE WHEN $2::boolean THEN $3 ELSE public_id END,
                      sdnevnik_id = COALESCE($4, sdnevnik_id),
                      updated_at = now()
                WHERE id = $1`
            : `UPDATE students
                  SET public_id = CASE WHEN $2::boolean THEN $3 ELSE public_id END,
                      sdnevnik_id = COALESCE($4, sdnevnik_id),
                      name = $5, grade = $6,
                      updated_at = now()
                WHERE id = $1`,
        rosterOwned
            ? [existing.id, movePublicId, s.publicId, s.sdnevnikId]
            : [existing.id, movePublicId, s.publicId, s.sdnevnikId, s.name, s.grade]
    );
    return existing.id;
}

/**
 * Who is allowed to decide what, when a whole document arrives.
 *
 * `rosterOwned` is the newer of the two and it is NOT announced by the app.
 * `Podatoci.html` writes names, classes, student kinds and caseloads straight
 * to the database, and a browser that has been open since this morning holds
 * the roster as it was then — so a save from it would silently undo an
 * afternoon's corrections. The apps cannot announce a screen they know nothing
 * about, so the SERVER decides: anything arriving through
 * `PUT /api/state/:app` may add a person and may not restate one.
 *
 * A JSON FILE import is deliberately exempt. That is the escape hatch of
 * rule 4 — open the old app with yesterday's export and keep working — and it
 * has to restore everything, including the names.
 */
export interface ProjectionOwnership {
    /** True for an API save: names, grades, kinds and caseloads have their own screen. */
    rosterOwned?: boolean;
}

export async function writeAll(
    client: any, canonical: CanonicalStudent[], base: any, sdnDoc: any, report: Report,
    ownership: ProjectionOwnership = {}
) {
    const schoolYearId = await currentYearId(client);

    /**
     * The app told us it writes its own facts one at a time (Stage A/B). That
     * changes what a whole-document save is allowed to decide here.
     *
     * A browser holds the roster as it was when that tab was opened. If the
     * blob may still set name and grade, then a colleague's rename made at
     * 10:00 through PATCH is silently undone by anyone pressing „Зачувај на
     * сервер" at 10:05 with a tab opened at 09:00 — with no `expected` check,
     * because a document has nothing to check. That is the same overwrite
     * per-cell writes exist to stop, merely surviving in the roster instead of
     * the schedule.
     *
     * So under this marker the document may only ADD, never restate: new
     * students and therapists are created (additive is always safe), the
     * S-Dnevnik id is still linked because that is S-Dnevnik's fact and not
     * Rasporedi's, and name, grade and caseloads are left to the endpoints
     * that own them.
     */
    // Two separate questions that used to be one. The schedule is skipped only
    // when the app says it writes cells itself; the roster is protected
    // whenever a screen other than this document owns it.
    const scheduleOwned = Boolean((base?.unifiedMeta as any)?.slotWrites);
    const rosterOwned = scheduleOwned || Boolean(ownership.rosterOwned);

    const studentIdByName = new Map<string, number>();
    const studentIdBySdnId = new Map<number, number>();
    for (const s of canonical) {
        const rowId = await upsertStudentRow(client, s, rosterOwned, report);
        if (rowId == null) continue;                 // ambiguous — reported, left alone
        studentIdByName.set(norm(s.name), rowId);
        if (s.sdnevnikId != null) studentIdBySdnId.set(s.sdnevnikId, rowId);
        const rows = [{ id: rowId }];

        await client.query(
            rosterOwned
                ? `INSERT INTO student_enrollments (student_id, school_year_id, grade)
                   VALUES ($1, $2, $3) ON CONFLICT (student_id, school_year_id) DO NOTHING`
                : `INSERT INTO student_enrollments (student_id, school_year_id, grade)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (student_id, school_year_id) DO UPDATE SET grade = EXCLUDED.grade`,
            [rows[0].id, schoolYearId, s.grade]
        );
    }

    const therapistNames: string[] = Array.isArray(base?.therapists)
        ? base.therapists.filter((t: unknown) => typeof t === 'string' && t.trim())
        : [];
    const therapistStudents = (base?.therapistStudents && typeof base.therapistStudents === 'object')
        ? base.therapistStudents : {};

    const therapistIdByName = new Map<string, number>();
    for (const t of therapistNames) {
        const { rows } = await client.query(
            `INSERT INTO therapists (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [t]
        );
        therapistIdByName.set(norm(t), rows[0].id);

        // Wiping the caseload and rebuilding it from the document is the same
        // whole-document overwrite in miniature: one browser's ticked boxes
        // would replace everybody's.
        //
        // When the roster has a screen of its own, the document is left out of
        // the caseload ENTIRELY — not merely stopped from clearing it. Add-only
        // sounds safe and is not: a box UNticked in Podatoci is put straight
        // back by the next save from a tab that still remembers it, and an
        // undone correction is worse than a refused one because nobody is told.
        if (rosterOwned) continue;

        await client.query(
            'DELETE FROM therapist_students WHERE school_year_id = $1 AND therapist_id = $2',
            [schoolYearId, rows[0].id]
        );
        for (const studentName of asArray(therapistStudents[t])) {
            if (!studentName || PLACEHOLDERS.has(studentName)) continue;
            const studentId = studentIdByName.get(norm(studentName));
            if (!studentId) {
                report.problems.push(`Therapist "${t}" references unknown student "${studentName}" — link skipped.`);
                continue;
            }
            await client.query(
                `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [schoolYearId, rows[0].id, studentId]
            );
        }
    }

    // When Rasporedi writes cells individually (PUT /api/schedule/slot), the
    // week in the database is AHEAD of the copy in any one browser: it holds
    // every therapist's edits, not just this one's. Projecting the blob would
    // then replace all of it with one person's view — precisely the overwrite
    // per-cell writes exist to prevent. The app says so with a marker and the
    // schedule section is skipped entirely; the roster is add-only (above).
    if (scheduleOwned) {
        report.notes.push('Schedule skipped: this app writes cells individually, so the database holds the newer week.');
    }
    if (rosterOwned) {
        report.notes.push('Roster add-only: names, classes, kinds and caseloads come from their own screen, not from this document.');
    }

    // Replacing the week wholesale is right when a real schedule arrives, and
    // catastrophic when an empty one does — an app opened on a fresh device
    // holds no schedule until it pulls, and saving first would erase the year.
    // So an empty schedule never replaces a non-empty one.
    const incomingAssignments = asArray(base?.schedule).reduce((n: number, slot: any) => {
        const a = (slot && typeof slot.assignments === 'object') ? slot.assignments : {};
        return n + Object.values(a).filter((v) => v && !PLACEHOLDERS.has(String(v))).length;
    }, 0);

    if (!scheduleOwned && Array.isArray(base?.schedule) && incomingAssignments === 0) {
        const existing = await client.query(
            'SELECT count(*)::int AS n FROM schedule_slots WHERE school_year_id = $1', [schoolYearId]
        );
        if (existing.rows[0].n > 0) {
            report.problems.push(`Payload carries an empty schedule while ${existing.rows[0].n} slots exist for this year — schedule left untouched. Pull from the server before saving.`);
        }
    }

    if (!scheduleOwned && Array.isArray(base?.schedule) && incomingAssignments > 0) {
        await client.query('DELETE FROM schedule_slots WHERE school_year_id = $1', [schoolYearId]);
        const missing = new Set<string>();
        for (const slot of base.schedule) {
            if (!slot || typeof slot !== 'object') continue;
            const day = String(slot.day || '').trim();
            const time = String(slot.time || '').trim();
            if (!day || !time) continue;
            const order = DAY_ORDER[norm(day)] ?? 0;
            const assignments = (slot.assignments && typeof slot.assignments === 'object') ? slot.assignments : {};

            for (const [therapistName, studentRaw] of Object.entries(assignments)) {
                const studentName = String(studentRaw || '').trim();
                if (!studentName || PLACEHOLDERS.has(studentName)) continue;
                const therapistId = therapistIdByName.get(norm(therapistName));
                const studentId = studentIdByName.get(norm(studentName));
                if (!therapistId) { missing.add(`therapist "${therapistName}"`); continue; }
                if (!studentId) { missing.add(`student "${studentName}"`); continue; }
                await client.query(
                    `INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (school_year_id, day, time_slot, therapist_id)
                     DO UPDATE SET student_id = EXCLUDED.student_id`,
                    [schoolYearId, day, order, time, therapistId, studentId]
                );
            }
        }
        missing.forEach((m) => report.problems.push(`Schedule references unknown ${m} — slot skipped.`));
    }

    if (sdnDoc) await writeDiary(client, sdnDoc, studentIdBySdnId, report);
}

/** Diary-only projection: used when S-Dnevnik saves on its own. */
export async function writeDiaryForKnownStudents(client: any, sdnDoc: any, report: Report) {
    const { rows } = await client.query('SELECT id, sdnevnik_id FROM students WHERE sdnevnik_id IS NOT NULL');
    const map = new Map<number, number>(rows.map((r: any) => [Number(r.sdnevnik_id), r.id]));

    const unknown = asArray(sdnDoc.students).filter((s: any) => !map.has(Number(s?.id))).length;
    if (unknown) {
        report.problems.push(`${unknown} diary student(s) are not linked to the roster yet — save Rasporedi once so the roster is projected first.`);
    }
    await writeDiary(client, sdnDoc, map, report);
}

/**
 * Which of the diary's collections now have endpoints of their own.
 *
 * Rasporedi announces the same thing with `unifiedMeta.slotWrites`, a boolean,
 * because it moved in one step. S-Dnevnik moves collection by collection, so a
 * boolean would mean a new flag per stage and a projection full of them. A list
 * says exactly what has moved and nothing about what has not.
 *
 * It lives in `_meta` deliberately: the app already strips `_meta` before
 * fingerprinting a payload, so the marker cannot make the app believe its own
 * state changed. Absent means "nothing has moved", so every existing export and
 * both old apps project exactly as before -- rule 4.
 */
export function rowWritten(sdnDoc: any, collection: string): boolean {
    const list = (sdnDoc?._meta as any)?.rowWrites;
    return Array.isArray(list) && list.includes(collection);
}

/** Plans, activities, per-student progress, dossiers, scales, triage, audiograms, attendance. */
export async function writeDiary(client: any, sdnDoc: any, studentIdBySdnId: Map<number, number>, report: Report) {
    /**
     * Stage D. When the diary writes attendance one mark at a time, a
     * whole-document save must stop deciding attendance -- otherwise the
     * document wins, and it holds one machine's view of the year.
     *
     * The trap is the same one Stage A hit and worse here, because the diary is
     * carried between two machines rather than two tabs: the browser at home
     * holds the marks as they were when it last pulled, so saving it at 20:00
     * would quietly undo every mark made at school that afternoon through
     * PUT /api/diary/attendance -- with no `expected` to catch it, because a
     * document has nothing to check against.
     *
     * Progress goes with attendance rather than having a marker of its own,
     * because it is not a separate fact: it is derived from attendance, here
     * and in the app both (see lib/progress.ts). Letting the document restate
     * progress while attendance is written per mark would put the derived value
     * and its input back in disagreement, which is the whole thing this stage
     * removes.
     *
     * The payload still CARRIES both. It has to: the JSON export is a
     * compatibility contract and the old single-file apps must keep loading
     * what this system produces. It simply stops being what the tables believe.
     */
    const perMarkAttendance = rowWritten(sdnDoc, 'attendance');
    /**
     * Stage E. Same reasoning one collection along: when the diary writes its
     * week a slot at a time, the document must stop deciding the week.
     *
     * Sharper here than for attendance, because the week is REPLACED wholesale
     * below (delete the year, re-insert). A save from the machine that has not
     * pulled would not merely fail to add — it would take the other machine's
     * terms out and put its own back, in one statement.
     *
     * `scheduleHistory` moves with it rather than having a marker of its own:
     * a snapshot is a copy of the week, so leaving the document in charge of
     * the copies while the original is written per slot puts the two back in
     * disagreement.
     */
    const perSlotSchedule = rowWritten(sdnDoc, 'schedule');
    /**
     * Stage F. The dossier, assessments, scale templates, triage tests and
     * audiograms, which the diary owns outright — Rasporedi never sees them.
     *
     * One marker for the five, because they are edited as one body of work and
     * reference each other: an assessment points at a scale template, and both
     * hang off a student whose dossier is beside them. Moving them apart would
     * mean a save that restates half of a screen the therapist has open.
     */
    const perRecordWrites = rowWritten(sdnDoc, 'records');
    const planIdBySdnId = new Map<number, number>();
    const activityIdByPlanPosition = new Map<string, number>();

    for (const p of asArray(sdnDoc.plans)) {
        const sdnPlanId = Number(p?.id);
        const name = asText(p?.name);
        if (!Number.isFinite(sdnPlanId) || !name) { report.problems.push('Plan without a usable id/name skipped.'); continue; }
        const { rows } = await client.query(
            `INSERT INTO plans (sdnevnik_id, name) VALUES ($1, $2)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [sdnPlanId, name]
        );
        planIdBySdnId.set(sdnPlanId, rows[0].id);

        const activities = asArray(p?.activities);
        for (let i = 0; i < activities.length; i++) {
            const label = asText(activities[i]);
            if (!label) continue;
            const res = await client.query(
                `INSERT INTO plan_activities (plan_id, position, label) VALUES ($1, $2, $3)
                 ON CONFLICT (plan_id, position) DO UPDATE SET label = EXCLUDED.label
                 RETURNING id`,
                [rows[0].id, i, label]
            );
            activityIdByPlanPosition.set(`${rows[0].id}:${i}`, res.rows[0].id);
        }
    }

    for (const s of asArray(sdnDoc.students)) {
        const studentId = studentIdBySdnId.get(Number(s?.id));
        const planId = planIdBySdnId.get(Number(s?.planId));
        if (!studentId || !planId) continue;
        await client.query('UPDATE students SET plan_id = $1 WHERE id = $2', [planId, studentId]);
    }

    const missingPlans = new Set<string>();
    let dangling = 0;
    for (const [sid, byPlan] of Object.entries(perMarkAttendance ? {} : (sdnDoc.studentProgress || {}))) {
        const studentId = studentIdBySdnId.get(Number(sid));
        if (!studentId) continue;
        for (const [sdnPlanId, entries] of Object.entries(byPlan as Record<string, any>)) {
            const planId = planIdBySdnId.get(Number(sdnPlanId));
            if (!planId) { missingPlans.add(sdnPlanId); continue; }

            const wanted: number[] = [];
            for (const e of asArray(entries)) {
                const position = Number(e?.index);
                if (!Number.isFinite(position)) continue;
                const activityId = activityIdByPlanPosition.get(`${planId}:${position}`);
                if (!activityId) { dangling++; continue; }
                wanted.push(activityId);
                await client.query(
                    `INSERT INTO student_plan_progress (student_id, activity_id, completed_on, time_slot)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (student_id, activity_id)
                     DO UPDATE SET completed_on = EXCLUDED.completed_on, time_slot = EXCLUDED.time_slot`,
                    [studentId, activityId, asText(e?.date), asText(e?.time)]
                );
            }

            /**
             * Take away what this list no longer claims.
             *
             * This was an upsert and nothing else, so student_plan_progress
             * could only ever grow: unticking a session in the diary shrank the
             * app's list and left the row here, and the overview then reported
             * more activities completed than the therapist's own screen shows.
             * Found by the Stage D control case, which credited an activity per
             * mark and then watched the document fail to take it back.
             *
             * Scoped to (this student, this plan) and only where the document
             * actually carries a list for that pair. Absence still says nothing
             * — an app that has not pulled yet is missing everything, and a
             * different plan's history is not this list's to discard.
             */
            await client.query(
                `DELETE FROM student_plan_progress
                  WHERE student_id = $1
                    AND activity_id IN (SELECT id FROM plan_activities WHERE plan_id = $2)
                    AND NOT (activity_id = ANY($3::int[]))`,
                [studentId, planId, wanted]
            );
        }
    }
    missingPlans.forEach((p) => report.problems.push(`Progress refers to plan ${p}, which is not in the payload — skipped.`));
    if (dangling) report.problems.push(`${dangling} progress entries point past the end of their plan's activity list — skipped.`);

    /**
     * The clinical records.
     *
     * Stage F moved the row-writing itself into lib/records.ts, because the
     * per-record endpoints now write the same rows and two implementations of
     * one mapping is the drift this project keeps paying for. What stays here
     * is what only a whole document can say: which records exist at all, and
     * therefore which of them are gone.
     */
    if (perRecordWrites) {
        report.notes.push('The clinical records come from /api/diary/record/* now — this document did not touch them.');
    } else {
        for (const r of asArray(sdnDoc.student_records)) {
            const studentId = studentIdBySdnId.get(Number(r?.id));
            if (!studentId) continue;
            await upsertDossier(client, studentId, r);
        }

        const templateIdBySdnId = new Map<string, number>();
        for (const t of asArray(sdnDoc.scaleTemplates)) {
            const id = await upsertScaleTemplate(client, t);
            if (id == null) { report.problems.push('Scale template without id/name skipped.'); continue; }
            templateIdBySdnId.set(asText(t?.id) as string, id);
        }

        let withoutTemplate = 0;
        for (const a of asArray(sdnDoc.assessments)) {
            const studentId = studentIdBySdnId.get(Number(a?.studentId));
            if (!studentId) continue;
            const templateId = templateIdBySdnId.get(asText(a?.scaleType) ?? '') ?? null;
            if (!templateId) withoutTemplate++;
            await upsertAssessment(client, studentId, templateId, a);
        }
        if (withoutTemplate) report.notes.push(`${withoutTemplate} assessment(s) reference a scale template that is not in the payload — kept without a template link.`);

        for (const t of asArray(sdnDoc.trijazenTestovi)) {
            const studentId = studentIdBySdnId.get(Number(t?.studentId));
            if (!studentId) continue;
            await upsertTriage(client, studentId, t);
        }

        /**
         * Audiograms: keyed now, so the list is RECONCILED instead of replaced.
         *
         * This used to be `DELETE FROM audiograms` followed by a re-insert of
         * everything, which was the only thing possible while the records had
         * no identity of their own (migration 013 gave them one). The rule it
         * implemented is kept exactly: an empty list still means "this document
         * has nothing to say about audiograms", not "there are none" — an app
         * that has not pulled yet is missing everything.
         *
         * Matching to a student runs against EVERY student on record, not just
         * those in this payload: audiograms routinely name children from earlier
         * years who have left the roster, and matching only the current diary
         * would strip their link on every save.
         */
        const audiograms = asArray(sdnDoc.audiograms);
        if (audiograms.length > 0) {
            const dbIdByBareName = new Map<string, number>();
            const allStudents = await client.query('SELECT id, name FROM students');
            for (const s of allStudents.rows) {
                const key = bareName(s.name);
                if (key && !dbIdByBareName.has(key)) dbIdByBareName.set(key, s.id);
            }
            for (const s of asArray(sdnDoc.students)) {
                const dbId = studentIdBySdnId.get(Number(s?.id));
                if (dbId) dbIdByBareName.set(bareName(s?.name), dbId);   // payload wins
            }

            const keptIds: string[] = [];
            const unmatched: string[] = [];
            for (const a of audiograms) {
                const subject = asText(a?.subjectName);
                if (!subject) continue;
                const studentId = dbIdByBareName.get(bareName(subject)) ?? null;
                if (!studentId) unmatched.push(subject);
                const id = await upsertAudiogram(client, a, studentId);
                if (id) keptIds.push(id);
            }
            await client.query(
                'DELETE FROM audiograms WHERE sdnevnik_id IS NULL OR NOT (sdnevnik_id = ANY($1::text[]))',
                [keptIds]
            );
            if (unmatched.length) {
                report.notes.push(`${unmatched.length} audiogram(s) name someone not in the roster — kept with the name, no student link: ${[...new Set(unmatched)].join(', ')}`);
            }
        }
    }

    // The diary's own weekly plan: { monday: [[studentId], …] }, where the
    // index is the slot number that attendance.slot_key refers to.
    if (!perSlotSchedule && sdnDoc.schedule && typeof sdnDoc.schedule === 'object' && !Array.isArray(sdnDoc.schedule)) {
        const yearRow = await client.query('SELECT id FROM school_years WHERE is_current');
        const yearId = yearRow.rows[0]?.id;
        if (yearId) {
            const hasAny = Object.values(sdnDoc.schedule).some((slots: any) =>
                asArray(slots).some((slot: any) => asArray(slot).length > 0));
            if (hasAny) {
                await client.query('DELETE FROM diary_schedule WHERE school_year_id = $1', [yearId]);
                for (const [day, slots] of Object.entries(sdnDoc.schedule)) {
                    const slotList = asArray(slots);
                    for (let position = 0; position < slotList.length; position++) {
                        const inSlot = asArray(slotList[position]);
                        for (let ordinal = 0; ordinal < inSlot.length; ordinal++) {
                            const studentId = studentIdBySdnId.get(Number(inSlot[ordinal]));
                            if (!studentId) continue;
                            await client.query(
                                `INSERT INTO diary_schedule (school_year_id, day, position, student_id, ordinal)
                                 VALUES ($1, $2, $3, $4, $5)
                                 ON CONFLICT (school_year_id, day, position, student_id)
                                 DO UPDATE SET ordinal = EXCLUDED.ordinal`,
                                [yearId, day, position, studentId, ordinal]
                            );
                        }
                    }
                }
            }

            for (const [weekOf, payload] of Object.entries(sdnDoc.scheduleHistory || {})) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) continue;
                await client.query(
                    `INSERT INTO diary_schedule_history (school_year_id, week_of, payload)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (school_year_id, week_of) DO UPDATE SET payload = EXCLUDED.payload`,
                    [yearId, weekOf, JSON.stringify(payload)]
                );
            }
        }
    }

    for (const l of asArray(sdnDoc.links)) {
        const name = asText(l?.name);
        const url = asText(l?.url);
        if (!name || !url) continue;
        await client.query(
            `INSERT INTO resource_links (sdnevnik_id, name, url) VALUES ($1, $2, $3)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url`,
            [Number.isFinite(Number(l?.id)) ? Number(l.id) : null, name, url]
        );
    }

    if (perSlotSchedule) {
        report.notes.push('The weekly plan and its snapshots come from /api/diary/schedule now — this document did not touch them.');
    }
    if (perMarkAttendance) {
        report.notes.push('Attendance and plan progress come from PUT /api/diary/attendance now — this document did not touch them.');
        return;
    }

    for (const [date, byStudent] of Object.entries(sdnDoc.attendance || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { report.problems.push(`Attendance key "${date}" is not a date — skipped.`); continue; }
        for (const [sid, bySlot] of Object.entries(byStudent as Record<string, any>)) {
            const studentId = studentIdBySdnId.get(Number(sid));
            if (!studentId) continue;
            for (const [slotKey, rec] of Object.entries(bySlot as Record<string, unknown>)) {
                const status = attendanceStatus(rec);
                if (!status) continue;
                // The time comes along now (migration 012). It is what tells a
                // merged term from two separate ones, and progress is counted
                // in sessions, not marks. Object shape only — a bare "present"
                // string has no time to carry.
                const time = (rec && typeof rec === 'object') ? asText((rec as any).time) : null;
                await client.query(
                    `INSERT INTO attendance (student_id, date, slot_key, status, time_slot)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (student_id, date, slot_key)
                     DO UPDATE SET status = EXCLUDED.status,
                                   time_slot = COALESCE(EXCLUDED.time_slot, attendance.time_slot)`,
                    [studentId, date, slotKey, status, time]
                );
            }
        }
    }
}

/**
 * Projects one app payload into the relational tables. Returns a short summary
 * the API can hand back to the app.
 */
export async function projectPayload(
    client: any, payload: any, ownership: ProjectionOwnership = {}
): Promise<{ report: Report; kind: string; students: number }> {
    const report = newReport();

    if (looksLikeRasporedi(payload)) {
        const base = payload?.rasporedi ?? payload;
        const sdnSection = payload?.sdnevnik;
        const sdnRecords = Array.isArray(sdnSection?.students) ? toSdnRecords(sdnSection.students, report) : [];
        const canonical = reconcile(base, sdnRecords, report);

        // A near-empty roster almost always means the app had not pulled yet,
        // not that everyone left the school. Store the blob, touch nothing.
        const existing = (await client.query('SELECT count(*)::int AS n FROM students')).rows[0].n;
        if (existing > 5 && canonical.length < existing / 2) {
            report.problems.push(`Payload lists ${canonical.length} students while the database holds ${existing} — projection skipped as a safeguard. Pull from the server before saving, or run the importer manually if this is intended.`);
            return { report, kind: 'rasporedi (skipped)', students: canonical.length };
        }
        // A Unified export's diary slice holds students and schedule only; the
        // clinical collections arrive when S-Dnevnik itself saves.
        //
        // The Stage D marker normally travels inside that slice, because
        // S-Dnevnik is what writes it. An exporter that put it at the top level
        // instead must still be honoured: projecting attendance out of a
        // document that has announced it no longer owns attendance is the exact
        // overwrite the marker exists to prevent, and where the announcement
        // was written is not a reason to allow it.
        let sdnForWrite = looksLikeDiary(sdnSection) ? sdnSection : null;
        if (sdnForWrite && rowWritten(payload, 'attendance') && !rowWritten(sdnForWrite, 'attendance')) {
            sdnForWrite = {
                ...sdnForWrite,
                _meta: { ...(sdnForWrite._meta || {}), rowWrites: (payload._meta as any).rowWrites }
            };
        }
        await writeAll(client, canonical, base, sdnForWrite, report, ownership);

        const archived = readArchive(payload);
        await applyStudentStatus(client, canonical, archived, report);
        checkRosterConsistency(payload, archived, report);

        return { report, kind: 'rasporedi', students: canonical.length };
    }

    if (looksLikeDiary(payload)) {
        await writeDiaryForKnownStudents(client, payload, report);

        // The diary is the owner of who has left, so its own save is the most
        // authoritative moment to apply it. Its roster stands in for canonical
        // here: these are the students it still considers enrolled.
        const archived = readArchive(payload);
        const roster: CanonicalStudent[] = asArray(payload.students)
            .filter((s: any) => s?.id != null)
            .map((s: any) => ({
                publicId: String(s.rasporediStudentId ?? s.studentId ?? `sdn-${s.id}`),
                name: asText(s.name) ?? '',
                grade: asText(s.grade),
                sdnevnikId: Number(s.id),
                matchedBy: 'sdnevnik-only' as MatchTier,
                idWasGenerated: false
            }));
        await applyStudentStatus(client, roster, archived, report);
        checkRosterConsistency(payload, archived, report);

        return { report, kind: 'sdnevnik', students: asArray(payload.students).length };
    }

    report.problems.push('Payload shape not recognized — stored as a blob only, tables unchanged.');
    return { report, kind: 'unknown', students: 0 };
}
