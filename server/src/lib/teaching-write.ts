/**
 * Writing a parsed timetable into the tables.
 *
 * The timetable is a REPLACEMENT, not an accumulation: a school publishes one
 * timetable and then publishes a corrected one, and the corrected one is the
 * truth. So lessons are cleared and rewritten inside the caller's transaction.
 * Teachers and classes are upserted rather than cleared, because other rows
 * point at them and because a teacher who is off sick for a term should not
 * vanish and come back with a new id.
 *
 * The same safeguard as everywhere else applies: an empty parse never empties
 * a populated table (rule 3). A workbook that produced no lessons is a failed
 * read, not a school with no classes.
 */

import { classSortKey, type ParsedTimetable } from './teaching.js';
import { noteTeacherClass } from './teaching-edit.js';
import { personName } from './import-core.js';

export interface TeachingWriteResult {
    classes: number;
    teachers: number;
    lessons: number;
    replaced: number;
    skipped: boolean;
    problems: string[];
    notes: string[];
}

export interface TeachingYear {
    id: number;
    label: string;
}

export async function writeTeaching(
    client: any,
    parsed: ParsedTimetable,
    year: TeachingYear
): Promise<TeachingWriteResult> {
    const result: TeachingWriteResult = {
        classes: 0, teachers: 0, lessons: 0, replaced: 0,
        skipped: false, problems: [...parsed.problems], notes: [...parsed.notes]
    };

    const existing = (await client.query(
        'SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1',
        [year.id]
    )).rows[0].n as number;
    if (!parsed.lessons.length) {
        result.skipped = true;
        result.problems.push(
            existing > 0
                ? `The workbook produced no lessons while the database holds ${existing} — nothing written. Check the sheet before importing.`
                : 'The workbook produced no lessons.'
        );
        return result;
    }
    if (existing > 20 && parsed.lessons.length < existing / 2) {
        result.skipped = true;
        result.problems.push(
            `The workbook has ${parsed.lessons.length} lessons while the database holds ${existing} — that is less than half, so nothing was written. Pass --force if the timetable really did shrink.`
        );
        return result;
    }

    // ── classes ─────────────────────────────────────────────────────────────
    const classId = new Map<string, number>();
    for (const label of parsed.classes) {
        const { rows } = await client.query(
            `INSERT INTO school_classes (label, sort_key) VALUES ($1, $2)
             ON CONFLICT (label) DO UPDATE SET sort_key = EXCLUDED.sort_key
             RETURNING id`,
            [label, classSortKey(label)]
        );
        classId.set(label, rows[0].id);
    }
    result.classes = classId.size;
    if (classId.size) {
        await client.query(
            `INSERT INTO class_years (school_year_id, class_id, active)
             SELECT $1, unnest($2::int[]), true
             ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
            [year.id, [...classId.values()]]
        );
    }

    // ── teachers ────────────────────────────────────────────────────────────
    // Homeroom is set in a second pass: a teacher's own class may not have
    // existed yet when the row was first written.
    const teacherId = new Map<string, number>();
    for (const t of parsed.teachers) {
        // The workbook writes the staff in capitals; the database keeps one
        // spelling for everybody (see personName). The map is still keyed on
        // the RAW parsed name, because that is what the lesson rows below
        // were parsed with.
        const name = personName(t.name);
        // Resolved case-insensitively, and this is not tidiness. The unique
        // key is the exact string, so „АНА ТЕСТОВА" and „Ана Тестова"
        // are two rows to `ON CONFLICT (name)` — which is exactly what would
        // happen after somebody edited a teacher in `Podatoci.html` and the
        // workbook was then re-imported. The year's lessons would attach to
        // the new row while `teacher_classes` still pointed at the old one,
        // and both would be listed on screen.
        const found = await client.query(
            'SELECT id FROM teachers WHERE lower(btrim(name)) = lower(btrim($1))', [name]
        );
        let id: number;
        if (found.rows.length) {
            id = found.rows[0].id;
            await client.query(
                `UPDATE teachers SET kind = $2,
                    -- A subject typed in by hand outlives a re-import that
                    -- does not know it: only fill a blank, never clear one.
                    subject = COALESCE(subject, NULLIF($3, ''))
                 WHERE id = $1`,
                [id, t.kind, t.subject]
            );
            // The NAME is deliberately not written back. A workbook that
            // still says „АНА ТЕСТОВА" must not undo a correction somebody
            // made on the screen — same rule as the subject above.
        } else {
            const { rows } = await client.query(
                `INSERT INTO teachers (name, kind, subject) VALUES ($1, $2, NULLIF($3, ''))
                 RETURNING id`,
                [name, t.kind, t.subject]
            );
            id = rows[0].id;
        }
        teacherId.set(t.name, id);
    }
    if (teacherId.size) {
        await client.query(
            `INSERT INTO teacher_years (school_year_id, teacher_id, active)
             SELECT $1, unnest($2::int[]), true
             ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`,
            [year.id, [...teacherId.values()]]
        );
    }
    // The homeroom is recorded per YEAR (migration 016). It used to be one
    // column on the teacher, which meant importing this year quietly rewrote
    // what last year said — and an archived timetable then named the wrong
    // teacher. It only ever ADDS: a class somebody typed in by hand is not
    // contradicted by a workbook that happens not to mention it.
    for (const t of parsed.teachers) {
        const home = t.homeroom ? classId.get(t.homeroom) ?? null : null;
        if (home) await noteTeacherClass(client, year.id, teacherId.get(t.name)!, home, 'homeroom');
    }
    result.teachers = teacherId.size;

    // ── lessons ─────────────────────────────────────────────────────────────
    const cleared = await client.query('DELETE FROM lessons WHERE school_year_id = $1', [year.id]);
    result.replaced = cleared.rowCount ?? 0;

    let written = 0;
    for (const l of parsed.lessons) {
        const cid = classId.get(l.classLabel);
        if (!cid) {
            result.problems.push(`Lesson for unknown class "${l.classLabel}" (${l.day}, period ${l.ordinal}) skipped.`);
            continue;
        }
        const tid = teacherId.get(l.teacher) ?? null;
        const res = await client.query(
            `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''))
             ON CONFLICT (school_year_id, day, ordinal, class_id, teacher_id)
             DO UPDATE SET subject = EXCLUDED.subject`,
            [year.id, l.day, l.dayOrder, l.ordinal, cid, tid, l.subject]
        );
        written += res.rowCount ?? 0;
        // Teaching a class IS belonging to it. Recording that here is what
        // makes the assignment list useful the moment a workbook is imported,
        // instead of a blank screen somebody has to fill in twice.
        if (tid) await noteTeacherClass(client, year.id, tid, cid, 'subject');
    }
    result.lessons = written;

    const { rows: clashes } = await client.query(
        `SELECT day, ordinal, class, who FROM teaching_clashes
         WHERE school_year = $1 ORDER BY day_order, ordinal`,
        [year.label]
    );
    clashes.forEach((c: any) => {
        result.problems.push(`${c.day}, period ${c.ordinal}: ${c.class} is claimed by more than one teacher — ${c.who}`);
    });

    return result;
}
