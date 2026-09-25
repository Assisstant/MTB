/**
 * A colleague's own week in the teaching timetable, and what a change to it
 * does to somebody else (docs/PLAN-kolegi-online.md, step 2).
 *
 * THE OWNER'S RULE, 25 Sep 2026: every entry is compared with the group
 * timetable. A clash is shown BEFORE it is saved; the person may still save
 * it, and then the clash stands, recorded, until one side moves — and the
 * colleague it hits sees it on their own form. Everything keeps working while
 * clashes exist.
 *
 * WHAT IS A CLASH HERE.
 *   - A subject teacher puts their lesson into a class and period where
 *     another teacher already has a DIFFERENT subject. The same subject is
 *     two teachers together (physical education, owner, 24 Sep) and is not a
 *     clash. A lesson nobody has put a name to is nobody's, and is taken over.
 *   - A homeroom teacher changes a period of their class that another teacher
 *     holds, or puts a teacher there who is in another class at that time.
 *
 * The writes go through the ONE lesson writer (`teaching-edit.ts`), with the
 * same `expected` check as Уреди настава: a colleague looking at a stale
 * week cannot overwrite what changed meanwhile.
 */
import type { PoolClient } from 'pg';
import { cellAt, putLesson, putTeacherLesson, tidy } from './teaching-edit.js';

type Queryable = Pick<PoolClient, 'query'>;

export type WeekLesson = {
    id: number; day: string; ordinal: number; classId: number; class: string;
    subject: string | null; teacherId: number | null; teacher: string | null;
};

export async function yearLessons(db: Queryable, yearId: number): Promise<WeekLesson[]> {
    const { rows } = await db.query(
        `SELECT l.id, l.day, l.ordinal, l.class_id AS "classId", c.label AS class, l.subject,
                l.teacher_id AS "teacherId", t.name AS teacher
           FROM lessons l
           JOIN school_classes c ON c.id = l.class_id
           LEFT JOIN teachers t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1
          ORDER BY l.day_order, l.ordinal, c.sort_key, c.label`, [yearId]);
    return rows;
}

export async function yearClasses(db: Queryable, yearId: number) {
    const { rows } = await db.query(
        `SELECT c.id, c.label, cy.description,
                (SELECT t.id FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
                  WHERE tc.class_id = c.id AND tc.school_year_id = $1 AND tc.role = 'homeroom'
                  ORDER BY t.name LIMIT 1) AS "homeroomId",
                (SELECT t.name FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
                  WHERE tc.class_id = c.id AND tc.school_year_id = $1 AND tc.role = 'homeroom'
                  ORDER BY t.name LIMIT 1) AS homeroom
           FROM class_years cy JOIN school_classes c ON c.id = cy.class_id
          WHERE cy.school_year_id = $1 AND cy.active
          ORDER BY c.sort_key, c.label`, [yearId]);
    return rows as Array<{ id: number; label: string; description: string | null; homeroomId: number | null; homeroom: string | null }>;
}

export async function yearTeachers(db: Queryable, yearId: number) {
    const { rows } = await db.query(
        `SELECT t.id, t.name, t.subject, t.employee_id AS "employeeId"
           FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
          ORDER BY t.name`, [yearId]);
    return rows as Array<{ id: number; name: string; subject: string | null; employeeId: number }>;
}

const sameSubject = (a: string | null, b: string | null) =>
    String(tidy(a) || '').toLocaleLowerCase('mk-MK') === String(tidy(b) || '').toLocaleLowerCase('mk-MK');

export type Clash = { teacherId: number | null; teacher: string | null; class: string; subject: string | null; why: 'class-taken' | 'lesson-replaced' | 'teacher-busy' };

/** Who a subject teacher's lesson in `classLabel` would sit on top of. */
export function myLessonClashes(lessons: WeekLesson[], w: { teacherId: number; day: string; ordinal: number; classLabel: string; subject: string | null }): Clash[] {
    return lessons
        .filter((l) => l.day === w.day && l.ordinal === w.ordinal && l.class === w.classLabel)
        .filter((l) => l.teacherId != null && l.teacherId !== w.teacherId && !sameSubject(l.subject, w.subject))
        .map((l) => ({ teacherId: l.teacherId, teacher: l.teacher, class: l.class, subject: l.subject, why: 'class-taken' as const }));
}

/** Who a homeroom teacher's change to a period of their class hits. */
export function classLessonClashes(lessons: WeekLesson[], w: { meId: number; day: string; ordinal: number; classLabel: string; subject: string | null; teacherId: number | null }): Clash[] {
    const out: Clash[] = [];
    const here = lessons.filter((l) => l.day === w.day && l.ordinal === w.ordinal && l.class === w.classLabel);
    for (const l of here) {
        // Another teacher's lesson that this write changes or takes away.
        if (l.teacherId != null && l.teacherId !== w.meId && l.teacherId !== w.teacherId) {
            out.push({ teacherId: l.teacherId, teacher: l.teacher, class: l.class, subject: l.subject, why: 'lesson-replaced' });
        }
    }
    if (w.teacherId != null) {
        for (const l of lessons) {
            if (l.day === w.day && l.ordinal === w.ordinal && l.teacherId === w.teacherId && l.class !== w.classLabel) {
                out.push({ teacherId: l.teacherId, teacher: l.teacher, class: l.class, subject: l.subject, why: 'teacher-busy' });
            }
        }
    }
    return out;
}

/** Every clash standing in the timetable that involves this teacher or their class. */
export function standingClashes(lessons: WeekLesson[], teacherId: number | null, homeroomClasses: string[]) {
    const byCell = new Map<string, WeekLesson[]>();
    for (const l of lessons) {
        const key = `${l.day}|${l.ordinal}|${l.class}`;
        if (!byCell.has(key)) byCell.set(key, []);
        byCell.get(key)!.push(l);
    }
    const out: Array<{ day: string; ordinal: number; class: string; lessons: WeekLesson[]; kind: 'class' | 'teacher' }> = [];
    for (const list of byCell.values()) {
        const named = list.filter((l) => l.teacherId != null);
        const subjects = new Set(list.map((l) => String(tidy(l.subject) || '').toLocaleLowerCase('mk-MK')));
        if (named.length < 2 || subjects.size < 2) continue;
        const mine = list.some((l) => l.teacherId === teacherId) || homeroomClasses.includes(list[0].class);
        if (mine) out.push({ day: list[0].day, ordinal: list[0].ordinal, class: list[0].class, lessons: list, kind: 'class' });
    }
    if (teacherId != null) {
        const byTime = new Map<string, WeekLesson[]>();
        for (const l of lessons.filter((x) => x.teacherId === teacherId)) {
            const key = `${l.day}|${l.ordinal}`;
            if (!byTime.has(key)) byTime.set(key, []);
            byTime.get(key)!.push(l);
        }
        for (const list of byTime.values()) {
            if (list.length > 1) out.push({ day: list[0].day, ordinal: list[0].ordinal, class: list.map((l) => l.class).join(' + '), lessons: list, kind: 'teacher' });
        }
    }
    return out;
}

/** The sentence a notice says, in the words of the form. */
export function noticeSentence(author: string, c: Clash, w: { day: string; ordinal: number; classLabel: string; subject: string | null; teacher?: string | null }) {
    const when = `${w.day}, ${w.ordinal}. час`;
    const what = w.subject ? `„${w.subject}"` : 'час';
    if (c.why === 'class-taken') {
        return `${author} запиша ${what} во ${w.classLabel}, ${when}, каде вие имате „${c.subject || 'час'}". Договорете се кој ќе го премести својот час.`;
    }
    if (c.why === 'lesson-replaced') {
        return `${author} го смени часот во ${w.classLabel}, ${when}: наместо вашиот „${c.subject || 'час'}" сега е ${what}`
            + (w.teacher ? ` кај ${w.teacher}` : '') + '.';
    }
    return `${author} ве стави во ${w.classLabel}, ${when} (${what}), а тогаш имате ${c.class}${c.subject ? ` („${c.subject}")` : ''}.`;
}

export async function addNotices(db: Queryable, n: {
    yearId: number; authorEmployeeId: number; authorName: string; day: string; slot: string; about: string;
    recipients: Array<{ teacherId: number; sentence: string }>;
}): Promise<number> {
    let added = 0;
    const seen = new Set<number>();
    for (const r of n.recipients) {
        const { rows } = await db.query('SELECT employee_id FROM teachers WHERE id = $1', [r.teacherId]);
        const employee = rows[0] && rows[0].employee_id;
        if (!employee || employee === n.authorEmployeeId || seen.has(employee)) continue;
        seen.add(employee);
        await db.query(
            `INSERT INTO schedule_notices (school_year_id, author_employee_id, author_name, recipient_employee_id, kind, day, slot, about, sentence)
             VALUES ($1, $2, $3, $4, 'lesson', $5, $6, $7, $8)`,
            [n.yearId, n.authorEmployeeId, n.authorName, employee, n.day, n.slot, n.about, r.sentence]);
        added++;
    }
    return added;
}

export { cellAt, putLesson, putTeacherLesson };
