import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
    assertMayEdit, assertMayEditCategory, CategoryRefused, sheetSections
} from '../lib/categories.js';
import { pool } from '../db.js';
import {
    createSheet, ensurePeriods, readCatalog, readSheet, readSheets,
    Refused, resolveYear, touchSheet, whoIsSigned, type Signed
} from '../lib/evidence.js';
import { orderPupils } from '../lib/teaching.js';
import {
    assertOwner, assertOwnSheet, assertOwnStudent, ownStudentIds, scopeOf
} from '../lib/colleague.js';

/**
 * Евидентен лист, one cell at a time.
 *
 * The record is filled by a whole team -- дефектолог, логопед, психолог,
 * тифлолог, сурдолог, биофидбек терапевт -- and the standalone app saved it as
 * one document, so two specialists filling their own sections of the same child
 * on the same afternoon each replaced the other's work with their own view of
 * the whole sheet. A score is (sheet, item, period) here, and the psychologist
 * and the logopedist no longer share a row to destroy.
 *
 * WHAT IS DELIBERATELY ABSENT: any way to delete a PERSON.
 *
 * `DELETE /api/evidence/sheet/:id` removes this year's SHEET -- a document the
 * team wrote and can unwrite. Whether the child is enrolled is owned by
 * S-Dnevnik's archive and their place on a year's list by Podatoci (rule 5), so
 * neither is reachable from here, exactly as `roster-write.ts` has no delete.
 * `POST /api/students` is how a pupil is added, because that endpoint already
 * owns creating one and a second creator would compute a different id.
 *
 * THE CATALOGUE CAN BE EDITED, AND DELETING FROM IT IS TWO DIFFERENT REQUESTS,
 * the same way „бришење" already is for the roster. An item nobody has scored
 * is a line typed by mistake and is deleted outright. An item somebody HAS
 * scored is history: deactivating it takes it off every screen and off the next
 * printout while the years already filled in still read correctly. Deleting it
 * would silently shorten last year's record, and the average printed under it
 * would change with no sign that anything had.
 */

const ScoreBody = z.object({
    sheetId: z.number().int().positive(),
    itemId: z.number().int().positive(),
    periodId: z.number().int().positive(),
    /** '' clears the cell. The scale is checked against the item's section. */
    value: z.string().max(8),
    /** What the caller believes is there now. '' means "I believe it is empty". */
    expected: z.string().max(8).optional()
});

const SheetPatch = z.object({
    institution: z.string().max(200).optional(),
    place: z.string().max(120).optional(),
    municipality: z.string().max(120).optional(),
    schoolType: z.enum(['primary', 'secondary']).optional(),
    classSection: z.string().max(40).optional(),
    vocation: z.string().max(160).optional(),
    occupation: z.string().max(160).optional(),
    dob: z.string().max(60).optional(),
    pob: z.string().max(120).optional(),
    diagnosis: z.string().max(8000).optional(),
    placeDate: z.string().max(120).optional()
});

const PanelBody = z.object({
    sheetId: z.number().int().positive(),
    panel: z.enum(['vision', 'hearing', 'speech', 'biofeedback']),
    data: z.record(z.unknown())
});

const ExaminerBody = z.object({
    sheetId: z.number().int().positive(),
    roleId: z.number().int().positive(),
    name: z.string().max(200)
});

const ContactsBody = z.object({
    sheetId: z.number().int().positive(),
    contacts: z.array(z.object({
        name: z.string().max(200).optional(),
        profession: z.string().max(200).optional(),
        phone: z.string().max(80).optional(),
        email: z.string().max(160).optional()
    })).max(40)
});

const ItemBody = z.object({
    sectionId: z.number().int().positive(),
    groupId: z.number().int().positive().nullable().optional(),
    label: z.string().min(1).max(400)
});

const ItemPatch = z.object({
    label: z.string().min(1).max(400).optional(),
    ord: z.number().int().min(0).max(999).optional(),
    active: z.boolean().optional(),
    /** The label the caller last saw, so a corrected line is not silently overwritten. */
    expected: z.string().max(400).optional()
});

const SectionBody = z.object({
    title: z.string().min(1).max(400),
    scale: z.enum(['level', 'mark']).optional(),
    summary: z.boolean().optional(),
    onlySecondary: z.boolean().optional(),
    catalog: z.enum(['prescribed', 'action']).optional(),
    categoryId: z.number().int().positive().nullable().optional()
});

const SectionPatch = z.object({
    title: z.string().min(1).max(400).optional(),
    ord: z.number().int().min(1).max(999).optional(),
    active: z.boolean().optional(),
    summary: z.boolean().optional(),
    onlySecondary: z.boolean().optional(),
    scale: z.enum(['level', 'mark']).optional(),
    /** The title the caller last saw, matching the item/category rename guard. */
    expected: z.string().max(400).optional()
});

const GroupBody = z.object({
    sectionId: z.number().int().positive(),
    label: z.string().min(1).max(400)
});

const PeriodBody = z.object({
    year: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(200),
    shortLabel: z.string().min(1).max(60)
});

const PeriodPatch = z.object({
    label: z.string().min(1).max(200).optional(),
    shortLabel: z.string().min(1).max(60).optional(),
    ord: z.number().int().min(1).max(99).optional(),
    active: z.boolean().optional()
});

function refuse(reply: FastifyReply, err: unknown) {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message, ...err.payload });
    // Ownership of an action-plan section, from lib/categories.ts. One place,
    // so no endpoint invents its own wording for "that is not your section".
    if (err instanceof CategoryRefused) {
        return reply.code(err.status).send({ error: err.message, ...err.detail });
    }
    throw err;
}

const signed = (req: FastifyRequest) => whoIsSigned(req.headers['x-mtb-evidence-token']);

/**
 * Both scales are closed sets, so a typo cannot become a fourth grade.
 *
 * `/` MEANS "does not apply to this child" and is legal on both scales.
 *
 * Without it, a goal that was never this child's had two ways to be recorded and
 * both lied: leave the cell empty and the sheet reads unfinished, or write 1 and
 * the child reads as failing something nobody ever asked of them -- and on a
 * `level` section that 1 goes into ОПШТА ПРОЦЕНКА and out into a signed report.
 *
 * So three states, three meanings, no overlap: empty is NOT YET ASSESSED, `/` is
 * DECIDED NOT TO APPLY, and a grade is assessed. It counts as answered, because
 * a decision with an author and a date is not an omission -- `evidence_scores`
 * stamps both. It stays out of the average, because that is arithmetic over
 * achievement and "not applicable" is not a low one; `sectionSummary` already
 * skips it, since Number('/') is NaN.
 *
 * `mark` has allowed `/` since the beginning and the interface never offered it.
 */
function checkValue(scale: string, value: string) {
    if (value === '') return;
    const allowed = scale === 'mark' ? ['√', 'X', '/'] : ['1', '2', '3', '/'];
    if (!allowed.includes(value)) {
        throw new Refused(400, `"${value}" is not one of ${allowed.join(' ')} for this section`);
    }
}

/**
 * How many cells would a delete take with it?
 *
 * Asked before every catalogue delete, because the answer decides which of the
 * two „бришења" this is: a line typed by mistake, or a year of somebody's work.
 */
async function scoreCount(client: PoolClient, where: string, args: unknown[]): Promise<number> {
    const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM evidence_scores s ${where}`, args);
    return rows[0].n;
}

export async function evidenceRoutes(server: FastifyInstance) {

    // ── reading ──────────────────────────────────────────────────────────────

    /** The catalogue and the year's columns: everything the screen draws from. */
    server.get('/api/evidence/catalog', async (req, reply) => {
        try {
            await signed(req);
            const year = await resolveYear((req.query as any)?.year);
            const catalog = await readCatalog(year.id);
            return { year: year.label, isCurrentYear: year.is_current, ...catalog };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    /**
     * Everyone on the year's list, with their sheet if they have one.
     *
     * The pupils come from the ENROLMENT rather than from evidence_sheets, so a
     * child nobody has started a record for is visible as work to do rather
     * than absent. `filled` counts scored cells per period, which is the only
     * honest answer to "is this one done?" at a glance.
     */
    server.get('/api/evidence/sheets', async (req, reply) => {
        try {
            await signed(req);
            const year = await resolveYear((req.query as any)?.year);
            await ensurePeriods(year.id);
            // null = no filter (the owner, or enforcement off); an array = this
            // colleague's caseload for the year, so „Сите ученици" means their
            // own and the list cannot be used to browse the whole school.
            const mine = await ownStudentIds(await scopeOf(req), year.id);
            const { rows } = await pool.query(
                `SELECT s.public_id, s.name, e.grade, e.kind, s.active,
                        sh.id AS sheet_id, sh.updated_at, sh.updated_by, sh.school_type,
                        coalesce((
                            SELECT json_object_agg(p.ord, c.n)
                            FROM evidence_periods p
                            JOIN LATERAL (
                                SELECT count(*)::int AS n FROM evidence_scores sc
                                WHERE sc.sheet_id = sh.id AND sc.period_id = p.id AND sc.value <> ''
                            ) c ON true
                            WHERE p.school_year_id = $1
                        ), '{}'::json) AS filled
                 FROM student_enrollments e
                 JOIN students s ON s.id = e.student_id
                 LEFT JOIN evidence_sheets sh
                        ON sh.student_id = s.id AND sh.school_year_id = $1
                 WHERE e.school_year_id = $1 AND e.active AND (s.active OR NOT $2::boolean)
                   AND ($3::int[] IS NULL OR s.id = ANY($3::int[]))
                 ORDER BY e.grade NULLS LAST, s.name`,
                [year.id, year.is_current, mine]
            );
            return { year: year.label, isCurrentYear: year.is_current, pupils: orderPupils(rows) };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.get('/api/evidence/sheet/:id', async (req, reply) => {
        try {
            await signed(req);
            const id = Number((req.params as any).id);
            await assertOwnSheet(await scopeOf(req), id);
            return await readSheet(id);
        } catch (err) {
            return refuse(reply, err);
        }
    });

    /**
     * Every sheet of a year, whole.
     *
     * „Сите ученици" prints one document holding the lot, and the browser builds
     * it, so it needs the lot. One read rather than eighty: at this size the
     * request that matters is the one that is not made sixty times.
     */
    server.get('/api/evidence/sheets/full', async (req, reply) => {
        try {
            await signed(req);
            const year = await resolveYear((req.query as any)?.year);
            const mine = await ownStudentIds(await scopeOf(req), year.id);
            const { rows } = await pool.query(
                `SELECT sh.id FROM evidence_sheets sh
                 JOIN students s ON s.id = sh.student_id
                 WHERE sh.school_year_id = $1
                   AND ($2::int[] IS NULL OR sh.student_id = ANY($2::int[]))
                 ORDER BY s.name`,
                [year.id, mine]
            );
            return {
                year: year.label,
                sheets: await readSheets(rows.map((r) => r.id))
            };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    // ── one sheet ────────────────────────────────────────────────────────────

    server.post('/api/evidence/sheet', async (req, reply) => {
        try {
            const me = await signed(req);
            const body = z.object({
                publicId: z.string().min(1).max(80),
                year: z.string().min(1).max(64).optional()
            }).parse(req.body);
            const year = await resolveYear(body.year);
            const { rows } = await pool.query(
                `SELECT s.id, s.name, s.active, e.active AS enrolled
                 FROM students s
                 LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = $2
                 WHERE s.public_id = $1`,
                [body.publicId, year.id]
            );
            if (!rows.length) return reply.code(404).send({ error: `no student with id ${body.publicId}` });
            if (!rows[0].enrolled) {
                return reply.code(409).send({
                    error: `"${rows[0].name}" is not on the ${year.label} list -- add them in Podatoci first`,
                    inactiveThisYear: true
                });
            }
            await assertOwnStudent(await scopeOf(req), rows[0].id, year.id);
            const sheetId = await createSheet(rows[0].id, year, me.name);
            return { ok: true, sheetId, sheet: await readSheet(sheetId) };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.patch('/api/evidence/sheet/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const body = SheetPatch.parse(req.body);
            const id = Number((req.params as any).id);
            await assertOwnSheet(await scopeOf(req), id);
            const columns: Record<string, unknown> = {
                institution: body.institution, place: body.place, municipality: body.municipality,
                school_type: body.schoolType, class_section: body.classSection,
                vocation: body.vocation, occupation: body.occupation,
                dob: body.dob, pob: body.pob, diagnosis: body.diagnosis, place_date: body.placeDate
            };
            const sets: string[] = [];
            const args: unknown[] = [id, me.name];
            for (const [column, value] of Object.entries(columns)) {
                if (value === undefined) continue;
                args.push(value);
                sets.push(`${column} = $${args.length}`);
            }
            if (!sets.length) return reply.code(400).send({ error: 'nothing to change' });
            const { rowCount } = await pool.query(
                `UPDATE evidence_sheets SET ${sets.join(', ')}, updated_at = now(), updated_by = $2
                 WHERE id = $1`,
                args
            );
            if (!rowCount) return reply.code(404).send({ error: `no evidence sheet with id ${id}` });
            return { ok: true, sheet: await readSheet(id) };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    /**
     * Delete this year's sheet -- the document, and nothing else.
     *
     * `expected` is the pupil's name as the caller last saw it, the same
     * row-level check the rest of this project uses. It earns its place on a
     * screen whose list can be a term old: deleting by id alone is how the
     * wrong child's year of assessments disappears behind an HTTP 200.
     */
    server.delete('/api/evidence/sheet/:id', async (req, reply) => {
        try {
            await signed(req);
            const scope = await scopeOf(req);
            const id = Number((req.params as any).id);
            const expected = String((req.query as any)?.expected ?? '').trim();
            if (!expected) {
                return reply.code(400).send({ error: 'name the pupil whose sheet this is (expected=)' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Score writers take the shared form of this same lock before
                // touching any row. It keeps the confirmation name, reported
                // score count and delete one indivisible decision without
                // making different score cells block one another.
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
                    [`evidence-sheet:${id}`]);
                const { rows } = await client.query(
                    `SELECT sh.id, sh.student_id, sh.school_year_id, s.name,
                            (SELECT count(*)::int FROM evidence_scores sc
                              WHERE sc.sheet_id = sh.id AND sc.value <> '') AS scores
                       FROM evidence_sheets sh JOIN students s ON s.id = sh.student_id
                      WHERE sh.id = $1
                      FOR UPDATE OF sh, s`,
                    [id]
                );
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no evidence sheet with id ${id}` });
                }
                await assertOwnStudent(
                    scope, rows[0].student_id, rows[0].school_year_id, client);
                if (rows[0].name !== expected) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `that sheet belongs to somebody else now`,
                        actual: rows[0].name, expected
                    });
                }
                await client.query('DELETE FROM evidence_sheets WHERE id = $1', [id]);
                await client.query('COMMIT');
                return { ok: true, deleted: id, scoresRemoved: rows[0].scores };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    // ── one cell ─────────────────────────────────────────────────────────────

    server.put('/api/evidence/score', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = ScoreBody.parse(req.body);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Shared rather than a row-level sheet lock: concurrent scores
                // may proceed, while DELETE /sheet takes the exclusive form.
                // It comes first in both paths, keeping the lock order stable.
                await client.query(
                    'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))',
                    [`evidence-sheet:${body.sheetId}`]);
                const { rows: item } = await client.query(
                    `SELECT i.id, i.active, i.section_id, sec.active AS section_active,
                            sec.catalog, sec.scale, sec.title
                      FROM evidence_items i JOIN evidence_sections sec ON sec.id = i.section_id
                      WHERE i.id = $1
                      FOR SHARE OF i, sec`,
                    [body.itemId]
                );
                // Writing a mark is the same permission as changing the line it
                // sits on, and it is judged against the SHEET's year rather than
                // the current one — an archived sheet is scored by whoever held
                // the profile THEN.
                const { rows: sheetYear } = await client.query(
                    'SELECT student_id, school_year_id FROM evidence_sheets WHERE id = $1', [body.sheetId]);
                if (sheetYear.length) {
                    try {
                        await assertOwnStudent(
                            scope, sheetYear[0].student_id, sheetYear[0].school_year_id, client);
                        // Colleagues fill the prescribed form for pupils they
                        // own; only STRUCTURAL edits to that catalogue are
                        // admin-only. Action sections retain their category
                        // holder check. The admin can repair either kind.
                        if (scope.open || !scope.admin) {
                            await assertMayEdit(me, { item: body.itemId },
                                sheetYear[0].school_year_id, client);
                        }
                    } catch (err) { await client.query('ROLLBACK'); throw err; }
                }
                if (!item.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no catalogue item with id ${body.itemId}` });
                }
                if (!item[0].active || !item[0].section_active) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'that line is hidden from the active catalogue', inactiveItem: true
                    });
                }
                if (item[0].catalog === 'action') {
                    const section = (await sheetSections(body.sheetId, client))
                        .find((entry) => entry.sectionId === item[0].section_id);
                    if (!section?.included) {
                        await client.query('ROLLBACK');
                        return reply.code(409).send({
                            error: 'that action-plan section is not included for this pupil',
                            notIncluded: true
                        });
                    }
                }
                const { rows: period } = await client.query(
                    `SELECT p.id, p.active, p.school_year_id, sh.school_year_id AS sheet_year
                      FROM evidence_periods p, evidence_sheets sh
                      WHERE p.id = $1 AND sh.id = $2
                      FOR SHARE OF p`,
                    [body.periodId, body.sheetId]
                );
                if (!period.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: 'no such sheet or period' });
                }
                // A column belongs to a year. Writing this year's mark into last
                // year's column would be accepted by the primary key and would
                // change an archived printout with nothing to show for it.
                if (period[0].school_year_id !== period[0].sheet_year) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({ error: 'that column belongs to a different school year' });
                }
                if (!period[0].active) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'that assessment period is hidden', inactivePeriod: true
                    });
                }
                checkValue(item[0].scale, body.value);

                // SELECT ... FOR UPDATE cannot lock a row that does not exist.
                // A key-specific advisory lock closes that empty-cell gap while
                // allowing specialists to keep writing different cells at once.
                await client.query(
                    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
                    [`evidence-score:${body.sheetId}:${body.itemId}:${body.periodId}`]
                );
                const { rows: current } = await client.query(
                    `SELECT value, updated_by FROM evidence_scores
                      WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3 FOR UPDATE`,
                    [body.sheetId, body.itemId, body.periodId]
                );
                const actual = current[0]?.value ?? '';
                if (body.expected !== undefined && body.expected !== actual) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'somebody changed that cell while you were looking at it',
                        actual, actualBy: current[0]?.updated_by ?? '', expected: body.expected
                    });
                }

                if (body.value === '') {
                    await client.query(
                        'DELETE FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3',
                        [body.sheetId, body.itemId, body.periodId]
                    );
                } else {
                    await client.query(
                        `INSERT INTO evidence_scores (sheet_id, item_id, period_id, value, updated_by)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (sheet_id, item_id, period_id) DO UPDATE
                            SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
                        [body.sheetId, body.itemId, body.periodId, body.value, me.name]
                    );
                }
                await client.query(
                    'UPDATE evidence_sheets SET updated_at = now(), updated_by = $2 WHERE id = $1',
                    [body.sheetId, me.name]
                );
                await client.query('COMMIT');
                return { ok: true, value: body.value, by: me.name };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    /** One free-text panel, saved as the form it is. */
    server.put('/api/evidence/panel', async (req, reply) => {
        try {
            const me = await signed(req);
            const body = PanelBody.parse(req.body);
            await assertOwnSheet(await scopeOf(req), body.sheetId);
            const { rowCount } = await pool.query(
                `INSERT INTO evidence_panels (sheet_id, panel, data, updated_by)
                 SELECT $1, $2, $3::jsonb, $4 WHERE EXISTS (SELECT 1 FROM evidence_sheets WHERE id = $1)
                 ON CONFLICT (sheet_id, panel) DO UPDATE
                    SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
                [body.sheetId, body.panel, JSON.stringify(body.data), me.name]
            );
            if (!rowCount) return reply.code(404).send({ error: `no evidence sheet with id ${body.sheetId}` });
            await touchSheet(body.sheetId, me.name);
            return { ok: true, panel: body.panel, by: me.name };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.put('/api/evidence/examiner', async (req, reply) => {
        try {
            const me = await signed(req);
            const body = ExaminerBody.parse(req.body);
            await assertOwnSheet(await scopeOf(req), body.sheetId);
            const { rowCount } = await pool.query(
                `INSERT INTO evidence_examiners (sheet_id, role_id, name, updated_by)
                 SELECT $1, $2, $3, $4
                 WHERE EXISTS (SELECT 1 FROM evidence_sheets WHERE id = $1)
                   AND EXISTS (SELECT 1 FROM evidence_examiner_roles WHERE id = $2)
                 ON CONFLICT (sheet_id, role_id) DO UPDATE
                    SET name = EXCLUDED.name, updated_at = now(), updated_by = EXCLUDED.updated_by`,
                [body.sheetId, body.roleId, body.name, me.name]
            );
            if (!rowCount) return reply.code(404).send({ error: 'no such sheet or examiner line' });
            await touchSheet(body.sheetId, me.name);
            return { ok: true };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    /**
     * The referral contacts, replaced as a set.
     *
     * Eight rows on one screen, edited by one person -- the opposite of a
     * contended cell, and `expected` on a table nobody else is typing into
     * would be ceremony. Cleared rows are removed rather than blanked so the
     * printed table has no gaps in it.
     */
    server.put('/api/evidence/contacts', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = ContactsBody.parse(req.body);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query(
                    `SELECT id, student_id, school_year_id
                     FROM evidence_sheets WHERE id = $1 FOR UPDATE`, [body.sheetId]
                );
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no evidence sheet with id ${body.sheetId}` });
                }
                await assertOwnStudent(
                    scope, rows[0].student_id, rows[0].school_year_id, client);
                await client.query('DELETE FROM evidence_contacts WHERE sheet_id = $1', [body.sheetId]);
                let ord = 0;
                for (const c of body.contacts) {
                    const filled = [c.name, c.profession, c.phone, c.email].some((v) => (v ?? '').trim());
                    if (!filled) continue;
                    await client.query(
                        `INSERT INTO evidence_contacts (sheet_id, ord, name, profession, phone, email)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [body.sheetId, ord++, c.name ?? '', c.profession ?? '', c.phone ?? '', c.email ?? '']
                    );
                }
                await client.query(
                    'UPDATE evidence_sheets SET updated_at = now(), updated_by = $2 WHERE id = $1',
                    [body.sheetId, me.name]
                );
                await client.query('COMMIT');
                return { ok: true, kept: ord };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    // ── the catalogue: adding and removing the lines themselves ──────────────

    server.post('/api/evidence/item', async (req, reply) => {
        try {
            const me: Signed = await signed(req);
            const scope = await scopeOf(req);
            const body = ItemBody.parse(req.body);
            await assertMayEdit(me, { section: body.sectionId }, undefined, pool, scope);
            const { rows: section } = await pool.query(
                'SELECT id FROM evidence_sections WHERE id = $1', [body.sectionId]
            );
            if (!section.length) return reply.code(404).send({ error: `no section with id ${body.sectionId}` });
            if (body.groupId != null) {
                const { rows: group } = await pool.query(
                    'SELECT id FROM evidence_groups WHERE id = $1 AND section_id = $2',
                    [body.groupId, body.sectionId]
                );
                if (!group.length) return reply.code(404).send({ error: 'that group is not in that section' });
            }
            const { rows } = await pool.query(
                `INSERT INTO evidence_items (section_id, group_id, label, ord)
                 SELECT $1, $2, $3, coalesce(max(ord) + 1, 0) FROM evidence_items WHERE section_id = $1
                 RETURNING id, ord`,
                [body.sectionId, body.groupId ?? null, body.label.trim()]
            );
            server.log.info({ by: me.name, item: rows[0].id }, 'evidence: catalogue item added');
            return { ok: true, item: { id: rows[0].id, ord: rows[0].ord, label: body.label.trim() } };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.patch('/api/evidence/item/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = ItemPatch.parse(req.body);
            const id = Number((req.params as any).id);
            await assertMayEdit(me, { item: id }, undefined, pool, scope);
            const { rows: updated } = await pool.query(
                `UPDATE evidence_items
                    SET label = coalesce($2, label), ord = coalesce($3, ord),
                        active = coalesce($4, active)
                  WHERE id = $1 AND ($5::text IS NULL OR label = $5)
              RETURNING id, label, ord, active`,
                [id, body.label?.trim() ?? null, body.ord ?? null, body.active ?? null,
                 body.expected ?? null]
            );
            if (!updated.length) {
                const { rows } = await pool.query(
                    'SELECT label FROM evidence_items WHERE id = $1', [id]);
                if (!rows.length) {
                    return reply.code(404).send({ error: `no catalogue item with id ${id}` });
                }
                return reply.code(409).send({
                    error: 'somebody reworded that line while you were editing it',
                    actual: rows[0].label, expected: body.expected
                });
            }
            return { ok: true, item: updated[0] };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.delete('/api/evidence/item/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const id = Number((req.params as any).id);
            await assertMayEdit(me, { item: id }, undefined, pool, scope);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // The score writer holds this row FOR SHARE. Taking the
                // conflicting lock before counting means a just-written mark
                // is observed rather than cascade-deleted.
                const { rows } = await client.query(
                    'SELECT id, label FROM evidence_items WHERE id = $1 FOR UPDATE', [id]);
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no catalogue item with id ${id}` });
                }
                const scored = await scoreCount(
                    client, "WHERE s.item_id = $1 AND s.value <> ''", [id]);
                if (scored) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${rows[0].label}" already carries ${scored} marks -- hide it instead of deleting it`,
                        scores: scored, deactivate: true
                    });
                }
                await client.query('DELETE FROM evidence_items WHERE id = $1', [id]);
                await client.query('COMMIT');
                return { ok: true, deleted: id };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.post('/api/evidence/section', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = SectionBody.parse(req.body);
            const catalog = body.catalog ?? 'prescribed';
            const categoryId = body.categoryId ?? null;
            if (catalog === 'action' && !categoryId) {
                throw new Refused(400, 'an action-plan section must name its category', {
                    needsCategory: true
                });
            }
            if (catalog === 'prescribed' && categoryId) {
                throw new Refused(400, 'a prescribed section cannot carry a category', {
                    prescribed: true
                });
            }

            if (catalog === 'prescribed') {
                assertOwner(scope, 'пропишаниот каталог');
            }

            let categoryCode = '';
            if (categoryId) {
                if (scope.open || !scope.admin) {
                    await assertMayEditCategory(me, categoryId);
                }
                const category = await pool.query(
                    'SELECT code FROM specialist_categories WHERE id = $1 AND active', [categoryId]);
                if (!category.rowCount) {
                    throw new Refused(409, 'that category is not active', { inactiveCategory: true });
                }
                categoryCode = category.rows[0].code;
            }
            const code = categoryCode
                ? categoryCode + '_action_' + randomBytes(6).toString('hex')
                : 'section_' + randomBytes(6).toString('hex');
            const { rows } = await pool.query(
                `INSERT INTO evidence_sections
                        (code, title, ord, scale, summary, only_secondary, catalog, category_id)
                 SELECT $1, $2, coalesce(max(ord), 0) + 1, $3, $4, $5, $6, $7
                   FROM evidence_sections WHERE catalog = $6
                 RETURNING id, code, title, ord, scale, summary, only_secondary,
                           active, catalog, category_id`,
                [code, body.title.trim(), body.scale ?? 'level', body.summary ?? true,
                 body.onlySecondary ?? false, catalog, categoryId]
            );
            return { ok: true, section: rows[0] };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.patch('/api/evidence/section/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = SectionPatch.parse(req.body);
            const id = Number((req.params as any).id);
            await assertMayEdit(me, { section: id }, undefined, pool, scope);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // A score takes a shared lock on this same row. Whichever write
                // starts first therefore finishes first: a scale can never be
                // changed in the gap between validating and inserting a mark.
                const { rows: before } = await client.query(
                    'SELECT title, scale FROM evidence_sections WHERE id = $1 FOR UPDATE', [id]);
                if (!before.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no section with id ${id}` });
                }
                if (body.expected !== undefined && body.expected !== before[0].title) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: 'somebody renamed that section while you were editing it',
                        actual: before[0].title, expected: body.expected
                    });
                }
                if (body.scale && body.scale !== before[0].scale) {
                    const { rows: counts } = await client.query(
                        `SELECT count(*)::int AS n FROM evidence_scores s
                          JOIN evidence_items i ON i.id = s.item_id
                         WHERE i.section_id = $1 AND s.value <> ''`, [id]);
                    const scored = counts[0].n;
                    if (scored) {
                        await client.query('ROLLBACK');
                        return reply.code(409).send({
                            error: `that section already carries ${scored} marks -- its scale cannot change`,
                            scores: scored, scaleLocked: true, actual: before[0].scale
                        });
                    }
                }
                const { rows } = await client.query(
                    `UPDATE evidence_sections
                      SET title = coalesce($2, title), ord = coalesce($3, ord), active = coalesce($4, active),
                          summary = coalesce($5, summary), only_secondary = coalesce($6, only_secondary),
                          scale = coalesce($7, scale)
                      WHERE id = $1 RETURNING id, code, title, ord, scale, summary, only_secondary,
                                            active, catalog, category_id`,
                    [id, body.title?.trim() ?? null, body.ord ?? null, body.active ?? null,
                     body.summary ?? null, body.onlySecondary ?? null, body.scale ?? null]
                );
                await client.query('COMMIT');
                return { ok: true, section: rows[0] };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.delete('/api/evidence/section/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const id = Number((req.params as any).id);
            await assertMayEdit(me, { section: id }, undefined, pool, scope);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query(
                    'SELECT id, title FROM evidence_sections WHERE id = $1 FOR UPDATE', [id]);
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no section with id ${id}` });
                }
                const scored = await scoreCount(
                    client,
                    `JOIN evidence_items i ON i.id = s.item_id
                      WHERE i.section_id = $1 AND s.value <> ''`, [id]
                );
                // Examiner writes reference these rows. Lock them before the
                // history check so a name cannot land after the count and then
                // disappear through the section's cascade.
                await client.query(
                    'SELECT id FROM evidence_examiner_roles WHERE section_id = $1 FOR UPDATE', [id]);
                const { rows: examinerCounts } = await client.query(
                    `SELECT count(*)::int AS n
                       FROM evidence_examiners e
                       JOIN evidence_examiner_roles r ON r.id = e.role_id
                      WHERE r.section_id = $1 AND e.name <> ''`, [id]);
                const examiners = examinerCounts[0].n as number;
                if (scored || examiners) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${rows[0].title}" already carries recorded work -- hide it instead of deleting it`,
                        scores: scored, examiners, examinerHistory: examiners > 0, deactivate: true
                    });
                }
                await client.query('DELETE FROM evidence_sections WHERE id = $1', [id]);
                await client.query('COMMIT');
                return { ok: true, deleted: id };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.post('/api/evidence/group', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const body = GroupBody.parse(req.body);
            await assertMayEdit(me, { section: body.sectionId }, undefined, pool, scope);
            const { rows } = await pool.query(
                `INSERT INTO evidence_groups (section_id, label, ord)
                 SELECT $1, $2, coalesce(max(ord), 0) + 1 FROM evidence_groups WHERE section_id = $1
                 RETURNING id, section_id, label, ord`,
                [body.sectionId, body.label.trim()]
            );
            return { ok: true, group: rows[0] };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.delete('/api/evidence/group/:id', async (req, reply) => {
        try {
            const me = await signed(req);
            const scope = await scopeOf(req);
            const id = Number((req.params as any).id);
            await assertMayEdit(me, { group: id }, undefined, pool, scope);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query(
                    'SELECT id, label FROM evidence_groups WHERE id = $1 FOR UPDATE', [id]);
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no group with id ${id}` });
                }
                // A group delete cascades through its items. Lock the same item
                // rows score writers hold before deciding that none is scored.
                await client.query(
                    'SELECT id FROM evidence_items WHERE group_id = $1 FOR UPDATE', [id]);
                const scored = await scoreCount(
                    client,
                    `JOIN evidence_items i ON i.id = s.item_id
                      WHERE i.group_id = $1 AND s.value <> ''`, [id]
                );
                if (scored) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${rows[0].label}" holds ${scored} marks -- hide its lines instead`,
                        scores: scored, deactivate: true
                    });
                }
                await client.query('DELETE FROM evidence_groups WHERE id = $1', [id]);
                await client.query('COMMIT');
                return { ok: true, deleted: id };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });

    // ── the year's columns ───────────────────────────────────────────────────

    server.post('/api/evidence/period', async (req, reply) => {
        try {
            await signed(req);
            await assertOwner(await scopeOf(req), 'колоните на учебната година');
            const body = PeriodBody.parse(req.body);
            const year = await resolveYear(body.year);
            await ensurePeriods(year.id);
            const { rows } = await pool.query(
                `INSERT INTO evidence_periods (school_year_id, ord, label, short_label)
                 SELECT $1, coalesce(max(ord), 0) + 1, $2, $3
                 FROM evidence_periods WHERE school_year_id = $1
                 RETURNING id, ord, label, short_label, active`,
                [year.id, body.label.trim(), body.shortLabel.trim()]
            );
            return { ok: true, period: rows[0] };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.patch('/api/evidence/period/:id', async (req, reply) => {
        try {
            await signed(req);
            await assertOwner(await scopeOf(req), 'колоните на учебната година');
            const body = PeriodPatch.parse(req.body);
            const id = Number((req.params as any).id);
            const { rows } = await pool.query(
                `UPDATE evidence_periods
                 SET label = coalesce($2, label), short_label = coalesce($3, short_label),
                     ord = coalesce($4, ord), active = coalesce($5, active)
                 WHERE id = $1 RETURNING id, ord, label, short_label, active`,
                [id, body.label?.trim() ?? null, body.shortLabel?.trim() ?? null,
                 body.ord ?? null, body.active ?? null]
            );
            if (!rows.length) return reply.code(404).send({ error: `no period with id ${id}` });
            return { ok: true, period: rows[0] };
        } catch (err) {
            return refuse(reply, err);
        }
    });

    server.delete('/api/evidence/period/:id', async (req, reply) => {
        try {
            await signed(req);
            await assertOwner(await scopeOf(req), 'колоните на учебната година');
            const id = Number((req.params as any).id);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query(
                    'SELECT id, label FROM evidence_periods WHERE id = $1 FOR UPDATE', [id]);
                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return reply.code(404).send({ error: `no period with id ${id}` });
                }
                const scored = await scoreCount(
                    client, "WHERE s.period_id = $1 AND s.value <> ''", [id]);
                if (scored) {
                    await client.query('ROLLBACK');
                    return reply.code(409).send({
                        error: `"${rows[0].label}" already holds ${scored} marks -- hide it instead of deleting it`,
                        scores: scored, deactivate: true
                    });
                }
                await client.query('DELETE FROM evidence_periods WHERE id = $1', [id]);
                await client.query('COMMIT');
                return { ok: true, deleted: id };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            return refuse(reply, err);
        }
    });
}
