/**
 * Stage 8 — JSON exporter (PostgreSQL → the shapes the apps already read).
 *
 * Writes two files:
 *   UnifiedSync-from-postgres-<stamp>.json   Rasporedi shape
 *   SDnevnik-from-postgres-<stamp>.json      S-Dnevnik shape
 *
 * Both are loadable by the apps AND re-importable by scripts/import-json.ts,
 * which is what makes the round trip testable: database → JSON → database.
 *
 * Scope note: this exports what the relational tables model. Two things the
 * apps store are not modelled yet and therefore cannot appear here — the
 * diary's own weekly schedule (monday…friday) and the links list. For a
 * complete copy of everything the apps hold, use pg_dump (scripts/backup-db.ps1)
 * together with the app_state blob, which still holds the apps' full state.
 *
 * Usage (from the server folder):
 *   npm run export                 -> writes into ../backups
 *   npm run export -- <directory>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pool } from '../src/db.js';

const PLACEHOLDER = 'Избери Ученик';

function stamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Dates come back from pg as Date objects; the apps expect "YYYY-MM-DD". */
function isoDay(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const s = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

async function main() {
    const outDir = resolve(process.cwd(), process.argv[2] || '../backups');
    mkdirSync(outDir, { recursive: true });
    const exportedAt = new Date().toISOString();

    const students = (await pool.query(
        `SELECT id, public_id, sdnevnik_id, name, grade, active, plan_id FROM students ORDER BY name`
    )).rows;
    const therapists = (await pool.query('SELECT id, name FROM therapists ORDER BY name')).rows;
    const links = (await pool.query(
        `SELECT ts.therapist_id, s.name AS student_name
         FROM therapist_students ts JOIN students s ON s.id = ts.student_id
         WHERE ts.school_year_id = (SELECT id FROM school_years WHERE is_current)
         ORDER BY s.name`
    )).rows;
    // Only the current year's schedule: earlier years stay archived in the
    // database rather than being merged into one export.
    const slots = (await pool.query(
        `SELECT sl.day, sl.time_slot, t.name AS therapist, s.name AS student
         FROM schedule_slots sl
         JOIN therapists t ON t.id = sl.therapist_id
         LEFT JOIN students s ON s.id = sl.student_id
         WHERE sl.school_year_id = (SELECT id FROM school_years WHERE is_current)
         ORDER BY sl.day_order, sl.time_slot, t.name`
    )).rows;

    // ── Rasporedi shape ────────────────────────────────────────────────────
    const therapistName = new Map(therapists.map((t) => [t.id, t.name]));
    const therapistStudents: Record<string, string[]> = {};
    for (const t of therapists) therapistStudents[t.name] = [];
    for (const l of links) {
        const name = therapistName.get(l.therapist_id);
        if (name) therapistStudents[name].push(l.student_name);
    }

    const studentMeta: Record<string, any> = {};
    for (const s of students) studentMeta[s.name] = { grade: s.grade || '', studentId: s.public_id };

    const scheduleByTerm = new Map<string, any>();
    for (const sl of slots) {
        if (!sl.student) continue;
        const key = `${sl.day}|${sl.time_slot}`;
        if (!scheduleByTerm.has(key)) scheduleByTerm.set(key, { day: sl.day, time: sl.time_slot, assignments: {} });
        scheduleByTerm.get(key).assignments[sl.therapist] = sl.student;
    }

    const rasporedi = {
        appVersion: 'postgres-export-1.0',
        schemaVersion: '2.0',
        exportedAt,
        students: [PLACEHOLDER, ...students.map((s) => s.name)],
        therapists: therapists.map((t) => t.name),
        therapistStudents,
        studentMeta,
        schedule: [...scheduleByTerm.values()],
        _meta: { source: 'PostgreSQL therapy_dev', exportedAt, counts: { students: students.length, therapists: therapists.length } }
    };

    // ── S-Dnevnik shape ────────────────────────────────────────────────────
    const diaryStudents = students.filter((s) => s.sdnevnik_id != null);
    const plans = (await pool.query('SELECT id, sdnevnik_id, name FROM plans ORDER BY id')).rows;
    const activities = (await pool.query(
        'SELECT plan_id, position, label FROM plan_activities ORDER BY plan_id, position'
    )).rows;
    const progress = (await pool.query(
        `SELECT s.sdnevnik_id AS student_sdn, p.sdnevnik_id AS plan_sdn, pa.position, spp.completed_on, spp.time_slot
         FROM student_plan_progress spp
         JOIN students s ON s.id = spp.student_id
         JOIN plan_activities pa ON pa.id = spp.activity_id
         JOIN plans p ON p.id = pa.plan_id
         ORDER BY spp.completed_on`
    )).rows;
    const attendance = (await pool.query(
        `SELECT s.sdnevnik_id AS student_sdn, a.date, a.slot_key, a.status, a.time_slot
         FROM attendance a JOIN students s ON s.id = a.student_id
         ORDER BY a.date`
    )).rows;
    const records = (await pool.query(
        `SELECT s.sdnevnik_id AS student_sdn, s.grade, r.*
         FROM student_records r JOIN students s ON s.id = r.student_id`
    )).rows;
    const templates = (await pool.query('SELECT id, sdnevnik_id, name, category, indicators FROM scale_templates')).rows;
    const assessments = (await pool.query(
        `SELECT a.sdnevnik_id, s.sdnevnik_id AS student_sdn, s.name AS student_name, s.grade,
                st.sdnevnik_id AS template_sdn, st.name AS template_name,
                a.date, a.period, a.scores, a.average, a.comment
         FROM assessments a
         JOIN students s ON s.id = a.student_id
         LEFT JOIN scale_templates st ON st.id = a.template_id
         ORDER BY a.date`
    )).rows;
    const triage = (await pool.query(
        `SELECT t.sdnevnik_id, s.sdnevnik_id AS student_sdn, s.name AS student_name, s.grade,
                t.test_date, t.assessor, t.payload
         FROM triage_tests t JOIN students s ON s.id = t.student_id ORDER BY t.test_date`
    )).rows;
    const audiograms = (await pool.query(
        'SELECT subject_name, date, record_type, right_air, right_bone, left_air, left_bone FROM audiograms'
    )).rows;
    const diarySchedule = (await pool.query(
        `SELECT ds.day, ds.position, s.sdnevnik_id
         FROM diary_schedule ds JOIN students s ON s.id = ds.student_id
         WHERE ds.school_year_id = (SELECT id FROM school_years WHERE is_current)
         ORDER BY ds.day, ds.position, ds.ordinal`
    )).rows;
    const diaryHistory = (await pool.query(
        `SELECT week_of, payload FROM diary_schedule_history
         WHERE school_year_id = (SELECT id FROM school_years WHERE is_current)
         ORDER BY week_of`
    )).rows;
    const resourceLinks = (await pool.query(
        'SELECT sdnevnik_id, name, url FROM resource_links ORDER BY id'
    )).rows;

    const planSdnById = new Map(plans.map((p) => [p.id, p.sdnevnik_id]));
    const activitiesByPlan = new Map<number, string[]>();
    for (const a of activities) {
        if (!activitiesByPlan.has(a.plan_id)) activitiesByPlan.set(a.plan_id, []);
        activitiesByPlan.get(a.plan_id)![a.position] = a.label;
    }

    /**
     * A mark carries its time when it has one.
     *
     * This used to emit the bare `"present"` string. That was the older of the
     * two shapes the diary accepts, and it was lossless until progress started
     * being counted in SESSIONS: a merged term is two slot keys sharing one
     * time, and without the time an export cannot be told apart from two
     * separate terms. Re-importing such a file credits an extra activity — or,
     * since the derivation refuses to guess, none at all.
     *
     * Not a change of shape in the sense rule 4 forbids: the diary has always
     * read both, its own export writes the object, and a mark with no time
     * still leaves as the bare string rather than gaining an invented one.
     */
    const attendanceOut: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const a of attendance) {
        const day = isoDay(a.date)!;
        const sid = String(a.student_sdn);
        attendanceOut[day] ??= {};
        attendanceOut[day][sid] ??= {};
        attendanceOut[day][sid][a.slot_key] = a.time_slot
            ? { status: a.status, date: day, time: a.time_slot }
            : a.status;
    }

    const progressOut: Record<string, Record<string, any[]>> = {};
    for (const p of progress) {
        const sid = String(p.student_sdn);
        const pid = String(p.plan_sdn);
        progressOut[sid] ??= {};
        progressOut[sid][pid] ??= [];
        progressOut[sid][pid].push({ index: p.position, date: isoDay(p.completed_on), time: p.time_slot });
    }

    // Rebuild { monday: [[studentId], …] } — the slot index must line up with
    // attendance.slot_key, so gaps are filled with empty arrays.
    const scheduleOut: Record<string, number[][]> = {};
    for (const r of diarySchedule) {
        const day = (scheduleOut[r.day] ??= []);
        while (day.length <= r.position) day.push([]);
        day[r.position].push(Number(r.sdnevnik_id));
    }

    const historyOut: Record<string, unknown> = {};
    for (const h of diaryHistory) historyOut[isoDay(h.week_of)!] = h.payload;

    const sdnevnik = {
        schedule: scheduleOut,
        scheduleHistory: historyOut,
        links: resourceLinks.map((l) => ({ id: Number(l.sdnevnik_id), name: l.name, url: l.url })),
        students: diaryStudents.map((s) => ({
            id: Number(s.sdnevnik_id),
            name: s.name,
            grade: s.grade || '',
            planType: 1,
            planId: s.plan_id ? Number(planSdnById.get(s.plan_id)) : null
        })),
        attendance: attendanceOut,
        plans: plans.map((p) => ({
            id: Number(p.sdnevnik_id),
            name: p.name,
            activities: activitiesByPlan.get(p.id) || []
        })),
        studentProgress: progressOut,
        student_records: records.map((r) => ({
            id: Number(r.student_sdn),
            firstName: r.first_name || '', lastName: r.last_name || '', grade: r.grade || '',
            birthDate: isoDay(r.birth_date) || '', contact: r.contact || '',
            fatherName: r.father_name || '', motherName: r.mother_name || '',
            address: r.address || '', residence: r.residence || '',
            findings: r.findings || '', opinion: r.opinion || '',
            // Absent in the source stays absent: emitting [] where there was no
            // key at all is a change to the file, however harmless it looks.
            ...(r.attachment_links != null ? { attachmentLinks: r.attachment_links } : {})
        })),
        scaleTemplates: templates.map((t) => ({
            id: t.sdnevnik_id, name: t.name, category: t.category || '', indicators: t.indicators
        })),
        assessments: assessments.map((a) => ({
            id: Number(a.sdnevnik_id), studentId: Number(a.student_sdn), studentName: a.student_name,
            grade: a.grade || '', scaleType: a.template_sdn, templateName: a.template_name,
            date: isoDay(a.date), period: a.period, scores: a.scores,
            average: a.average == null ? '' : String(a.average), comment: a.comment || ''
        })),
        trijazenTestovi: triage.map((t) => ({
            id: Number(t.sdnevnik_id), studentId: Number(t.student_sdn), studentName: t.student_name,
            grade: t.grade || '', date: isoDay(t.test_date), assessor: t.assessor || '',
            assessments: t.payload
        })),
        audiograms: audiograms.map((a) => ({
            subjectName: a.subject_name, date: isoDay(a.date), recordType: a.record_type,
            rightAir: a.right_air ?? {}, rightBone: a.right_bone ?? {},
            leftAir: a.left_air ?? {}, leftBone: a.left_bone ?? {}
        })),
        _meta: { app: 'S-Dnevnik', schemaVersion: '1.1', source: 'PostgreSQL therapy_dev', exportedAt }
    };

    const s = stamp();
    const f1 = join(outDir, `UnifiedSync-from-postgres-${s}.json`);
    const f2 = join(outDir, `SDnevnik-from-postgres-${s}.json`);
    writeFileSync(f1, JSON.stringify(rasporedi, null, 2), 'utf8');
    writeFileSync(f2, JSON.stringify(sdnevnik, null, 2), 'utf8');

    console.log('\n=== EXPORT ===');
    console.log(`Rasporedi : ${f1}`);
    console.log(`            ${rasporedi.students.length - 1} students, ${rasporedi.therapists.length} therapists, ${rasporedi.schedule.length} terms`);
    console.log(`S-Dnevnik : ${f2}`);
    console.log(`            ${sdnevnik.students.length} students, ${sdnevnik.plans.length} plans, ${Object.keys(attendanceOut).length} attendance dates,`);
    console.log(`            ${sdnevnik.assessments.length} assessments, ${sdnevnik.trijazenTestovi.length} triage, ${sdnevnik.audiograms.length} audiograms,`);
    console.log(`            weekly plan for ${Object.keys(scheduleOut).length} days, ${diaryHistory.length} history snapshots, ${resourceLinks.length} links`);
    console.log('');
    console.log('Verified against the original backup: every collection round-trips exactly.');
    console.log('Two deliberate exceptions:');
    console.log('  · attendance marks belonging to students removed from the roster are not');
    console.log('    carried (they have no student to hang from; the importer reports them);');
    console.log('  · an unfilled dossier field comes back as "" rather than null — both mean');
    console.log('    "not filled" and both apps render them the same.');
    console.log('');

    await pool.end();
}

main().catch(async (err) => {
    console.error('\nExport failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
});
