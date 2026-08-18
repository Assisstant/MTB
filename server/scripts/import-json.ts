/**
 * Stage 3 — JSON importer with student-identity reconciliation.
 *
 * Reads Unified Sync JSON exports, or older separate Rasporedi / S-Dnevnik
 * backups, and loads canonical students, therapists and their links into
 * PostgreSQL.
 *
 * Identity is resolved BEFORE anything is written, because three schemes are
 * in play across the two apps:
 *   - Rasporedi identifies students by display name ("IV-а - Име Презиме"),
 *     with a stable id in studentMeta[name].studentId
 *   - S-Dnevnik identifies students by numeric id, keeping the grade in its
 *     own field ({ name: "Име Презиме", grade: "IV-а" })
 *   - the bridge between them is rasporediStudentId
 *
 * Legacy exports predate both the stable id and the bridge, so the importer
 * falls back through decreasing-confidence tiers and reports which tier each
 * link used. It never merges two records on an ambiguous match.
 *
 * Usage (from the server folder) — one or more files, order does not matter:
 *   npm run import -- ../sample-data/anonymized/unified-sample.json
 *   npm run import -- raspored-backup.json SDnevnik_v3_full.json --apply
 *
 * Without --apply the script only prints its report: nothing is written.
 * Re-running is safe: students upsert on public_id, therapists on name.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/db.js';

/** Both apps carry a non-student placeholder at the top of the list. */
const PLACEHOLDERS = new Set(['Избери Ученик', 'Select Student']);

/** Only for sorting — the day label itself is stored as the app writes it. */
const DAY_ORDER: Record<string, number> = {
    'понеделник': 1, 'вторник': 2, 'среда': 3, 'четврток': 4, 'петок': 5, 'сабота': 6, 'недела': 7,
    'pon': 1, 'vto': 2, 'sre': 3, 'cet': 4, 'pet': 5
};

type MatchTier = 'bridge-id' | 'exact-name' | 'bare-name' | 'name+grade' | 'rasporedi-only' | 'sdnevnik-only';

interface SdnRecord {
    id: number;
    name: string;
    grade: string | null;
    rasporediStudentId: string;
}

interface CanonicalStudent {
    publicId: string;
    name: string;
    grade: string | null;
    sdnevnikId: number | null;
    matchedBy: MatchTier;
    idWasGenerated: boolean;
}

const problems: string[] = [];
const notes: string[] = [];

function norm(value: unknown): string {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
}

/**
 * Strips the grade prefix ("IV-а - Име") and any trailing category suffix
 * ("Име (над.)") so a Rasporedi display name can be compared with the plain
 * name S-Dnevnik stores.
 */
function bareName(value: unknown): string {
    let n = String(value ?? '');
    const i = n.indexOf(' - ');
    if (i > -1 && i <= 10) n = n.slice(i + 3);
    n = n.replace(/\s*\([^)]*\)\s*$/, '');
    return norm(n);
}

function normGrade(value: unknown): string {
    return norm(String(value ?? '').replace(/[()]/g, '').replace(/\.$/, ''));
}

/**
 * Mirrors stableStudentIdForName() in Rasporedi v5.0 byte for byte, so an id
 * generated here is identical to the one the app generates for the same name.
 * Without this, importing a legacy export would invent ids that diverge from
 * the ones the app assigns on its next load.
 */
function stableStudentIdForName(name: string): string {
    const text = String(name || '').normalize('NFKC').toLocaleLowerCase('mk-MK').trim();
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a ^= c; a = Math.imul(a, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ c) >>> 0;
    }
    return `RS-${a.toString(36)}-${b.toString(36)}`;
}

function asText(value: unknown): string | null {
    const s = value == null ? '' : String(value).trim();
    return s ? s : null;
}

/** Dates are ISO in every export seen so far; anything else becomes NULL. */
function isoDate(value: unknown): string | null {
    const s = String(value ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

interface Inputs {
    base: any | null;          // Rasporedi-shaped state
    sdnRecords: SdnRecord[];
    sdnDoc: any | null;        // full S-Dnevnik document (plans, attendance, progress)
    sources: string[];
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

/** Classifies each file by shape so the two apps' exports can be passed together. */
function readInputs(paths: string[]): Inputs {
    const out: Inputs = { base: null, sdnRecords: [], sdnDoc: null, sources: [] };

    for (const p of paths) {
        const full = resolve(process.cwd(), p);
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        const body = raw && typeof raw.rasporedi === 'object' && raw.rasporedi ? raw.rasporedi : raw;
        const students = body?.students;

        const isRasporedi = Array.isArray(students) && students.some((s: unknown) => typeof s === 'string');
        const isSdnevnik = Array.isArray(students) && students.some((s: unknown) => s && typeof s === 'object');
        const unifiedSdn = raw?.sdnevnik?.students;

        if (isRasporedi) {
            if (out.base) problems.push(`More than one Rasporedi-shaped file given; ignoring "${p}".`);
            else out.base = body;
        }
        if (Array.isArray(unifiedSdn)) out.sdnRecords.push(...toSdnRecords(unifiedSdn));
        else if (isSdnevnik) out.sdnRecords.push(...toSdnRecords(students));

        // Only a full S-Dnevnik backup carries the clinical collections; the
        // slice inside a Unified export has students and schedule only.
        if (raw && (raw.attendance || raw.plans || raw.studentProgress)) {
            if (out.sdnDoc) problems.push(`More than one S-Dnevnik backup given; ignoring the extra one.`);
            else out.sdnDoc = raw;
        }

        if (!isRasporedi && !isSdnevnik && !unifiedSdn) problems.push(`"${p}" has no recognizable student list — ignored.`);
        out.sources.push(`${full}  [${isRasporedi ? 'Rasporedi' : ''}${isRasporedi && (isSdnevnik || unifiedSdn) ? '+' : ''}${(isSdnevnik || unifiedSdn) ? 'S-Dnevnik' : ''}]`);
    }
    return out;
}

function toSdnRecords(list: any[]): SdnRecord[] {
    const out: SdnRecord[] = [];
    for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        const id = Number(s.id);
        if (!Number.isFinite(id)) {
            problems.push(`S-Dnevnik record without a numeric id skipped: ${String(s.name || '').slice(0, 40)}`);
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

function reconcile(base: any, sdnRecords: SdnRecord[]): CanonicalStudent[] {
    const meta = (base?.studentMeta && typeof base.studentMeta === 'object') ? base.studentMeta : {};
    const rasporediNames: string[] = Array.isArray(base?.students)
        ? base.students.filter((s: unknown) => typeof s === 'string' && s && !PLACEHOLDERS.has(s))
        : [];

    // Indexes over the S-Dnevnik side.
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

    // How many Rasporedi students share a bare name — guards the fuzzy tier.
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
            problems.push(`Duplicate student id "${publicId}" for both "${usedPublicIds.get(publicId)}" and "${name}" — second skipped.`);
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
            // Fuzzy tier: only safe when the bare name identifies exactly one
            // student on BOTH sides, otherwise the grade must agree.
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
                    problems.push(`"${name}" is ambiguous against S-Dnevnik (${bare.length} candidate(s) with the same name, ${rasporediShare} Rasporedi student(s) share it) — imported WITHOUT an S-Dnevnik link.`);
                }
            }
        }

        let sdnevnikId: number | null = null;
        if (match) {
            if (usedSdnIds.has(match.id)) {
                problems.push(`S-Dnevnik id ${match.id} would link to both "${usedSdnIds.get(match.id)}" and "${name}" — link dropped for "${name}".`);
                tier = 'rasporedi-only';
            } else {
                sdnevnikId = match.id;
                usedSdnIds.set(match.id, name);
                consumedSdn.add(match.id);
                if (tier === 'bare-name' || tier === 'name+grade') {
                    notes.push(`${tier}: "${name}" ↔ S-Dnevnik #${match.id} "${match.name}" (${match.grade || 'no grade'})`);
                }
            }
        }

        usedPublicIds.set(publicId, name);
        canonical.push({
            publicId,
            name,
            grade: gradeFromMeta ?? (match ? match.grade : null),
            sdnevnikId,
            matchedBy: tier,
            idWasGenerated
        });
    }

    // S-Dnevnik students with no Rasporedi counterpart get their own identity
    // rather than being merged into a similar-looking name.
    for (const rec of sdnRecords) {
        if (consumedSdn.has(rec.id)) continue;
        const publicId = rec.rasporediStudentId || `sdn-${rec.id}`;
        if (usedPublicIds.has(publicId)) {
            problems.push(`S-Dnevnik "${rec.name}" (id ${rec.id}) collides with existing id "${publicId}" — skipped.`);
            continue;
        }
        usedPublicIds.set(publicId, rec.name);
        notes.push(`S-Dnevnik only: "${rec.name}" (id ${rec.id}) has no Rasporedi counterpart — imported as "${publicId}".`);
        canonical.push({
            publicId,
            name: rec.name,
            grade: rec.grade,
            sdnevnikId: rec.id,
            matchedBy: 'sdnevnik-only',
            idWasGenerated: !rec.rasporediStudentId
        });
    }

    return canonical;
}

interface ScheduleStats {
    slots: number;
    unknownDays: string[];
    conflicts: { day: string; time: string; student: string; therapists: string[] }[];
}

/**
 * Reads the schedule without touching the database, so a dry run can report
 * what would be imported — including students booked with two therapists in
 * the same term, which the app flags in red.
 */
function analyzeSchedule(base: any): ScheduleStats {
    const stats: ScheduleStats = { slots: 0, unknownDays: [], conflicts: [] };
    if (!Array.isArray(base?.schedule)) return stats;

    const unknown = new Set<string>();
    for (const slot of base.schedule) {
        if (!slot || typeof slot !== 'object') continue;
        const day = String(slot.day || '').trim();
        const time = String(slot.time || '').trim();
        if (!day || !time) continue;
        if (!DAY_ORDER[norm(day)]) unknown.add(day);

        const assignments = (slot.assignments && typeof slot.assignments === 'object') ? slot.assignments : {};
        const perStudent = new Map<string, string[]>();
        for (const [therapist, student] of Object.entries(assignments)) {
            const s = String(student || '').trim();
            if (!s || PLACEHOLDERS.has(s)) continue;
            stats.slots++;
            if (!perStudent.has(s)) perStudent.set(s, []);
            perStudent.get(s)!.push(therapist);
        }
        for (const [student, therapists] of perStudent) {
            if (therapists.length > 1) stats.conflicts.push({ day, time, student, therapists });
        }
    }
    stats.unknownDays = [...unknown];
    return stats;
}

/** Attendance marks are a bare "present" string in some exports, an object in others. */
function attendanceStatus(record: unknown): 'present' | 'absent' | null {
    const raw = typeof record === 'string' ? record : (record && typeof record === 'object' ? (record as any).status : '');
    const s = String(raw || '').trim().toLowerCase();
    return s === 'present' || s === 'absent' ? s : null;
}

interface DiaryStats {
    plans: number;
    activities: number;
    attendanceMarks: number;
    blankMarks: number;
    progressEntries: number;
    unknownStudents: string[];
}

/** Counts what the diary file would contribute, without touching the database. */
function analyzeDiary(sdnDoc: any, knownSdnIds: Set<number>): DiaryStats {
    const stats: DiaryStats = { plans: 0, activities: 0, attendanceMarks: 0, blankMarks: 0, progressEntries: 0, unknownStudents: [] };
    if (!sdnDoc) return stats;

    const unknown = new Set<string>();
    for (const p of asArray(sdnDoc.plans)) {
        stats.plans++;
        stats.activities += asArray(p?.activities).length;
    }

    for (const byStudent of Object.values(sdnDoc.attendance || {})) {
        for (const [sid, bySlot] of Object.entries(byStudent as Record<string, any>)) {
            if (!knownSdnIds.has(Number(sid))) { unknown.add(sid); continue; }
            for (const rec of Object.values(bySlot as Record<string, unknown>)) {
                if (attendanceStatus(rec)) stats.attendanceMarks++;
                else stats.blankMarks++;
            }
        }
    }

    for (const [sid, byPlan] of Object.entries(sdnDoc.studentProgress || {})) {
        if (!knownSdnIds.has(Number(sid))) { unknown.add(sid); continue; }
        for (const entries of Object.values(byPlan as Record<string, any>)) {
            stats.progressEntries += asArray(entries).length;
        }
    }

    stats.unknownStudents = [...unknown];
    return stats;
}

async function write(canonical: CanonicalStudent[], base: any, sdnDoc: any) {
    const therapistNames: string[] = Array.isArray(base?.therapists)
        ? base.therapists.filter((t: unknown) => typeof t === 'string' && t.trim())
        : [];
    const therapistStudents = (base?.therapistStudents && typeof base.therapistStudents === 'object')
        ? base.therapistStudents
        : {};

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Everything imported belongs to the current school year: the roster
        // carries over between years, the schedule does not.
        const yearRow = await client.query('SELECT id, label FROM school_years WHERE is_current');
        if (yearRow.rows.length === 0) throw new Error('No current school year is set (see migration 007).');
        const schoolYearId = yearRow.rows[0].id;
        notes.push(`Imported into school year ${yearRow.rows[0].label}.`);

        const studentIdByName = new Map<string, number>();
        const studentIdBySdnId = new Map<number, number>();
        for (const s of canonical) {
            const { rows } = await client.query(
                `INSERT INTO students (public_id, sdnevnik_id, name, grade)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (public_id) DO UPDATE
                 SET name = EXCLUDED.name,
                     grade = EXCLUDED.grade,
                     sdnevnik_id = COALESCE(EXCLUDED.sdnevnik_id, students.sdnevnik_id),
                     updated_at = now()
                 RETURNING id`,
                [s.publicId, s.sdnevnikId, s.name, s.grade]
            );
            studentIdByName.set(norm(s.name), rows[0].id);
            if (s.sdnevnikId != null) studentIdBySdnId.set(s.sdnevnikId, rows[0].id);

            await client.query(
                `INSERT INTO student_enrollments (student_id, school_year_id, grade)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (student_id, school_year_id) DO UPDATE SET grade = EXCLUDED.grade`,
                [rows[0].id, schoolYearId, s.grade]
            );
        }

        const therapistIdByName = new Map<string, number>();
        for (const t of therapistNames) {
            const { rows } = await client.query(
                `INSERT INTO therapists (name) VALUES ($1)
                 ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [t]
            );
            const therapistId = rows[0].id;
            therapistIdByName.set(norm(t), therapistId);

            // Replace this therapist's list wholesale — mirrors the per-therapist
            // ownership model the apps already use when merging slices.
            await client.query('DELETE FROM therapist_students WHERE therapist_id = $1', [therapistId]);
            const assigned: string[] = Array.isArray(therapistStudents[t]) ? therapistStudents[t] : [];
            for (const studentName of assigned) {
                if (!studentName || PLACEHOLDERS.has(studentName)) continue;
                const studentId = studentIdByName.get(norm(studentName));
                if (!studentId) {
                    problems.push(`Therapist "${t}" references unknown student "${studentName}" — link skipped.`);
                    continue;
                }
                await client.query(
                    `INSERT INTO therapist_students (therapist_id, student_id)
                     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [therapistId, studentId]
                );
            }
        }

        // The file is an authoritative snapshot of the whole week, so the
        // schedule is replaced wholesale rather than merged.
        if (Array.isArray(base?.schedule)) {
            // Only THIS year's schedule is replaced; earlier years stay archived.
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
            missing.forEach((m) => problems.push(`Schedule references unknown ${m} — slot skipped.`));
        }

        if (sdnDoc) await writeDiary(client, sdnDoc, studentIdBySdnId);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/** Plans, activities, per-student progress and attendance from a diary backup. */
async function writeDiary(client: any, sdnDoc: any, studentIdBySdnId: Map<number, number>) {
    // --- plans and their ordered activities ---
    const planIdBySdnId = new Map<number, number>();
    const activityIdByPlanPosition = new Map<string, number>();

    for (const p of asArray(sdnDoc.plans)) {
        const sdnPlanId = Number(p?.id);
        const name = asText(p?.name);
        if (!Number.isFinite(sdnPlanId) || !name) {
            problems.push(`Plan without a usable id/name skipped.`);
            continue;
        }
        const { rows } = await client.query(
            `INSERT INTO plans (sdnevnik_id, name) VALUES ($1, $2)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [sdnPlanId, name]
        );
        const planId = rows[0].id;
        planIdBySdnId.set(sdnPlanId, planId);

        const activities = asArray(p?.activities);
        for (let i = 0; i < activities.length; i++) {
            const label = asText(activities[i]);
            if (!label) continue;
            const res = await client.query(
                `INSERT INTO plan_activities (plan_id, position, label) VALUES ($1, $2, $3)
                 ON CONFLICT (plan_id, position) DO UPDATE SET label = EXCLUDED.label
                 RETURNING id`,
                [planId, i, label]
            );
            activityIdByPlanPosition.set(`${planId}:${i}`, res.rows[0].id);
        }
    }

    // --- which plan each student currently follows ---
    for (const s of asArray(sdnDoc.students)) {
        const studentId = studentIdBySdnId.get(Number(s?.id));
        const planId = planIdBySdnId.get(Number(s?.planId));
        if (!studentId || !planId) continue;
        await client.query('UPDATE students SET plan_id = $1 WHERE id = $2', [planId, studentId]);
    }

    // --- completed activities ---
    const missingPlans = new Set<string>();
    let danglingActivities = 0;
    for (const [sid, byPlan] of Object.entries(sdnDoc.studentProgress || {})) {
        const studentId = studentIdBySdnId.get(Number(sid));
        if (!studentId) continue;   // already reported by the analysis pass
        for (const [sdnPlanId, entries] of Object.entries(byPlan as Record<string, any>)) {
            const planId = planIdBySdnId.get(Number(sdnPlanId));
            if (!planId) { missingPlans.add(sdnPlanId); continue; }
            for (const e of asArray(entries)) {
                const position = Number(e?.index);
                if (!Number.isFinite(position)) continue;
                const activityId = activityIdByPlanPosition.get(`${planId}:${position}`);
                if (!activityId) { danglingActivities++; continue; }
                await client.query(
                    `INSERT INTO student_plan_progress (student_id, activity_id, completed_on, time_slot)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (student_id, activity_id)
                     DO UPDATE SET completed_on = EXCLUDED.completed_on, time_slot = EXCLUDED.time_slot`,
                    [studentId, activityId, asText(e?.date), asText(e?.time)]
                );
            }
        }
    }
    missingPlans.forEach((p) => problems.push(`Progress refers to plan ${p}, which is not in the file — skipped.`));
    if (danglingActivities) problems.push(`${danglingActivities} progress entries point past the end of their plan's activity list — skipped.`);

    // --- dossiers (one per student, keyed by the diary's student id) ---
    for (const r of asArray(sdnDoc.student_records)) {
        const studentId = studentIdBySdnId.get(Number(r?.id));
        if (!studentId) continue;   // already reported
        await client.query(
            `INSERT INTO student_records (student_id, first_name, last_name, birth_date, father_name,
                                          mother_name, address, residence, contact, findings, opinion,
                                          attachment_links, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
             ON CONFLICT (student_id) DO UPDATE SET
                 first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
                 birth_date = EXCLUDED.birth_date, father_name = EXCLUDED.father_name,
                 mother_name = EXCLUDED.mother_name, address = EXCLUDED.address,
                 residence = EXCLUDED.residence, contact = EXCLUDED.contact,
                 findings = EXCLUDED.findings, opinion = EXCLUDED.opinion,
                 attachment_links = EXCLUDED.attachment_links, updated_at = now()`,
            [studentId, asText(r?.firstName), asText(r?.lastName), isoDate(r?.birthDate),
             asText(r?.fatherName), asText(r?.motherName), asText(r?.address), asText(r?.residence),
             asText(r?.contact), asText(r?.findings), asText(r?.opinion),
             r?.attachmentLinks ? JSON.stringify(r.attachmentLinks) : null]
        );
    }

    // --- rating scales ---
    const templateIdBySdnId = new Map<string, number>();
    for (const t of asArray(sdnDoc.scaleTemplates)) {
        const sdnId = asText(t?.id);
        const name = asText(t?.name);
        if (!sdnId || !name) { problems.push('Scale template without id/name skipped.'); continue; }
        const { rows } = await client.query(
            `INSERT INTO scale_templates (sdnevnik_id, name, category, indicators)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET
                 name = EXCLUDED.name, category = EXCLUDED.category, indicators = EXCLUDED.indicators
             RETURNING id`,
            [sdnId, name, asText(t?.category), JSON.stringify(asArray(t?.indicators))]
        );
        templateIdBySdnId.set(sdnId, rows[0].id);
    }

    // --- assessments ---
    let assessmentsWithoutTemplate = 0;
    for (const a of asArray(sdnDoc.assessments)) {
        const studentId = studentIdBySdnId.get(Number(a?.studentId));
        if (!studentId) continue;
        const templateId = templateIdBySdnId.get(asText(a?.scaleType) ?? '') ?? null;
        if (!templateId) assessmentsWithoutTemplate++;
        const avg = Number(a?.average);
        await client.query(
            `INSERT INTO assessments (sdnevnik_id, student_id, template_id, date, period, scores, average, comment)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET
                 student_id = EXCLUDED.student_id, template_id = EXCLUDED.template_id,
                 date = EXCLUDED.date, period = EXCLUDED.period, scores = EXCLUDED.scores,
                 average = EXCLUDED.average, comment = EXCLUDED.comment`,
            [Number.isFinite(Number(a?.id)) ? Number(a.id) : null, studentId, templateId,
             isoDate(a?.date), asText(a?.period), JSON.stringify(a?.scores ?? {}),
             Number.isFinite(avg) ? avg : null, asText(a?.comment)]
        );
    }
    if (assessmentsWithoutTemplate) notes.push(`${assessmentsWithoutTemplate} assessment(s) reference a scale template that is not in the file — imported without a template link.`);

    // --- triage tests ---
    for (const t of asArray(sdnDoc.trijazenTestovi)) {
        const studentId = studentIdBySdnId.get(Number(t?.studentId));
        if (!studentId) continue;
        await client.query(
            `INSERT INTO triage_tests (sdnevnik_id, student_id, test_date, assessor, payload)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (sdnevnik_id) DO UPDATE SET
                 student_id = EXCLUDED.student_id, test_date = EXCLUDED.test_date,
                 assessor = EXCLUDED.assessor, payload = EXCLUDED.payload`,
            [Number.isFinite(Number(t?.id)) ? Number(t.id) : null, studentId,
             isoDate(t?.date), asText(t?.assessor), JSON.stringify(t?.assessments ?? {})]
        );
    }

    // --- audiograms (matched by subject name only) ---
    if (Array.isArray(sdnDoc.audiograms)) {
        const dbIdByBareName = new Map<string, number>();
        for (const s of asArray(sdnDoc.students)) {
            const dbId = studentIdBySdnId.get(Number(s?.id));
            if (dbId) dbIdByBareName.set(bareName(s?.name), dbId);
        }

        await client.query('DELETE FROM audiograms');
        const unmatched: string[] = [];
        for (const a of asArray(sdnDoc.audiograms)) {
            const subject = asText(a?.subjectName);
            if (!subject) continue;
            const studentId = dbIdByBareName.get(bareName(subject)) ?? null;
            if (!studentId) unmatched.push(subject);
            await client.query(
                `INSERT INTO audiograms (student_id, subject_name, date, record_type, right_air, right_bone, left_air, left_bone)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [studentId, subject, isoDate(a?.date), asText(a?.recordType),
                 JSON.stringify(a?.rightAir ?? {}), JSON.stringify(a?.rightBone ?? {}),
                 JSON.stringify(a?.leftAir ?? {}), JSON.stringify(a?.leftBone ?? {})]
            );
        }
        if (unmatched.length) {
            notes.push(`${unmatched.length} audiogram(s) name someone not in the roster — kept with the name, no student link: ${[...new Set(unmatched)].join(', ')}`);
        }
    }

    // --- attendance ---
    for (const [date, byStudent] of Object.entries(sdnDoc.attendance || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { problems.push(`Attendance key "${date}" is not a date — skipped.`); continue; }
        for (const [sid, bySlot] of Object.entries(byStudent as Record<string, any>)) {
            const studentId = studentIdBySdnId.get(Number(sid));
            if (!studentId) continue;   // already reported
            for (const [slotKey, rec] of Object.entries(bySlot as Record<string, unknown>)) {
                const status = attendanceStatus(rec);
                if (!status) continue;  // blank marks carry no information
                await client.query(
                    `INSERT INTO attendance (student_id, date, slot_key, status)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (student_id, date, slot_key) DO UPDATE SET status = EXCLUDED.status`,
                    [studentId, date, slotKey, status]
                );
            }
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const files = args.filter((a) => !a.startsWith('--'));
    if (files.length === 0) {
        console.error('Usage: npm run import -- <file.json> [more.json ...] [--apply]');
        process.exit(1);
    }

    const { base, sdnRecords, sdnDoc, sources } = readInputs(files);
    if (!base) {
        console.error('No Rasporedi-shaped file among the inputs (need the student/therapist lists).');
        process.exit(1);
    }
    const canonical = reconcile(base, sdnRecords);

    const tally = canonical.reduce<Record<string, number>>((acc, s) => {
        acc[s.matchedBy] = (acc[s.matchedBy] || 0) + 1;
        return acc;
    }, {});
    const generated = canonical.filter((s) => s.idWasGenerated).length;
    const linked = canonical.filter((s) => s.sdnevnikId != null).length;

    console.log('\n=== IMPORT REPORT ===');
    sources.forEach((s) => console.log(`source: ${s}`));
    console.log(`mode:   ${apply ? 'APPLY (writes to PostgreSQL)' : 'DRY RUN (nothing is written)'}`);
    console.log('');
    console.log(`students found:          ${canonical.length}`);
    console.log(`  ids taken from file:   ${canonical.length - generated}`);
    console.log(`  ids generated (legacy):${generated}   <- same algorithm the app uses`);
    console.log(`linked to S-Dnevnik:     ${linked} of ${sdnRecords.length}`);
    console.log(`  via bridge id:         ${tally['bridge-id'] || 0}`);
    console.log(`  via exact name:        ${tally['exact-name'] || 0}`);
    console.log(`  via bare name:         ${tally['bare-name'] || 0}`);
    console.log(`  via name + grade:      ${tally['name+grade'] || 0}`);
    console.log(`  Rasporedi only:        ${tally['rasporedi-only'] || 0}`);
    console.log(`  S-Dnevnik only:        ${tally['sdnevnik-only'] || 0}`);
    console.log(`therapists found:        ${Array.isArray(base?.therapists) ? base.therapists.length : 0}`);

    const sched = analyzeSchedule(base);
    console.log(`schedule slots:          ${sched.slots}`);
    if (sched.unknownDays.length) console.log(`  unknown day labels:    ${sched.unknownDays.join(', ')} (sorted last)`);
    console.log(`  double-booked students:${sched.conflicts.length}`);
    if (sched.conflicts.length) {
        console.log('\n--- students booked with two therapists in the same term ---');
        sched.conflicts.slice(0, 20).forEach((c) => {
            console.log(`  ⚠ ${c.day} ${c.time} — ${c.student}: ${c.therapists.join(' | ')}`);
        });
        if (sched.conflicts.length > 20) console.log(`  … and ${sched.conflicts.length - 20} more`);
        console.log('  (imported as-is — the database records them, it does not silently drop them)');
    }

    const knownSdnIds = new Set(canonical.filter((s) => s.sdnevnikId != null).map((s) => s.sdnevnikId as number));
    const diary = analyzeDiary(sdnDoc, knownSdnIds);
    if (sdnDoc) {
        console.log(`therapy plans:           ${diary.plans} (${diary.activities} activities)`);
        console.log(`attendance marks:        ${diary.attendanceMarks}${diary.blankMarks ? `  (+${diary.blankMarks} blank, skipped)` : ''}`);
        console.log(`progress entries:        ${diary.progressEntries}`);
        console.log(`dossiers:                ${asArray(sdnDoc.student_records).length}`);
        console.log(`assessments:             ${asArray(sdnDoc.assessments).length} on ${asArray(sdnDoc.scaleTemplates).length} scale templates`);
        console.log(`triage tests:            ${asArray(sdnDoc.trijazenTestovi).length}`);
        console.log(`audiograms:              ${asArray(sdnDoc.audiograms).length}`);
        if (diary.unknownStudents.length) {
            console.log(`  ⚠ diary data for ${diary.unknownStudents.length} student id(s) no longer in the roster — skipped`);
            console.log(`    (${diary.unknownStudents.join(', ')})`);
        }
    }

    if (notes.length) {
        console.log('\n--- links made on a name match (worth a look) ---');
        notes.forEach((n) => console.log(`  • ${n}`));
    }
    if (problems.length) {
        console.log('\n--- problems ---');
        problems.forEach((p) => console.log(`  ! ${p}`));
    }

    if (!apply) {
        console.log('\nDry run finished. Re-run with --apply to write these records.\n');
        await pool.end();
        return;
    }

    const problemsBefore = problems.length;
    const notesBefore = notes.length;
    await write(canonical, base, sdnDoc);
    const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM students) AS students,
                (SELECT count(*) FROM therapists) AS therapists,
                (SELECT count(*) FROM therapist_students) AS links,
                (SELECT count(*) FROM schedule_slots) AS slots,
                (SELECT count(*) FROM schedule_conflicts) AS conflicts,
                (SELECT count(*) FROM plans) AS plans,
                (SELECT count(*) FROM plan_activities) AS activities,
                (SELECT count(*) FROM student_plan_progress) AS progress,
                (SELECT count(*) FROM attendance) AS attendance,
                (SELECT count(*) FROM student_records) AS dossiers,
                (SELECT count(*) FROM assessments) AS assessments,
                (SELECT count(*) FROM triage_tests) AS triage,
                (SELECT count(*) FROM audiograms) AS audiograms,
                (SELECT count(*) FROM audiograms WHERE student_id IS NULL) AS audiograms_unlinked`
    );
    if (notes.length > notesBefore) {
        console.log('\n--- noticed while writing (worth a look) ---');
        notes.slice(notesBefore).forEach((n) => console.log(`  • ${n}`));
    }
    if (problems.length > problemsBefore) {
        console.log('\n--- problems found while writing ---');
        problems.slice(problemsBefore).forEach((p) => console.log(`  ! ${p}`));
    }
    console.log('\n--- written to PostgreSQL ---');
    console.log(`  students:           ${rows[0].students}`);
    console.log(`  therapists:         ${rows[0].therapists}`);
    console.log(`  therapist-student:  ${rows[0].links}`);
    console.log(`  schedule slots:     ${rows[0].slots}`);
    console.log(`  conflicts in view:  ${rows[0].conflicts}`);
    console.log(`  plans / activities: ${rows[0].plans} / ${rows[0].activities}`);
    console.log(`  progress entries:   ${rows[0].progress}`);
    console.log(`  attendance marks:   ${rows[0].attendance}`);
    console.log(`  dossiers:           ${rows[0].dossiers}`);
    console.log(`  assessments:        ${rows[0].assessments}`);
    console.log(`  triage tests:       ${rows[0].triage}`);
    console.log(`  audiograms:         ${rows[0].audiograms}${Number(rows[0].audiograms_unlinked) ? ` (${rows[0].audiograms_unlinked} without a student link)` : ''}`);
    console.log('');
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nImport failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
});
