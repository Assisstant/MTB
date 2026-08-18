/**
 * Stage 3 — JSON importer with student-identity reconciliation.
 *
 * Reads a Unified Sync JSON export (or a plain Rasporedi / S-Dnevnik backup)
 * and loads canonical students, therapists and their links into PostgreSQL.
 *
 * Identity is resolved BEFORE anything is written, because three schemes are
 * in play across the two apps:
 *   - Rasporedi identifies students by name string, with a stable id in
 *     studentMeta[name].studentId
 *   - S-Dnevnik identifies students by numeric id
 *   - the bridge between them is rasporediStudentId
 * Unmatched records are reported, never silently guessed into a match.
 *
 * Usage (from the server folder):
 *   npm run import -- ../sample-data/anonymized/unified-sample.json
 *   npm run import -- ../sample-data/anonymized/unified-sample.json --apply
 *
 * Without --apply the script only prints its report: nothing is written.
 * Re-running is safe: students upsert on public_id, therapists on name.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/db.js';

const PLACEHOLDER = 'Избери Ученик';

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
    matchedBy: 'bridge-id' | 'name' | 'sdnevnik-only' | 'rasporedi-only';
}

const problems: string[] = [];
const notes: string[] = [];

function normalizeName(name: string): string {
    return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
}

function asText(value: unknown): string | null {
    const s = value == null ? '' : String(value).trim();
    return s ? s : null;
}

/** Accepts a unified export, a { rasporedi: {...} } wrapper, or a raw backup. */
function readSource(filePath: string) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const base = raw && typeof raw.rasporedi === 'object' && raw.rasporedi ? raw.rasporedi : raw;
    return { raw, base };
}

function collectSdnRecords(raw: any, base: any): SdnRecord[] {
    // Unified export carries the diary slice under .sdnevnik; a plain
    // S-Dnevnik backup has student objects at the top level instead.
    const fromUnified = raw?.sdnevnik?.students;
    const candidates = Array.isArray(fromUnified)
        ? fromUnified
        : (Array.isArray(base?.students) && typeof base.students[0] === 'object' ? base.students : []);

    const out: SdnRecord[] = [];
    for (const s of candidates) {
        if (!s || typeof s !== 'object') continue;
        const id = Number(s.id);
        if (!Number.isFinite(id)) {
            problems.push(`S-Dnevnik record without a numeric id skipped: ${JSON.stringify(s).slice(0, 80)}`);
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
        ? base.students.filter((s: unknown) => typeof s === 'string' && s && s !== PLACEHOLDER)
        : [];

    const byBridgeId = new Map<string, SdnRecord>();
    const byName = new Map<string, SdnRecord>();
    for (const rec of sdnRecords) {
        if (rec.rasporediStudentId) byBridgeId.set(rec.rasporediStudentId, rec);
        const key = normalizeName(rec.name);
        if (key && !byName.has(key)) byName.set(key, rec);
    }

    const canonical: CanonicalStudent[] = [];
    const usedPublicIds = new Map<string, string>();   // publicId -> student name
    const usedSdnIds = new Map<number, string>();      // sdnevnikId -> student name
    const consumedSdn = new Set<number>();

    for (const name of rasporediNames) {
        const publicId = asText(meta[name]?.studentId);
        if (!publicId) {
            // Without a stable id we cannot key the row safely. Reported, not guessed.
            problems.push(`"${name}" has no studentId in studentMeta — skipped. Open the student in Rasporedi once so an id is generated, then re-export.`);
            continue;
        }
        if (usedPublicIds.has(publicId)) {
            problems.push(`Duplicate studentId "${publicId}" used by both "${usedPublicIds.get(publicId)}" and "${name}" — second one skipped.`);
            continue;
        }

        let match = byBridgeId.get(publicId);
        let matchedBy: CanonicalStudent['matchedBy'] = 'rasporedi-only';
        if (match) {
            matchedBy = 'bridge-id';
        } else {
            const byNameMatch = byName.get(normalizeName(name));
            if (byNameMatch && !consumedSdn.has(byNameMatch.id)) {
                match = byNameMatch;
                matchedBy = 'name';
                notes.push(`"${name}" matched to S-Dnevnik id ${byNameMatch.id} by NAME only (no rasporediStudentId). Verify this is the same student.`);
            }
        }

        let sdnevnikId: number | null = null;
        if (match) {
            if (usedSdnIds.has(match.id)) {
                problems.push(`S-Dnevnik id ${match.id} would be linked to both "${usedSdnIds.get(match.id)}" and "${name}" — link dropped for "${name}".`);
            } else {
                sdnevnikId = match.id;
                usedSdnIds.set(match.id, name);
                consumedSdn.add(match.id);
            }
        }

        usedPublicIds.set(publicId, name);
        canonical.push({
            publicId,
            name,
            grade: asText(meta[name]?.grade) ?? (match ? match.grade : null),
            sdnevnikId,
            matchedBy
        });
    }

    // Students that exist only in S-Dnevnik get their own identity rather than
    // being merged into a similar-looking Rasporedi name.
    for (const rec of sdnRecords) {
        if (consumedSdn.has(rec.id)) continue;
        const publicId = rec.rasporediStudentId || `sdn-${rec.id}`;
        if (usedPublicIds.has(publicId)) {
            problems.push(`S-Dnevnik student "${rec.name}" (id ${rec.id}) collides with existing id "${publicId}" — skipped.`);
            continue;
        }
        usedPublicIds.set(publicId, rec.name);
        usedSdnIds.set(rec.id, rec.name);
        notes.push(`"${rec.name}" (S-Dnevnik id ${rec.id}) has no Rasporedi counterpart — imported as a separate student with id "${publicId}".`);
        canonical.push({
            publicId,
            name: rec.name,
            grade: rec.grade,
            sdnevnikId: rec.id,
            matchedBy: 'sdnevnik-only'
        });
    }

    return canonical;
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
            studentIdByName.set(normalizeName(s.name), rows[0].id);
        }

        for (const t of therapistNames) {
            const { rows } = await client.query(
                `INSERT INTO therapists (name) VALUES ($1)
                 ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [t]
            );
            const therapistId = rows[0].id;

            // Replace this therapist's list wholesale — mirrors the per-therapist
            // ownership model the apps already use when merging slices.
            await client.query('DELETE FROM therapist_students WHERE therapist_id = $1', [therapistId]);
            const assigned: string[] = Array.isArray(therapistStudents[t]) ? therapistStudents[t] : [];
            for (const studentName of assigned) {
                if (!studentName || studentName === PLACEHOLDER) continue;
                const studentId = studentIdByName.get(normalizeName(studentName));
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
    const filePath = args.find((a) => !a.startsWith('--'));
    if (!filePath) {
        console.error('Usage: npm run import -- <file.json> [--apply]');
        process.exit(1);
    }

    const full = resolve(process.cwd(), filePath);
    const { raw, base } = readSource(full);
    const sdnRecords = collectSdnRecords(raw, base);
    const canonical = reconcile(base, sdnRecords);

    console.log('\n=== IMPORT REPORT ===');
    console.log(`file:            ${full}`);
    console.log(`exported at:     ${raw?.unifiedSync?.exportedAt || raw?._meta?.exportedAt || 'unknown'}`);
    console.log(`mode:            ${apply ? 'APPLY (writes to PostgreSQL)' : 'DRY RUN (nothing is written)'}`);
    console.log('');
    console.log(`students found:  ${canonical.length}`);
    const counts = canonical.reduce<Record<string, number>>((acc, s) => {
        acc[s.matchedBy] = (acc[s.matchedBy] || 0) + 1;
        return acc;
    }, {});
    console.log(`  linked by bridge id:  ${counts['bridge-id'] || 0}`);
    console.log(`  linked by name only:  ${counts['name'] || 0}`);
    console.log(`  Rasporedi only:       ${counts['rasporedi-only'] || 0}`);
    console.log(`  S-Dnevnik only:       ${counts['sdnevnik-only'] || 0}`);
    console.log(`therapists found: ${Array.isArray(base?.therapists) ? base.therapists.length : 0}`);

    if (notes.length) {
        console.log('\n--- needs a human look ---');
        notes.forEach((n) => console.log(`  • ${n}`));
    }
    if (problems.length) {
        console.log('\n--- problems (records skipped) ---');
        problems.forEach((p) => console.log(`  ! ${p}`));
    }

    if (!apply) {
        console.log('\nDry run finished. Re-run with --apply to write these records.\n');
        await pool.end();
        return;
    }

    await write(canonical, base);
    const { rows } = await pool.query(
        'SELECT (SELECT count(*) FROM students) AS students, (SELECT count(*) FROM therapists) AS therapists, (SELECT count(*) FROM therapist_students) AS links'
    );
    console.log('\n--- written to PostgreSQL ---');
    console.log(`  students:           ${rows[0].students}`);
    console.log(`  therapists:         ${rows[0].therapists}`);
    console.log(`  therapist-student:  ${rows[0].links}`);
    console.log('');
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nImport failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
});
