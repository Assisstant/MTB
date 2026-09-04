/**
 * Евидентен лист — the shared half of the record: who is signed in, what the
 * catalogue currently says, and how one sheet is read back whole.
 *
 * Both the endpoints and the "print every sheet" read go through here, for the
 * reason `lib/records.ts` exists: a second caller assembling the same document
 * a slightly different way is the failure this project keeps paying for, and it
 * stays invisible until two printouts disagree.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from '../db.js';

const scrypt = promisify(scryptCb) as (
    password: string, salt: string, keylen: number
) => Promise<Buffer>;

/** Long enough that a working day never asks twice, short enough to end. */
export const SESSION_HOURS = 12;

/**
 * ...and short enough that a browser left open in a shared room ends by itself.
 *
 * The twelve hours above answer "how long may a working day be". They cannot
 * answer "is anybody still sitting there", and in a staff room those are
 * different questions -- the second one is the whole reason the PIN exists.
 * `last_seen` has been written on every authenticated call since 022 and never
 * once read; this reads it. Set MTB_SESSION_IDLE_MINUTES=0 to switch it off.
 */
export const SESSION_IDLE_MINUTES = Number(process.env.MTB_SESSION_IDLE_MINUTES ?? 30);

export type PersonKind = 'therapist' | 'teacher';

/**
 * Who is signed in.
 *
 * `therapistId` is kept and stays a number for a therapist, because rows that
 * reference `therapists(id)` still need it and every existing caller reads it.
 * It is null for a teacher — a caller that writes such a row has to say what it
 * does then, rather than silently attributing the work to nobody.
 */
export type Signed = {
    kind: PersonKind;
    personId: number;
    name: string;
    therapistId: number | null;
};

/**
 * The four columns this centre fills the record in.
 *
 * The printed form from the Правилник has three; the school assesses four
 * times a year. Rather than choose, the columns are rows a year owns — these
 * are only what a NEW year starts with, and renaming or removing one changes
 * nothing about the years already filled in.
 */
const DEFAULT_PERIODS = [
    { ord: 1, label: 'Почеток на учебната година', short_label: 'Почеток' },
    { ord: 2, label: 'Прво тримесечие', short_label: 'I трим.' },
    { ord: 3, label: 'Прво полугодие', short_label: 'I полуг.' },
    { ord: 4, label: 'Крај на учебната година', short_label: 'Крај' }
];

export class Refused extends Error {
    status: number;
    payload: Record<string, unknown>;
    constructor(status: number, message: string, payload: Record<string, unknown> = {}) {
        super(message);
        this.status = status;
        this.payload = payload;
    }
}

// ── identity ─────────────────────────────────────────────────────────────────

export async function hashPin(pin: string): Promise<{ salt: string; hash: string }> {
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(pin, salt, 32)).toString('hex');
    return { salt, hash };
}

export async function pinMatches(pin: string, salt: string, hash: string): Promise<boolean> {
    const attempt = await scrypt(pin, salt, 32);
    const stored = Buffer.from(hash, 'hex');
    // Lengths differ only if the stored row is corrupt, and timingSafeEqual
    // throws rather than answering false, which would be a 500 on a wrong PIN.
    return attempt.length === stored.length && timingSafeEqual(attempt, stored);
}

/**
 * Who is writing?
 *
 * Every write records a name, because the form itself asks for one per
 * section. An expired session is refused with `signedOut` so the app can offer
 * the login box instead of showing an error the therapist cannot act on.
 */
export async function whoIsSigned(token: unknown): Promise<Signed> {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!value) throw new Refused(401, 'not signed in', { signedOut: true });
    const { rows } = await pool.query(
        `UPDATE evidence_sessions s SET last_seen = now()
         WHERE s.token = $1 AND s.expires_at > now()
           AND ($2::int <= 0 OR s.last_seen > now() - make_interval(mins => $2::int))
         RETURNING s.therapist_id, s.teacher_id,
                   coalesce((SELECT name FROM therapists WHERE id = s.therapist_id),
                            (SELECT name FROM teachers   WHERE id = s.teacher_id)) AS name`,
        [value, SESSION_IDLE_MINUTES]
    );
    if (!rows.length) throw new Refused(401, 'the session has ended -- sign in again', { signedOut: true });
    const row = rows[0];
    const kind: PersonKind = row.therapist_id ? 'therapist' : 'teacher';
    return {
        kind,
        personId: kind === 'therapist' ? row.therapist_id : row.teacher_id,
        name: row.name,
        therapistId: row.therapist_id ?? null
    };
}

/** Old rows are noise, not history: a session is a key, not a record of work. */
export async function sweepSessions(): Promise<void> {
    await pool.query('DELETE FROM evidence_sessions WHERE expires_at < now()');
}

// ── the year and its columns ─────────────────────────────────────────────────

export type Year = { id: number; label: string; starts_on: string; is_current: boolean };

export async function resolveYear(label?: string | null): Promise<Year> {
    const { rows } = await pool.query(
        `SELECT id, label, starts_on, is_current FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null]
    );
    if (!rows.length) throw new Refused(404, `no such school year: ${label ?? '(current)'}`);
    return rows[0];
}

/**
 * A year's columns, created on first use.
 *
 * Doing this lazily rather than in the migration means a year created next
 * September gets them too, without anybody remembering a step.
 */
export async function ensurePeriods(yearId: number) {
    const existing = await pool.query(
        'SELECT id FROM evidence_periods WHERE school_year_id = $1 LIMIT 1', [yearId]
    );
    if (!existing.rows.length) {
        for (const p of DEFAULT_PERIODS) {
            await pool.query(
                `INSERT INTO evidence_periods (school_year_id, ord, label, short_label)
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [yearId, p.ord, p.label, p.short_label]
            );
        }
    }
    const { rows } = await pool.query(
        `SELECT id, ord, label, short_label, active FROM evidence_periods
         WHERE school_year_id = $1 ORDER BY ord`,
        [yearId]
    );
    return rows;
}

// ── the catalogue ────────────────────────────────────────────────────────────

export async function readCatalog(yearId: number) {
    const [periods, sections, groups, items, roles] = await Promise.all([
        ensurePeriods(yearId),
        pool.query(
            // `catalog` and `cabinet_id` ride along so the screen can tell the
            // prescribed form from an action-plan section without a second read.
            // Sections written before migration 023 answer 'prescribed', which
            // is what they are.
            `SELECT id, code, title, ord, scale, summary, only_secondary, active,
                    catalog, category_id
             FROM evidence_sections ORDER BY catalog DESC, ord, id`
        ),
        pool.query('SELECT id, section_id, label, ord FROM evidence_groups ORDER BY ord, id'),
        pool.query(
            `SELECT id, section_id, group_id, label, ord, active
             FROM evidence_items ORDER BY ord, id`
        ),
        pool.query(
            'SELECT id, section_id, code, label, ord FROM evidence_examiner_roles ORDER BY ord, id'
        )
    ]);
    return {
        periods,
        sections: sections.rows.map((s) => ({
            ...s,
            groups: groups.rows.filter((g) => g.section_id === s.id),
            items: items.rows.filter((i) => i.section_id === s.id),
            examiners: roles.rows.filter((r) => r.section_id === s.id)
        }))
    };
}

// ── one sheet ────────────────────────────────────────────────────────────────

/**
 * The class comes from the ENROLMENT, never from the sheet.
 *
 * The school writes a class as „IV-а": a grade and a section in one label,
 * which is one fact stored in one place. The printed form asks for the two
 * halves separately, so they are split for the print and never stored apart —
 * splitting a copy cannot drift, a second column would.
 */
export function splitClass(grade: string | null | undefined) {
    const label = String(grade ?? '').trim();
    const m = label.match(/^(.*?)[\s\-‐‑–—/]+([^\s\-‐‑–—/]+)$/);
    return m ? { grade: m[1].trim(), section: m[2].trim() } : { grade: label, section: '' };
}

const SHEET_COLUMNS = `sh.id, sh.student_id, sh.school_year_id, sh.institution, sh.place,
    sh.municipality, sh.school_type, sh.class_section, sh.vocation, sh.occupation,
    sh.dob, sh.pob, sh.diagnosis, sh.place_date,
    sh.created_at, sh.created_by, sh.updated_at, sh.updated_by`;

export async function readSheets(sheetIds: number[]) {
    if (!sheetIds.length) return [];
    const [sheets, scores, panels, examiners, contacts] = await Promise.all([
        pool.query(
            `SELECT ${SHEET_COLUMNS}, s.public_id, s.name, e.grade AS enrolled_grade, y.label AS year
             FROM evidence_sheets sh
             JOIN students s ON s.id = sh.student_id
             JOIN school_years y ON y.id = sh.school_year_id
             LEFT JOIN student_enrollments e
                    ON e.student_id = sh.student_id AND e.school_year_id = sh.school_year_id
             WHERE sh.id = ANY($1::int[])
             ORDER BY s.name`,
            [sheetIds]
        ),
        pool.query(
            `SELECT sheet_id, item_id, period_id, value, updated_at, updated_by
             FROM evidence_scores WHERE sheet_id = ANY($1::int[])`, [sheetIds]),
        pool.query(
            `SELECT sheet_id, panel, data, updated_at, updated_by
             FROM evidence_panels WHERE sheet_id = ANY($1::int[])`, [sheetIds]),
        pool.query(
            `SELECT sheet_id, role_id, name, updated_at, updated_by
             FROM evidence_examiners WHERE sheet_id = ANY($1::int[])`, [sheetIds]),
        pool.query(
            `SELECT sheet_id, ord, name, profession, phone, email
             FROM evidence_contacts WHERE sheet_id = ANY($1::int[]) ORDER BY ord`, [sheetIds])
    ]);

    return sheets.rows.map((row) => {
        const split = splitClass(row.enrolled_grade);
        return {
            ...row,
            grade: split.grade,
            // The enrolment's own section wins; sh.class_section only answers
            // for a label that carries no section at all (a bare „VIII").
            class_section: split.section || row.class_section,
            scores: scores.rows.filter((x) => x.sheet_id === row.id),
            panels: Object.fromEntries(
                panels.rows.filter((x) => x.sheet_id === row.id)
                    .map((x) => [x.panel, { ...(x.data as object), _updatedAt: x.updated_at, _updatedBy: x.updated_by }])
            ),
            examiners: examiners.rows.filter((x) => x.sheet_id === row.id),
            contacts: contacts.rows.filter((x) => x.sheet_id === row.id)
        };
    });
}

export async function readSheet(sheetId: number) {
    const [sheet] = await readSheets([sheetId]);
    if (!sheet) throw new Refused(404, `no evidence sheet with id ${sheetId}`);
    return sheet;
}

/**
 * Creating a sheet copies the dossier's date of birth and findings ONCE.
 *
 * That is a convenience, not a second owner: the dossier stays the live record
 * of the child, and what lands here is what the therapist then signs on this
 * form for this year. Nothing reads it back afterwards.
 */
export async function createSheet(
    studentId: number, year: Year, by: string
): Promise<number> {
    const { rows: existing } = await pool.query(
        'SELECT id FROM evidence_sheets WHERE student_id = $1 AND school_year_id = $2',
        [studentId, year.id]
    );
    if (existing.length) {
        throw new Refused(409, 'this pupil already has an evidence sheet for that year', {
            sheetId: existing[0].id
        });
    }
    const { rows: dossier } = await pool.query(
        'SELECT birth_date, findings, opinion FROM student_records WHERE student_id = $1', [studentId]
    );
    const d = dossier[0] || {};
    const diagnosis = [d.findings, d.opinion].filter(Boolean).join('\n').trim();
    const { rows } = await pool.query(
        `INSERT INTO evidence_sheets
            (student_id, school_year_id, institution, place, municipality, dob, diagnosis,
             created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
        [studentId, year.id, 'ОУРЦ „Кочо Рацин" - Битола', 'Битола', 'Битола',
         d.birth_date || '', diagnosis, by]
    );
    return rows[0].id;
}

/** Every write says who and when, so the record can answer "who wrote this?". */
export async function touchSheet(sheetId: number, by: string) {
    await pool.query(
        'UPDATE evidence_sheets SET updated_at = now(), updated_by = $2 WHERE id = $1',
        [sheetId, by]
    );
}
