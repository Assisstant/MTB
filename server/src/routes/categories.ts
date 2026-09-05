/**
 * Категории на стручни лица — the catalogue of profiles, who holds one, and
 * which action-plan sections a sheet therefore carries.
 *
 * Everyone READS everything: the centre's own decision, and the reason none of
 * these reads is behind the sign-in. Writing is another matter — an override
 * recorded against a pupil's document has to be able to name who made it.
 *
 * There is no DELETE. A category nobody staffs this year is a different fact
 * from one that never existed, and archived sections point at it.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { Refused, resolveYear, whoIsSigned } from '../lib/evidence.js';
import {
    listCategories, createCategory, renameCategory, setCategoryActive,
    categoryHolders, setPersonCategory, categoriesForPupil, teamForPupil,
    sheetSections, setSheetSection, assertMayEdit, CategoryRefused
} from '../lib/categories.js';
import { assertOwnSheet, scopeOf } from '../lib/colleague.js';

const NewCategory = z.object({
    code: z.string().min(1).max(48),
    name: z.string().min(1).max(120),
    ord: z.number().int().min(0).max(9999).optional()
});
const RenameCategory = z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(120),
    expected: z.string().max(120).optional()
});
const ActiveCategory = z.object({
    id: z.number().int().positive(),
    active: z.boolean()
});
const HolderBody = z.object({
    year: z.string().min(1).max(64).optional(),
    kind: z.enum(['therapist', 'teacher']),
    personId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable()
});
const SectionBody = z.object({
    sheetId: z.number().int().positive(),
    sectionId: z.number().int().positive(),
    included: z.boolean()
});

/** One place that turns either refusal into an answer, so no route invents its own. */
function refuse(reply: any, err: any) {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message });
    if (err instanceof CategoryRefused) {
        return reply.code(err.status).send({ error: err.message, ...err.detail });
    }
    throw err;
}

export async function categoryRoutes(server: FastifyInstance) {
    server.get('/api/categories', async (req) => {
        const all = String((req.query as any)?.all ?? '') === '1';
        return { categories: await listCategories(all) };
    });

    server.post('/api/categories', async (req, reply) => {
        const parsed = NewCategory.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'code and name are required' });
        try {
            const { code, name, ord } = parsed.data;
            return { category: await createCategory(code, name, ord ?? 500) };
        } catch (err) { return refuse(reply, err); }
    });

    server.patch('/api/categories', async (req, reply) => {
        const parsed = RenameCategory.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'id and name are required' });
        try {
            const { id, name, expected } = parsed.data;
            return { category: await renameCategory(id, name, expected) };
        } catch (err) { return refuse(reply, err); }
    });

    server.put('/api/categories/active', async (req, reply) => {
        const parsed = ActiveCategory.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'id and active are required' });
        try {
            return { category: await setCategoryActive(parsed.data.id, parsed.data.active) };
        } catch (err) { return refuse(reply, err); }
    });

    /** Who holds what, in one year — therapists and teachers together. */
    server.get('/api/categories/holders', async (req, reply) => {
        try {
            const year = await resolveYear((req.query as any)?.year);
            return { year: year.label, ...(await categoryHolders(year.id)) };
        } catch (err) { return refuse(reply, err); }
    });

    server.put('/api/categories/holder', async (req, reply) => {
        const parsed = HolderBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'kind, personId and categoryId are required' });
        }
        try {
            const year = await resolveYear(parsed.data.year);
            const saved = await setPersonCategory(
                year.id, parsed.data.kind, parsed.data.personId, parsed.data.categoryId);
            return { year: year.label, ...saved };
        } catch (err) { return refuse(reply, err); }
    });

    /**
     * Which categories apply to a pupil, and the people behind them.
     *
     * Both in one read: a screen fetching them separately could draw a person
     * holding a profile its own list has not heard of yet.
     */
    server.get('/api/categories/pupil', async (req, reply) => {
        const publicId = String((req.query as any)?.student ?? '');
        if (!publicId) return reply.code(400).send({ error: 'student (public_id) is required' });
        try {
            const year = await resolveYear((req.query as any)?.year);
            const found = await pool.query(
                'SELECT id FROM students WHERE public_id = $1', [publicId]);
            if (!found.rowCount) return reply.code(404).send({ error: 'no such student' });
            const [categories, team] = await Promise.all([
                categoriesForPupil(year.id, found.rows[0].id),
                teamForPupil(year.id, found.rows[0].id)
            ]);
            return {
                year: year.label,
                categories,
                team,
                // Compatibility for the first AkciskiPlan client, which knew
                // only about caseload therapists. New clients read `team`.
                therapists: team.filter((person) => person.kind === 'therapist')
            };
        } catch (err) { return refuse(reply, err); }
    });

    server.get('/api/evidence/sheet-sections', async (req, reply) => {
        const sheetId = Number((req.query as any)?.sheet);
        if (!Number.isInteger(sheetId) || sheetId <= 0) {
            return reply.code(400).send({ error: 'sheet is required' });
        }
        try {
            await assertOwnSheet(await scopeOf(req), sheetId);
            return { sections: await sheetSections(sheetId) };
        } catch (err) { return refuse(reply, err); }
    });

    /** Signed in, because this decision is recorded against a pupil's document. */
    server.put('/api/evidence/sheet-section', async (req, reply) => {
        const parsed = SectionBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'sheetId, sectionId and included are required' });
        }
        try {
            const who = await whoIsSigned((req.headers as any)['x-mtb-evidence-token']);
            const scope = await scopeOf(req);
            const target = await assertOwnSheet(scope, parsed.data.sheetId);
            if (!scope.open && !scope.admin) {
                await assertMayEdit(who, { section: parsed.data.sectionId }, target.schoolYearId);
            }
            return await setSheetSection(
                parsed.data.sheetId, parsed.data.sectionId, parsed.data.included, who);
        } catch (err) { return refuse(reply, err); }
    });
}
