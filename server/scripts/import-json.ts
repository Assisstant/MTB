/**
 * One-off import from JSON files, with a full report.
 *
 * The apps now project their state into the tables on every save (see
 * routes/state.ts), so this script is for the cases a save cannot cover:
 * loading an old backup, or bootstrapping a fresh database.
 *
 * The reconciliation and writing logic is shared with the API in
 * src/lib/import-core.ts — one implementation, so both paths resolve student
 * identity identically.
 *
 * Usage (from the server folder) — one or more files, order does not matter:
 *   npm run import -- ../sample-data/anonymized/unified-sample.json
 *   npm run import -- raspored-backup.json SDnevnik_v3_full.json --apply
 *
 * Without --apply nothing is written: it prints the report and stops.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/db.js';
import {
    PLACEHOLDERS, DAY_ORDER, newReport, norm, asArray, attendanceStatus,
    toSdnRecords, reconcile, writeAll,
    type Report, type SdnRecord, type CanonicalStudent
} from '../src/lib/import-core.js';

const report: Report = newReport();

interface Inputs {
    base: any | null;
    sdnRecords: SdnRecord[];
    sdnDoc: any | null;
    sources: string[];
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
            if (out.base) report.problems.push(`More than one Rasporedi-shaped file given; ignoring "${p}".`);
            else out.base = body;
        }
        if (Array.isArray(unifiedSdn)) out.sdnRecords.push(...toSdnRecords(unifiedSdn, report));
        else if (isSdnevnik) out.sdnRecords.push(...toSdnRecords(students, report));

        if (raw && (raw.attendance || raw.plans || raw.studentProgress)) {
            if (out.sdnDoc) report.problems.push('More than one S-Dnevnik backup given; ignoring the extra one.');
            else out.sdnDoc = raw;
        }

        if (!isRasporedi && !isSdnevnik && !unifiedSdn) report.problems.push(`"${p}" has no recognizable student list — ignored.`);
        out.sources.push(`${full}  [${isRasporedi ? 'Rasporedi' : ''}${isRasporedi && (isSdnevnik || unifiedSdn) ? '+' : ''}${(isSdnevnik || unifiedSdn) ? 'S-Dnevnik' : ''}]`);
    }
    return out;
}

/** Counts the schedule and finds double-bookings without touching the database. */
function analyzeSchedule(base: any) {
    const stats = { slots: 0, unknownDays: [] as string[], conflicts: [] as any[] };
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

/** Counts what the diary file would contribute, without touching the database. */
function analyzeDiary(sdnDoc: any, knownSdnIds: Set<number>) {
    const stats = { plans: 0, activities: 0, attendanceMarks: 0, blankMarks: 0, progressEntries: 0, unknownStudents: [] as string[] };
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
    const canonical: CanonicalStudent[] = reconcile(base, sdnRecords, report);

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
        sched.conflicts.slice(0, 20).forEach((c) => console.log(`  ⚠ ${c.day} ${c.time} — ${c.student}: ${c.therapists.join(' | ')}`));
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

    if (report.notes.length) {
        console.log('\n--- links made on a name match (worth a look) ---');
        report.notes.forEach((n) => console.log(`  • ${n}`));
    }
    if (report.problems.length) {
        console.log('\n--- problems ---');
        report.problems.forEach((p) => console.log(`  ! ${p}`));
    }

    if (!apply) {
        console.log('\nDry run finished. Re-run with --apply to write these records.\n');
        await pool.end();
        return;
    }

    const notesBefore = report.notes.length;
    const problemsBefore = report.problems.length;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await writeAll(client, canonical, base, sdnDoc, report);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

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
    if (report.notes.length > notesBefore) {
        console.log('\n--- noticed while writing (worth a look) ---');
        report.notes.slice(notesBefore).forEach((n) => console.log(`  • ${n}`));
    }
    if (report.problems.length > problemsBefore) {
        console.log('\n--- problems found while writing ---');
        report.problems.slice(problemsBefore).forEach((p) => console.log(`  ! ${p}`));
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
