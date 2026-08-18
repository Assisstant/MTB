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
export async function writeAll(client: any, canonical: CanonicalStudent[], base: any, sdnDoc: any, report: Report) {
    const schoolYearId = await currentYearId(client);

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

        await client.query('DELETE FROM therapist_students WHERE therapist_id = $1', [rows[0].id]);
        for (const studentName of asArray(therapistStudents[t])) {
            if (!studentName || PLACEHOLDERS.has(studentName)) continue;
            const studentId = studentIdByName.get(norm(studentName));
            if (!studentId) {
                report.problems.push(`Therapist "${t}" references unknown student "${studentName}" — link skipped.`);
                continue;
            }
            await client.query(
                `INSERT INTO therapist_students (therapist_id, student_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [rows[0].id, studentId]
            );
        }
    }

    // Replacing the week wholesale is right when a real schedule arrives, and
    // catastrophic when an empty one does — an app opened on a fresh device
    // holds no schedule until it pulls, and saving first would erase the year.
    // So an empty schedule never replaces a non-empty one.
    const incomingAssignments = asArray(base?.schedule).reduce((n: number, slot: any) => {
        const a = (slot && typeof slot.assignments === 'object') ? slot.assignments : {};
        return n + Object.values(a).filter((v) => v && !PLACEHOLDERS.has(String(v))).length;
    }, 0);

    if (Array.isArray(base?.schedule) && incomingAssignments === 0) {
        const existing = await client.query(
            'SELECT count(*)::int AS n FROM schedule_slots WHERE school_year_id = $1', [schoolYearId]
        );
        if (existing.rows[0].n > 0) {
            report.problems.push(`Payload carries an empty schedule while ${existing.rows[0].n} slots exist for this year — schedule left untouched. Pull from the server before saving.`);
        }
    }

    if (Array.isArray(base?.schedule) && incomingAssignments > 0) {
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

/** Plans, activities, per-student progress, dossiers, scales, triage, audiograms, attendance. */
export async function writeDiary(client: any, sdnDoc: any, studentIdBySdnId: Map<number, number>, report: Report) {
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
    for (const [sid, byPlan] of Object.entries(sdnDoc.studentProgress || {})) {
        const studentId = studentIdBySdnId.get(Number(sid));
        if (!studentId) continue;
        for (const [sdnPlanId, entries] of Object.entries(byPlan as Record<string, any>)) {
            const planId = planIdBySdnId.get(Number(sdnPlanId));
            if (!planId) { missingPlans.add(sdnPlanId); continue; }
            for (const e of asArray(entries)) {
                const position = Number(e?.index);
                if (!Number.isFinite(position)) continue;
                const activityId = activityIdByPlanPosition.get(`${planId}:${position}`);
                if (!activityId) { dangling++; continue; }
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
    missingPlans.forEach((p) => report.problems.push(`Progress refers to plan ${p}, which is not in the payload — skipped.`));
    if (dangling) report.problems.push(`${dangling} progress entries point past the end of their plan's activity list — skipped.`);

    for (const r of asArray(sdnDoc.student_records)) {
        const studentId = studentIdBySdnId.get(Number(r?.id));
        if (!studentId) continue;
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

    const templateIdBySdnId = new Map<string, number>();
    for (const t of asArray(sdnDoc.scaleTemplates)) {
        const sdnId = asText(t?.id);
        const name = asText(t?.name);
        if (!sdnId || !name) { report.problems.push('Scale template without id/name skipped.'); continue; }
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

    let withoutTemplate = 0;
    for (const a of asArray(sdnDoc.assessments)) {
        const studentId = studentIdBySdnId.get(Number(a?.studentId));
        if (!studentId) continue;
        const templateId = templateIdBySdnId.get(asText(a?.scaleType) ?? '') ?? null;
        if (!templateId) withoutTemplate++;
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
    if (withoutTemplate) report.notes.push(`${withoutTemplate} assessment(s) reference a scale template that is not in the payload — kept without a template link.`);

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

    // Same rule as the schedule: audiograms are replaced wholesale, so an
    // empty list must not wipe the existing ones.
    if (asArray(sdnDoc.audiograms).length > 0) {
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
            report.notes.push(`${unmatched.length} audiogram(s) name someone not in the roster — kept with the name, no student link: ${[...new Set(unmatched)].join(', ')}`);
        }
    }

    for (const [date, byStudent] of Object.entries(sdnDoc.attendance || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { report.problems.push(`Attendance key "${date}" is not a date — skipped.`); continue; }
        for (const [sid, bySlot] of Object.entries(byStudent as Record<string, any>)) {
            const studentId = studentIdBySdnId.get(Number(sid));
            if (!studentId) continue;
            for (const [slotKey, rec] of Object.entries(bySlot as Record<string, unknown>)) {
                const status = attendanceStatus(rec);
                if (!status) continue;
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

/**
 * Projects one app payload into the relational tables. Returns a short summary
 * the API can hand back to the app.
 */
export async function projectPayload(client: any, payload: any): Promise<{ report: Report; kind: string; students: number }> {
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
        await writeAll(client, canonical, base, looksLikeDiary(sdnSection) ? sdnSection : null, report);
        return { report, kind: 'rasporedi', students: canonical.length };
    }

    if (looksLikeDiary(payload)) {
        await writeDiaryForKnownStudents(client, payload, report);
        return { report, kind: 'sdnevnik', students: asArray(payload.students).length };
    }

    report.problems.push('Payload shape not recognized — stored as a blob only, tables unchanged.');
    return { report, kind: 'unknown', students: 0 };
}
