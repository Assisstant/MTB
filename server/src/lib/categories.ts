/**
 * Категории на стручни лица — the profile a person holds, and the action-plan
 * section that profile owns.
 *
 * A category is NOT a room. It is the kind of specialist writing the section:
 * логопед, психолог, педагог, сензорна интеграција. Therapists hold one, and
 * so do teachers — the school's teachers are special educators with a profile,
 * often without a room at all. `cabinet` was also already taken by the therapy
 * bell schedule (`bell_periods.kind = 'kabinet'`), which is why migration 024
 * renamed it.
 *
 * The nine-plus rows are SEEDS, not code. Rename them, retire them, add your
 * own; nothing in here knows any of them by name.
 *
 * ONE MAPPING, TWO CALLERS. The derivation lives here rather than in a route,
 * for the reason `lib/records.ts` exists: the sheet read and the "which
 * categories" endpoint must agree.
 */

import { pool } from '../db.js';
import { normalizeClassLabel } from './crossing.js';
import type { PersonKind } from './evidence.js';
import type { PoolClient } from 'pg';

export type { PersonKind };

/** A transaction client or the shared pool; both expose the same query API. */
type QueryExecutor = Pick<PoolClient, 'query'>;

export type Category = {
    id: number;
    code: string;
    name: string;
    ord: number;
    active: boolean;
};

const row = (r: any): Category => ({
    id: r.id, code: r.code, name: r.name, ord: r.ord, active: r.active
});

export class CategoryRefused extends Error {
    constructor(public status: number, message: string, public detail: Record<string, unknown> = {}) {
        super(message);
    }
}

export async function listCategories(includeInactive = false): Promise<Category[]> {
    const rows = await pool.query(
        `SELECT id, code, name, ord, active FROM specialist_categories
          WHERE ($1::boolean OR active)
          ORDER BY ord, name`, [includeInactive]);
    return rows.rows.map(row);
}

/**
 * A code is a stable ASCII key; the name is what people read and may change.
 *
 * The code is SLUGGED: anything outside [a-z0-9_] becomes an underscore, so
 * „Логопед" or "spec-edukator" typed by a person is stored in one canonical
 * shape and a later import cannot create a near-duplicate that only differs by
 * a hyphen.
 */
export async function createCategory(code: string, name: string, ord: number) {
    const clean = code.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!clean) throw new CategoryRefused(400, 'Кодот мора да има букви или бројки.');
    const exists = await pool.query(
        'SELECT id FROM specialist_categories WHERE code = $1', [clean]);
    if (exists.rowCount) throw new CategoryRefused(409, 'Веќе постои категорија со тој код.', { code: clean });
    const made = await pool.query(
        `INSERT INTO specialist_categories (code, name, ord)
         VALUES ($1, $2, $3) RETURNING id, code, name, ord, active`,
        [clean, name.trim(), ord]);
    return row(made.rows[0]);
}

/**
 * Renaming takes the name the caller believes it is changing.
 *
 * The same row-level check as everywhere else here: a tab left open since
 * morning is a stale view, and renaming a category silently over somebody
 * else's rename is the kind of loss nothing on screen would report.
 */
export async function renameCategory(id: number, name: string, expected?: string) {
    const saved = await pool.query(
        `UPDATE specialist_categories SET name = $2 WHERE id = $1
             AND ($3::text IS NULL OR name = $3)
      RETURNING id, code, name, ord, active`, [id, name.trim(), expected ?? null]);
    if (!saved.rowCount) {
        const found = await pool.query(
            'SELECT name FROM specialist_categories WHERE id = $1', [id]);
        if (!found.rowCount) throw new CategoryRefused(404, 'Нема таква категорија.');
        throw new CategoryRefused(409, 'Името е сменето од друг уред.', {
            actual: found.rows[0].name
        });
    }
    return row(saved.rows[0]);
}

/**
 * Retirement, never deletion — archived sheets and sections point at it, and a
 * category nobody staffs this year is a different fact from one that never
 * existed. Same reasoning as `roster-write.ts` having no DELETE.
 */
export async function setCategoryActive(id: number, active: boolean) {
    const saved = await pool.query(
        `UPDATE specialist_categories SET active = $2 WHERE id = $1
      RETURNING id, code, name, ord, active`, [id, active]);
    if (!saved.rowCount) throw new CategoryRefused(404, 'Нема таква категорија.');
    return row(saved.rows[0]);
}

/** Everyone on a year's list, therapists and teachers alike, with their profile. */
export async function categoryHolders(schoolYearId: number) {
    const therapists = await pool.query(
        `SELECT t.id, t.name, ty.active, c.id AS category_id, c.name AS category_name
           FROM therapist_years ty
           JOIN therapists t ON t.id = ty.therapist_id
           LEFT JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ty.school_year_id = $1 ORDER BY t.name`, [schoolYearId]);
    const teachers = await pool.query(
        `SELECT t.id, t.name, ty.active, c.id AS category_id, c.name AS category_name
           FROM teacher_years ty
           JOIN teachers t ON t.id = ty.teacher_id
           LEFT JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ty.school_year_id = $1 ORDER BY t.name`, [schoolYearId]);
    const shape = (kind: PersonKind) => (r: any) => ({
        kind, personId: r.id, name: r.name, active: r.active,
        categoryId: r.category_id, categoryName: r.category_name
    });
    return {
        therapists: therapists.rows.map(shape('therapist')),
        teachers: teachers.rows.map(shape('teacher'))
    };
}

/**
 * Record the profile a person holds in a year.
 *
 * Refuses when they are not on that year's list. Creating the membership here
 * would put somebody back on a year they were deliberately taken off — the
 * re-activation trap `roster-write.ts` already had to give up.
 */
export async function setPersonCategory(
    schoolYearId: number, kind: PersonKind, personId: number, categoryId: number | null
) {
    const table = kind === 'teacher' ? 'teacher_years' : 'therapist_years';
    const column = kind === 'teacher' ? 'teacher_id' : 'therapist_id';
    const updated = await pool.query(
        `UPDATE ${table} SET category_id = $3
          WHERE school_year_id = $1 AND ${column} = $2 RETURNING ${column}`,
        [schoolYearId, personId, categoryId]);
    if (!updated.rowCount) {
        throw new CategoryRefused(409,
            'Лицето не е на списокот за таа учебна година.', { notOnYear: true });
    }
    return { kind, personId, categoryId };
}

/**
 * The categories that apply to this pupil this year.
 *
 * A therapist's category applies when the pupil is on their caseload. A
 * teacher has no caseload, so theirs applies when the teacher holds the
 * pupil's CLASS — matched through `normalizeClassLabel`, the single copy of
 * "these two labels are the same room", because the enrolment stores the class
 * as text and `IV-а` and `iv / a` are one class to a person and two strings to
 * `=`.
 *
 * The caseload and the class list decide, never the timetable: in September
 * both exist and the week has not been built yet.
 */
export async function categoriesForPupil(
    schoolYearId: number, studentId: number, db: QueryExecutor = pool
): Promise<Category[]> {
    const fromCaseload = await db.query(
        `SELECT DISTINCT c.id, c.code, c.name, c.ord, c.active
           FROM therapist_students ts
           JOIN therapist_years ty
             ON ty.therapist_id = ts.therapist_id AND ty.school_year_id = ts.school_year_id
           JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ts.school_year_id = $1 AND ts.student_id = $2 AND ty.active AND c.active`,
        [schoolYearId, studentId]);

    const enrolment = await db.query(
        `SELECT grade FROM student_enrollments
          WHERE school_year_id = $1 AND student_id = $2 AND active`, [schoolYearId, studentId]);
    const pupilClass = enrolment.rowCount ? normalizeClassLabel(enrolment.rows[0].grade || '') : '';

    const fromClass = pupilClass ? await db.query(
        `SELECT c.id, c.code, c.name, c.ord, c.active, sc.label
           FROM teacher_classes tc
           JOIN teacher_years ty
             ON ty.teacher_id = tc.teacher_id AND ty.school_year_id = tc.school_year_id
           JOIN specialist_categories c ON c.id = ty.category_id
           JOIN school_classes sc ON sc.id = tc.class_id
          WHERE tc.school_year_id = $1 AND ty.active AND c.active`, [schoolYearId]) : null;

    const seen = new Map<number, Category>();
    fromCaseload.rows.forEach((r) => seen.set(r.id, row(r)));
    (fromClass ? fromClass.rows : [])
        .filter((r) => normalizeClassLabel(r.label || '') === pupilClass)
        .forEach((r) => seen.set(r.id, row(r)));
    return [...seen.values()].sort((a, b) => a.ord - b.ord || a.name.localeCompare(b.name, 'mk'));
}

/** The people the database already knows work with this pupil, with their profile. */
export async function teamForPupil(schoolYearId: number, studentId: number) {
    const therapists = await pool.query(
        `SELECT t.id, t.name, c.name AS category_name, c.code AS category_code,
                c.ord AS category_ord
           FROM therapist_students ts
           JOIN therapists t ON t.id = ts.therapist_id
           JOIN therapist_years ty
             ON ty.therapist_id = ts.therapist_id AND ty.school_year_id = ts.school_year_id
           LEFT JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ts.school_year_id = $1 AND ts.student_id = $2 AND ty.active
          ORDER BY c.ord NULLS LAST, t.name`, [schoolYearId, studentId]);

    const enrolment = await pool.query(
        `SELECT grade FROM student_enrollments
          WHERE school_year_id = $1 AND student_id = $2 AND active`, [schoolYearId, studentId]);
    const pupilClass = enrolment.rowCount ? normalizeClassLabel(enrolment.rows[0].grade || '') : '';
    const teachers = pupilClass ? await pool.query(
        `SELECT t.id, t.name, c.name AS category_name, c.code AS category_code,
                c.ord AS category_ord, sc.label
           FROM teacher_classes tc
           JOIN teachers t ON t.id = tc.teacher_id
           JOIN teacher_years ty
             ON ty.teacher_id = tc.teacher_id AND ty.school_year_id = tc.school_year_id
           LEFT JOIN specialist_categories c ON c.id = ty.category_id
           JOIN school_classes sc ON sc.id = tc.class_id
          WHERE tc.school_year_id = $1 AND ty.active
          ORDER BY c.ord NULLS LAST, t.name`, [schoolYearId]) : null;

    const people = [
        ...therapists.rows.map((r) => ({
            kind: 'therapist' as PersonKind,
            personId: r.id,
            name: r.name,
            profession: r.category_name || '',
            categoryCode: r.category_code,
            sortOrd: r.category_ord
        })),
        ...(teachers ? teachers.rows : [])
            .filter((r) => normalizeClassLabel(r.label || '') === pupilClass)
            .map((r) => ({
                kind: 'teacher' as PersonKind,
                personId: r.id,
                name: r.name,
                profession: r.category_name || '',
                categoryCode: r.category_code,
                sortOrd: r.category_ord
            }))
    ];

    // A malformed import can leave two class rows that normalise to the same
    // label. The person is still one member of the team, not two table rows.
    const unique = new Map(people.map((person) => [`${person.kind}:${person.personId}`, person]));
    return [...unique.values()]
        .sort((a, b) => (a.sortOrd ?? Number.MAX_SAFE_INTEGER) - (b.sortOrd ?? Number.MAX_SAFE_INTEGER)
            || a.name.localeCompare(b.name, 'mk'))
        .map(({ sortOrd: _sortOrd, ...person }) => person);
}

export type SheetSection = {
    sectionId: number;
    code: string;
    title: string;
    catalog: 'prescribed' | 'action';
    categoryId: number | null;
    categoryName: string | null;
    included: boolean;
    source: 'derived' | 'manual';
};

/**
 * What this sheet carries: every prescribed section, plus the action-plan
 * sections for the pupil's categories, with any manual deviation applied.
 */
export async function sheetSections(
    sheetId: number, db: QueryExecutor = pool
): Promise<SheetSection[]> {
    const sheet = await db.query(
        'SELECT student_id, school_year_id FROM evidence_sheets WHERE id = $1', [sheetId]);
    if (!sheet.rowCount) throw new CategoryRefused(404, 'Листот не постои.', { noSheet: true });
    const { student_id, school_year_id } = sheet.rows[0];
    const applies = new Set(
        (await categoriesForPupil(school_year_id, student_id, db)).map((c) => c.id));

    const rows = await db.query(
        `SELECT s.id, s.code, s.title, s.catalog, s.category_id,
                c.name AS category_name, o.included AS override
           FROM evidence_sections s
           LEFT JOIN specialist_categories c ON c.id = s.category_id
           LEFT JOIN evidence_sheet_sections o ON o.section_id = s.id AND o.sheet_id = $1
          WHERE s.active
          ORDER BY s.catalog DESC, s.ord, s.id`, [sheetId]);

    return rows.rows.map((r) => {
        const derived = r.catalog === 'prescribed' ? true : applies.has(r.category_id);
        const manual = r.override !== null && r.override !== undefined;
        return {
            sectionId: r.id, code: r.code, title: r.title, catalog: r.catalog,
            categoryId: r.category_id, categoryName: r.category_name,
            included: manual ? r.override : derived,
            source: manual ? 'manual' : 'derived'
        } as SheetSection;
    });
}

/**
 * Switch one action section on or off for one sheet.
 *
 * When the choice lands back on what the caseload already says, the deviation
 * row is REMOVED rather than stored as agreement — otherwise the sheet stops
 * following the caseload from then on, silently.
 */
export async function setSheetSection(
    sheetId: number, sectionId: number, included: boolean,
    decidedBy: { kind: PersonKind; personId: number } | null
) {
    const section = await pool.query(
        `SELECT s.catalog, s.category_id, e.student_id, e.school_year_id
           FROM evidence_sections s, evidence_sheets e
          WHERE s.id = $1 AND e.id = $2`, [sectionId, sheetId]);
    if (!section.rowCount) throw new CategoryRefused(404, 'Непозната секција или лист.');
    const found = section.rows[0];
    if (found.catalog !== 'action') {
        throw new CategoryRefused(409,
            'Пропишаните секции не се исклучуваат — тие се образецот.', { prescribed: true });
    }
    const applies = new Set(
        (await categoriesForPupil(found.school_year_id, found.student_id)).map((c) => c.id));
    const derived = applies.has(found.category_id);

    if (derived === included) {
        await pool.query(
            'DELETE FROM evidence_sheet_sections WHERE sheet_id = $1 AND section_id = $2',
            [sheetId, sectionId]);
        return { included, source: 'derived' as const };
    }
    // Either kind of person may decide, so the row records which one. Losing
    // who decided is better than losing the decision, hence ON DELETE SET NULL
    // on both columns.
    const byTherapist = decidedBy?.kind === 'therapist' ? decidedBy.personId : null;
    const byTeacher = decidedBy?.kind === 'teacher' ? decidedBy.personId : null;
    await pool.query(
        `INSERT INTO evidence_sheet_sections
                (sheet_id, section_id, included, decided_by, decided_by_teacher)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sheet_id, section_id)
           DO UPDATE SET included = EXCLUDED.included,
                         decided_by = EXCLUDED.decided_by,
                         decided_by_teacher = EXCLUDED.decided_by_teacher,
                         decided_at = now()`,
        [sheetId, sectionId, included, byTherapist, byTeacher]);
    return { included, source: 'manual' as const };
}

/**
 * May this person write the global action-plan catalogue for one category?
 *
 * Catalogue edits have no sheet behind them, so the current year supplies the
 * ownership fact. Passing a year is reserved for a score on an archived sheet.
 */
export async function assertMayEditCategory(
    who: { kind: PersonKind; personId: number },
    categoryId: number,
    schoolYearId?: number,
    sectionTitle?: string,
    db: QueryExecutor = pool
): Promise<void> {
    let yearId = schoolYearId;
    if (!yearId) {
        const year = await db.query('SELECT id FROM school_years WHERE is_current LIMIT 1');
        if (!year.rowCount) {
            throw new CategoryRefused(409,
                'Нема означена тековна учебна година, па не може да се утврди кој ја држи категоријата.',
                { noCurrentYear: true });
        }
        yearId = year.rows[0].id;
    }

    const category = await db.query(
        'SELECT name FROM specialist_categories WHERE id = $1', [categoryId]);
    if (!category.rowCount) {
        throw new CategoryRefused(404, 'Нема таква категорија.', { noCategory: true });
    }

    const table = who.kind === 'teacher' ? 'teacher_years' : 'therapist_years';
    const column = who.kind === 'teacher' ? 'teacher_id' : 'therapist_id';
    const holds = await db.query(
        `SELECT 1 FROM ${table}
          WHERE school_year_id = $1 AND ${column} = $2 AND category_id = $3 AND active`,
        [yearId, who.personId, categoryId]);
    if (holds.rowCount) return;

    const subject = sectionTitle
        ? `Секцијата „${sectionTitle}“ ѝ припаѓа на категоријата`
        : 'Новата секција ѝ припаѓа на категоријата';
    throw new CategoryRefused(403,
        `${subject} „${category.rows[0].name}“, а вие не ја држите таа категорија оваа учебна година.`,
        { notHolder: true, category: category.rows[0].name });
}

/**
 * May this person change what a section CONTAINS?
 *
 * The rule the owner asked for: everyone reads everything, but the section for
 * a profile is edited and scored by whoever holds that profile. Adding an item,
 * rewording one, changing the scale and writing a mark are the same permission,
 * because they are all "what this specialist says about this pupil".
 *
 * PRESCRIBED SECTIONS ARE NOT COVERED. They are the евидентен лист itself, the
 * form everybody fills in together, and restricting them was not asked for and
 * would break the screen that exists. Only action-plan sections have an owner.
 *
 * Either kind of person holds a profile, and either signs in (migration 025).
 * The check therefore asks the table that matches the signed-in kind, and the
 * refusal names the category rather than just saying no.
 */
export async function assertMayEdit(
    who: { kind: PersonKind; personId: number },
    target: { section?: number; item?: number; group?: number },
    schoolYearId?: number,
    db: QueryExecutor = pool
): Promise<void> {
    const sectionId = target.section ?? (await (async () => {
        if (target.item) {
            const r = await db.query(
                'SELECT section_id FROM evidence_items WHERE id = $1', [target.item]);
            return r.rowCount ? r.rows[0].section_id : null;
        }
        if (target.group) {
            const r = await db.query(
                'SELECT section_id FROM evidence_groups WHERE id = $1', [target.group]);
            return r.rowCount ? r.rows[0].section_id : null;
        }
        return null;
    })());
    // Nothing to guard: the caller's own 404 will say so more precisely.
    if (!sectionId) return;

    const found = await db.query(
        `SELECT s.catalog, s.category_id, s.title, c.name AS category_name
           FROM evidence_sections s
           LEFT JOIN specialist_categories c ON c.id = s.category_id
          WHERE s.id = $1`, [sectionId]);
    if (!found.rowCount) return;
    const section = found.rows[0];
    if (section.catalog !== 'action') return;

    await assertMayEditCategory(who, section.category_id, schoolYearId, section.title, db);
}
