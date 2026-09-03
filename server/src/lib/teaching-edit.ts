/**
 * Editing the teaching timetable by hand, one cell at a time.
 *
 * Until now the timetable had exactly one way in: `npm run import:teaching`,
 * which REPLACES a whole year from the school's workbook. That is the right
 * shape for September and the wrong shape for the rest of the year, when what
 * actually happens is one change at a time — a teacher leaves in November, two
 * classes swap a period in February, somebody notices in March that Tuesday's
 * fourth is wrong. Re-importing a corrected workbook for a single cell throws
 * away every hand correction made since the last import.
 *
 * So the rules of editing live here rather than in the route, for the reason
 * this project keeps rediscovering: a second caller writing the same rows a
 * slightly different way is a disagreement waiting to happen, and it stays
 * invisible until two screens show different numbers.
 *
 * Three things are deliberately NOT possible:
 *
 *   - deleting a class or a teacher. A class with no lessons this year is a
 *     class that is not timetabled, which is a different fact from "does not
 *     exist" — and both rows are pointed at by lessons in ARCHIVED years, which
 *     must keep reading correctly for ever. Clearing a class out of a year is
 *     done by deleting its lessons, and its archived year keeps its own.
 *   - editing a cell that holds two lessons. That is a real clash from the
 *     workbook, and writing "the" lesson would silently pick one of them. The
 *     caller is told what is there and deletes one first.
 *   - copying a year on top of a year that already has lessons, unless the
 *     caller says so in as many words.
 */

import { classSortKey, dayOrderOf } from './teaching.js';

export interface TeachingYear {
    id: number;
    label: string;
}

/** What a cell holds right now, as a person would read it. */
export interface LessonCell {
    id: number;
    subject: string | null;
    teacher: string | null;
    teacherId: number | null;
}

export interface LessonKey {
    yearId: number;
    day: string;
    ordinal: number;
    classId: number;
}

export type LessonExpectation = { subject: string | null; teacher: string | null } | null;

export type LessonWrite =
    | { ok: true; action: 'inserted' | 'updated' | 'unchanged'; lesson: LessonCell }
    | { ok: false; code: 'clash'; here: LessonCell[] }
    | { ok: false; code: 'conflict'; here: LessonCell[] };

/** Blank, '—' and a stray space all mean the same thing: nothing is written. */
export function tidy(value: unknown): string | null {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!s || s === '—' || s === '-' || s === '/') return null;
    return s;
}

/** The rows sitting in one (year, day, period, class), which is normally 0 or 1. */
export async function cellAt(client: any, key: LessonKey): Promise<LessonCell[]> {
    const { rows } = await client.query(
        `SELECT l.id, l.subject, l.teacher_id AS "teacherId", t.name AS teacher
         FROM lessons l LEFT JOIN teachers t ON t.id = l.teacher_id
         WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = $3 AND l.class_id = $4
         ORDER BY l.id`,
        [key.yearId, key.day, key.ordinal, key.classId]
    );
    return rows as LessonCell[];
}

const same = (a: string | null, b: string | null) => (a ?? '') === (b ?? '');

/**
 * Write one cell.
 *
 * `expected` is the same idea as everywhere else in this project — the caller
 * says what it believes is there and gets a 409 naming what really is, rather
 * than a silent overwrite. Here it matters less than in Rasporedi (one person
 * edits a timetable, not ten) and it is still worth having: a tab left open
 * since morning is a stale view of a table somebody else may have imported
 * over in the meantime. `expected: null` means "I believe this cell is empty".
 * Omitted means "do not check".
 */
export async function putLesson(
    client: any,
    key: LessonKey,
    value: { subject: string | null; teacherId: number | null },
    expected?: LessonExpectation
): Promise<LessonWrite> {
    const here = await cellAt(client, key);
    if (here.length > 1) return { ok: false, code: 'clash', here };

    if (expected !== undefined) {
        const now = here[0] ?? null;
        const agrees = expected === null
            ? now === null
            : !!now && same(tidy(now.subject), tidy(expected.subject)) && same(tidy(now.teacher), tidy(expected.teacher));
        if (!agrees) return { ok: false, code: 'conflict', here };
    }

    const subject = tidy(value.subject);
    const teacherId = value.teacherId ?? null;

    if (here.length === 1) {
        if (same(tidy(here[0].subject), subject) && (here[0].teacherId ?? null) === teacherId) {
            return { ok: true, action: 'unchanged', lesson: here[0] };
        }
        const { rows } = await client.query(
            `UPDATE lessons SET subject = $2, teacher_id = $3 WHERE id = $1
             RETURNING id, subject, teacher_id AS "teacherId",
                       (SELECT name FROM teachers WHERE id = $3) AS teacher`,
            [here[0].id, subject, teacherId]
        );
        return { ok: true, action: 'updated', lesson: rows[0] };
    }

    const { rows } = await client.query(
        `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, subject, teacher_id AS "teacherId",
                   (SELECT name FROM teachers WHERE id = $6) AS teacher`,
        [key.yearId, key.day, dayOrderOf(key.day), key.ordinal, key.classId, teacherId, subject]
    );
    return { ok: true, action: 'inserted', lesson: rows[0] };
}

export interface CopyResult {
    from: string;
    to: string;
    /** Lessons that would be (or were) written into the target year. */
    lessons: number;
    /** Lessons already in the target year, which `replace` would remove. */
    existing: number;
    removed: number;
    applied: boolean;
    problems: string[];
    notes: string[];
}

/**
 * Last year's timetable as this year's starting point.
 *
 * A school's timetable in September is mostly last year's with the classes
 * moved up a year and a few teachers swapped, and typing 450 cells from blank
 * to find that out is nobody's idea of a working morning. So the year is
 * copied and then CORRECTED, which is the order the work really happens in.
 *
 * What is copied is deliberately literal: the same class, the same teacher,
 * the same subject, the same day and period. Classes are NOT promoted — IV-б
 * stays IV-б and does not become V-б. That looks like the obvious convenience
 * and it is a trap: a school timetables a CLASSROOM of children, so last
 * year's IV-б timetable belongs to this year's IV-б (a different set of
 * children, one year younger) and not to the children who moved up. Promoting
 * the label would put the new fourth-graders on the fifth grade's timetable
 * and it would look entirely plausible.
 *
 * Dry run unless `apply`, like every other write in this project.
 */
export async function copyYearLessons(
    client: any,
    from: TeachingYear,
    to: TeachingYear,
    opts: { replace?: boolean; apply?: boolean } = {}
): Promise<CopyResult> {
    const result: CopyResult = {
        from: from.label, to: to.label,
        lessons: 0, existing: 0, removed: 0,
        applied: false, problems: [], notes: []
    };

    if (from.id === to.id) {
        result.problems.push('The source and the target are the same school year.');
        return result;
    }

    const count = async (yearId: number) =>
        (await client.query('SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1', [yearId])).rows[0].n as number;

    result.lessons = await count(from.id);
    result.existing = await count(to.id);

    if (!result.lessons) {
        result.problems.push(`${from.label} has no timetable to copy.`);
        return result;
    }
    if (result.existing && !opts.replace) {
        result.problems.push(
            `${to.label} already has ${result.existing} lessons. Nothing was copied — `
            + 'say so explicitly (замени / --replace) if they really are to be thrown away.'
        );
        return result;
    }

    result.notes.push(
        `${result.lessons} lessons from ${from.label} → ${to.label}`
        + (result.existing ? `, replacing ${result.existing}` : '')
    );
    result.notes.push('Classes keep their labels: IV-б stays IV-б. The timetable belongs to the classroom, not to the children who moved up.');

    if (!opts.apply) return result;

    if (result.existing) {
        const cleared = await client.query('DELETE FROM lessons WHERE school_year_id = $1', [to.id]);
        result.removed = cleared.rowCount ?? 0;
    }
    const written = await client.query(
        `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
         SELECT $2::integer, day, day_order, ordinal, class_id, teacher_id, subject
         FROM lessons WHERE school_year_id = $1
         ON CONFLICT (school_year_id, day, ordinal, class_id, teacher_id) DO NOTHING`,
        [from.id, to.id]
    );
    await client.query(
        `INSERT INTO class_years (school_year_id, class_id, active)
         SELECT DISTINCT $2::integer, class_id, true FROM lessons WHERE school_year_id = $1
         ON CONFLICT (school_year_id, class_id) DO UPDATE SET active = true`,
        [from.id, to.id]
    );
    await client.query(
        `INSERT INTO teacher_years (school_year_id, teacher_id, active)
         SELECT DISTINCT $2::integer, teacher_id, true FROM lessons
         WHERE school_year_id = $1 AND teacher_id IS NOT NULL
         ON CONFLICT (school_year_id, teacher_id) DO UPDATE SET active = true`,
        [from.id, to.id]
    );
    result.lessons = written.rowCount ?? 0;
    result.applied = true;
    return result;
}

export type ClassRole = 'homeroom' | 'subject';
export interface TeacherClass { label: string; role: ClassRole }

/**
 * Which classes a teacher has THIS year.
 *
 * Replaced as a set rather than written one row at a time, which is the
 * opposite of how a schedule cell is written — and deliberately so. A cell is
 * contended: two people edit different cells of one week and a whole-document
 * save destroys one of them. A teacher's class list is not: it is three or
 * four labels on one screen, edited by one person, and there is no `expected`
 * that means anything for a set. Replacing it is what the screen shows the
 * person doing.
 *
 * Scoped to (year, teacher) and nothing wider, so the blast radius is one
 * person's list in one year even if two people somehow do it at once.
 */
export async function setTeacherClasses(
    client: any,
    yearId: number,
    teacherId: number,
    classes: TeacherClass[]
): Promise<{ written: number }> {
    await client.query(
        'DELETE FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2',
        [yearId, teacherId]
    );
    let written = 0;
    for (const entry of classes) {
        const label = tidy(entry.label);
        if (!label) continue;
        const res = await client.query(
            `INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
             SELECT $1, $2, c.id, $4 FROM school_classes c WHERE c.label = $3
             ON CONFLICT (school_year_id, teacher_id, class_id)
             DO UPDATE SET role = EXCLUDED.role`,
            [yearId, teacherId, label, entry.role === 'homeroom' ? 'homeroom' : 'subject']
        );
        written += res.rowCount ?? 0;
    }
    return { written };
}

/**
 * Who holds ONE class in one school year.
 *
 * This is the class-centred counterpart of `setTeacherClasses`. It replaces
 * only (year, class), so changing IV-б's homeroom cannot disturb the same
 * teacher's other classes or any archived year. A single transaction around
 * this helper makes "new homeroom + subject teachers" one decision rather
 * than a sequence of half-applied teacher edits.
 */
export async function setClassTeachers(
    client: any,
    yearId: number,
    classId: number,
    homeroomTeacherId: number | null,
    subjectTeacherIds: number[]
): Promise<{ written: number }> {
    const roles = new Map<number, ClassRole>();
    for (const id of subjectTeacherIds) roles.set(id, 'subject');
    if (homeroomTeacherId !== null) roles.set(homeroomTeacherId, 'homeroom');

    await client.query(
        'DELETE FROM teacher_classes WHERE school_year_id = $1 AND class_id = $2',
        [yearId, classId]
    );
    let written = 0;
    for (const [teacherId, role] of roles) {
        const result = await client.query(
            `INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
             VALUES ($1, $2, $3, $4)`,
            [yearId, teacherId, classId, role]
        );
        written += result.rowCount ?? 0;
    }
    return { written };
}

/**
 * Note that a teacher has a class, without disturbing what is already there.
 *
 * This is the importer's path: a workbook says who teaches whom, and that is
 * evidence a teacher belongs to a class — but it is NOT evidence that they do
 * not belong to another one somebody typed in by hand. So it only ever adds,
 * and 'homeroom' outranks 'subject' when both are claimed.
 */
export async function noteTeacherClass(
    client: any,
    yearId: number,
    teacherId: number,
    classId: number,
    role: ClassRole
): Promise<void> {
    await client.query(
        `INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (school_year_id, teacher_id, class_id) DO UPDATE
            SET role = CASE WHEN teacher_classes.role = 'homeroom' OR EXCLUDED.role = 'homeroom'
                            THEN 'homeroom' ELSE teacher_classes.role END`,
        [yearId, teacherId, classId, role]
    );
}

/**
 * A class, created if the school has never had one by that name.
 *
 * `sort_key` is recomputed on every upsert rather than only on insert, because
 * it is derived from the label and a stale one puts X before II in every grid
 * that trusts ORDER BY.
 */
export async function upsertClass(client: any, label: string): Promise<{ id: number; label: string; created: boolean }> {
    const clean = tidy(label);
    if (!clean) throw new Error('a class needs a label');
    const before = await client.query('SELECT id FROM school_classes WHERE label = $1', [clean]);
    const { rows } = await client.query(
        `INSERT INTO school_classes (label, sort_key) VALUES ($1, $2)
         ON CONFLICT (label) DO UPDATE SET sort_key = EXCLUDED.sort_key
         RETURNING id, label`,
        [clean, classSortKey(clean)]
    );
    return { id: rows[0].id, label: rows[0].label, created: !before.rows.length };
}
