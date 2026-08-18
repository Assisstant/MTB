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

interface Inputs {
    base: any | null;          // Rasporedi-shaped state
    sdnRecords: SdnRecord[];
    sources: string[];
}

/** Classifies each file by shape so the two apps' exports can be passed together. */
function readInputs(paths: string[]): Inputs {
    const out: Inputs = { base: null, sdnRecords: [], sources: [] };

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

async function write(canonical: CanonicalStudent[], base: any) {
    const therapistNames: string[] = Array.isArray(base?.therapists)
        ? base.therapists.filter((t: unknown) => typeof t === 'string' && t.trim())
        : [];
    const therapistStudents = (base?.therapistStudents && typeof base.therapistStudents === 'object')
        ? base.therapistStudents
        : {};

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const studentIdByName = new Map<string, number>();
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
            await client.query('DELETE FROM schedule_slots');
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
                        `INSERT INTO schedule_slots (day, day_order, time_slot, therapist_id, student_id)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (day, time_slot, therapist_id)
                         DO UPDATE SET student_id = EXCLUDED.student_id`,
                        [day, order, time, therapistId, studentId]
                    );
                }
            }
            missing.forEach((m) => problems.push(`Schedule references unknown ${m} — slot skipped.`));
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
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

    const { base, sdnRecords, sources } = readInputs(files);
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

    await write(canonical, base);
    const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM students) AS students,
                (SELECT count(*) FROM therapists) AS therapists,
                (SELECT count(*) FROM therapist_students) AS links,
                (SELECT count(*) FROM schedule_slots) AS slots,
                (SELECT count(*) FROM schedule_conflicts) AS conflicts`
    );
    console.log('\n--- written to PostgreSQL ---');
    console.log(`  students:           ${rows[0].students}`);
    console.log(`  therapists:         ${rows[0].therapists}`);
    console.log(`  therapist-student:  ${rows[0].links}`);
    console.log(`  schedule slots:     ${rows[0].slots}`);
    console.log(`  conflicts in view:  ${rows[0].conflicts}`);
    console.log('');
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nImport failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
});
