/**
 * The clinical records: dossier, assessments, scale templates, triage tests,
 * audiograms.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Every one of these was already written to the database, by the projection in
 * import-core.ts. Stage F adds a second caller -- an endpoint per record -- and
 * a second caller is exactly where this project has been bitten before: two
 * components deciding the same thing drift, and the drift is invisible until
 * the numbers disagree. So the mapping lives here once and both paths call it.
 * The projection loses nothing by it; the endpoints cannot diverge from it.
 *
 * These five are the diary's alone. Rasporedi never sees them, so unlike the
 * roster there is no second owner to protect against, and unlike a student a
 * record CAN be deleted -- the therapist deletes an assessment they entered by
 * mistake and means it. What is deliberately absent here is anything that would
 * let a record decide something about a PERSON: an audiogram naming someone not
 * on the roster is stored with the name and no link, never as a new student.
 */

import { asArray, asText, asRawText, isoDate, bareName } from './import-core.js';

/**
 * An audiogram's id, derived from what it holds.
 *
 * MUST MATCH audiogramId() in S-Dnevnik.html byte for byte. The two are
 * deliberately duplicated, the same arrangement `stableStudentIdForName` uses:
 * both sides must land on the same id for the same record without talking to
 * each other, and a shared module is not available to a single-file app served
 * as static HTML.
 *
 * The key order inside a curve is whatever the app happened to build, and jsonb
 * reorders it again on the way back, so the canonical form sorts keys. Sorted
 * as STRINGS -- "1000" before "250" -- which is not the musical order anyone
 * would choose, but is the one both sides get right without agreeing on a
 * numeric parse.
 */
export function audiogramId(record: any): string {
    const curve = (value: unknown): string => {
        if (!value || typeof value !== 'object') return '';
        const src = value as Record<string, unknown>;
        return Object.keys(src).sort().map((k) => `${k}:${src[k]}`).join(',');
    };
    const canonical = [
        String(record?.subjectName ?? '').trim(),
        String(record?.date ?? '').trim(),
        String(record?.recordType ?? '').trim(),
        curve(record?.rightAir), curve(record?.rightBone),
        curve(record?.leftAir), curve(record?.leftBone)
    ].join('|');

    // The same two-hash scheme as stableStudentIdForName: one FNV-1a, one
    // djb2, so a collision needs both to collide at once.
    let a = 2166136261, b = 5381;
    for (let i = 0; i < canonical.length; i++) {
        const c = canonical.charCodeAt(i);
        a ^= c; a = Math.imul(a, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ c) >>> 0;
    }
    return `AG-${a.toString(36)}-${b.toString(36)}`;
}

/** Resolves the database's student id from the diary's own. */
export async function studentIdOf(client: any, sdnevnikId: unknown): Promise<number | null> {
    const n = Number(sdnevnikId);
    if (!Number.isFinite(n)) return null;
    const { rows } = await client.query('SELECT id FROM students WHERE sdnevnik_id = $1', [n]);
    return rows.length ? rows[0].id : null;
}

// ── the dossier ──────────────────────────────────────────────────────────────

/**
 * One per student, so the student id is the key.
 *
 * asRawText throughout, not asText: this is what the therapist typed, and
 * trailing whitespace in a clinical note is theirs, not noise to tidy away.
 */
export async function upsertDossier(client: any, studentId: number, r: any) {
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
        [studentId, asRawText(r?.firstName), asRawText(r?.lastName), isoDate(r?.birthDate),
         asRawText(r?.fatherName), asRawText(r?.motherName), asRawText(r?.address), asRawText(r?.residence),
         asRawText(r?.contact), asRawText(r?.findings), asRawText(r?.opinion),
         r?.attachmentLinks ? JSON.stringify(r.attachmentLinks) : null]
    );
}

// ── scale templates ──────────────────────────────────────────────────────────

/** Returns the database id, which assessments reference. */
export async function upsertScaleTemplate(client: any, t: any): Promise<number | null> {
    const sdnId = asText(t?.id);
    const name = asText(t?.name);
    if (!sdnId || !name) return null;
    const { rows } = await client.query(
        `INSERT INTO scale_templates (sdnevnik_id, name, category, indicators)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sdnevnik_id) DO UPDATE SET
             name = EXCLUDED.name, category = EXCLUDED.category, indicators = EXCLUDED.indicators
         RETURNING id`,
        [sdnId, name, asText(t?.category), JSON.stringify(asArray(t?.indicators))]
    );
    return rows[0].id;
}

// ── assessments ──────────────────────────────────────────────────────────────

/**
 * `templateId` may be null: an assessment can name a scale that is not in the
 * payload, and losing the scores because the scale is missing would be a worse
 * answer than keeping them unlinked.
 */
export async function upsertAssessment(client: any, studentId: number, templateId: number | null, a: any) {
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

/** The template row an assessment's `scaleType` points at, or null. */
export async function templateIdOf(client: any, scaleType: unknown): Promise<number | null> {
    const key = asText(scaleType);
    if (!key) return null;
    const { rows } = await client.query('SELECT id FROM scale_templates WHERE sdnevnik_id = $1', [key]);
    return rows.length ? rows[0].id : null;
}

// ── triage tests ─────────────────────────────────────────────────────────────

export async function upsertTriage(client: any, studentId: number, t: any) {
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

// ── audiograms ───────────────────────────────────────────────────────────────

/**
 * Who this audiogram is about, matched against EVERY student on record and not
 * just those in the current payload.
 *
 * Audiograms routinely name children from earlier years who have left the
 * roster. Matching only the current diary would strip their link on every save
 * -- and an unmatched audiogram is kept with its name and no student, never
 * turned into a student. Nothing in this file may invent a person.
 */
export async function audiogramStudentId(client: any, subjectName: unknown): Promise<number | null> {
    const key = bareName(subjectName);
    if (!key) return null;
    const { rows } = await client.query('SELECT id, name FROM students ORDER BY id');
    for (const s of rows) if (bareName(s.name) === key) return s.id;
    return null;
}

export async function upsertAudiogram(client: any, a: any, studentId: number | null) {
    const subject = asText(a?.subjectName);
    if (!subject) return null;
    const id = audiogramId(a);
    await client.query(
        `INSERT INTO audiograms (sdnevnik_id, student_id, subject_name, date, record_type,
                                 right_air, right_bone, left_air, left_bone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sdnevnik_id) DO UPDATE SET
             student_id = EXCLUDED.student_id, subject_name = EXCLUDED.subject_name,
             date = EXCLUDED.date, record_type = EXCLUDED.record_type,
             right_air = EXCLUDED.right_air, right_bone = EXCLUDED.right_bone,
             left_air = EXCLUDED.left_air, left_bone = EXCLUDED.left_bone`,
        [id, studentId, subject, isoDate(a?.date), asText(a?.recordType),
         JSON.stringify(a?.rightAir ?? {}), JSON.stringify(a?.rightBone ?? {}),
         JSON.stringify(a?.leftAir ?? {}), JSON.stringify(a?.leftBone ?? {})]
    );
    return id;
}



