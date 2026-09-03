import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import {
    audiogramId, studentIdOf, templateIdOf, audiogramStudentId,
    upsertDossier, upsertScaleTemplate, upsertAssessment, upsertTriage, upsertAudiogram
} from '../lib/records.js';

/**
 * Stage F: the clinical records, one record at a time.
 *
 * The dossier, assessments, scale templates, triage tests and audiograms. These
 * five belong to the diary outright -- Rasporedi never sees them -- which makes
 * them the simplest stage so far and the one with the most surface.
 *
 * TWO THINGS ARE DIFFERENT HERE, AND BOTH MATTER.
 *
 * First, DELETE exists, and that is not a contradiction of the roster rule. The
 * rule protects PEOPLE: Rasporedi may not decide a child has left. An
 * assessment entered against the wrong student, or an audiogram imported twice,
 * is a document the therapist created and can uncreate. Nothing here can delete
 * a person, and nothing here can create one either -- an audiogram naming
 * someone not on the roster is stored with the name and no link, exactly as the
 * projection has always done.
 *
 * Second, none of the row-writing lives in this file. It is all in
 * lib/records.ts, which the whole-document projection also calls. That is
 * deliberate and it is the whole reason the refactor came first: a second
 * caller writing the same rows a slightly different way is the failure this
 * project keeps paying for, and it stays invisible until two numbers disagree.
 * One implementation, two callers.
 */

const DossierBody = z.object({
    sdnevnikId: z.union([z.number(), z.string()]),
    record: z.record(z.unknown())
});

const AssessmentBody = z.object({
    /** The diary's own id -- Date.now(), so bigint. */
    id: z.union([z.number(), z.string()]),
    sdnevnikId: z.union([z.number(), z.string()]),
    assessment: z.record(z.unknown())
});

const TriageBody = z.object({
    id: z.union([z.number(), z.string()]),
    sdnevnikId: z.union([z.number(), z.string()]),
    test: z.record(z.unknown())
});

const TemplateBody = z.object({
    template: z.record(z.unknown())
});

const AudiogramBody = z.object({
    audiogram: z.record(z.unknown())
});

function bigintish(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export async function recordWriteRoutes(server: FastifyInstance) {

    /** One student's dossier. */
    server.put('/api/diary/record/dossier', async (req, reply) => {
        const body = DossierBody.parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const studentId = await studentIdOf(client, body.sdnevnikId);
            if (studentId == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({
                    error: `no student is linked to diary id ${body.sdnevnikId} -- save the diary once so the roster is projected first`,
                    unlinked: true
                });
            }
            await upsertDossier(client, studentId, body.record);
            await client.query('COMMIT');
            return { ok: true, sdnevnikId: String(body.sdnevnikId) };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * One assessment.
     *
     * The scale template is looked up rather than required: an assessment can
     * name a scale that has not been sent yet, and refusing would lose the
     * scores over a link. It lands unlinked and the next save of the template
     * connects it — the same tolerance the projection already had.
     */
    server.put('/api/diary/record/assessment', async (req, reply) => {
        const body = AssessmentBody.parse(req.body);
        const id = bigintish(body.id);
        if (id == null) return reply.code(400).send({ error: 'that assessment id is not a number' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const studentId = await studentIdOf(client, body.sdnevnikId);
            if (studentId == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({
                    error: `no student is linked to diary id ${body.sdnevnikId} -- save the diary once so the roster is projected first`,
                    unlinked: true
                });
            }
            const templateId = await templateIdOf(client, (body.assessment as any)?.scaleType);
            await upsertAssessment(client, studentId, templateId, { ...body.assessment, id });
            await client.query('COMMIT');
            return { ok: true, id: String(id), linkedToTemplate: templateId != null };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    server.delete('/api/diary/record/assessment/:id', async (req, reply) => {
        const id = bigintish((req.params as any).id);
        if (id == null) return reply.code(400).send({ error: 'that assessment id is not a number' });
        const { rowCount } = await pool.query('DELETE FROM assessments WHERE sdnevnik_id = $1', [id]);
        return { ok: true, id: String(id), removed: (rowCount ?? 0) > 0 };
    });

    /** One triage test. */
    server.put('/api/diary/record/triage', async (req, reply) => {
        const body = TriageBody.parse(req.body);
        const id = bigintish(body.id);
        if (id == null) return reply.code(400).send({ error: 'that test id is not a number' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const studentId = await studentIdOf(client, body.sdnevnikId);
            if (studentId == null) {
                await client.query('ROLLBACK');
                return reply.code(404).send({
                    error: `no student is linked to diary id ${body.sdnevnikId} -- save the diary once so the roster is projected first`,
                    unlinked: true
                });
            }
            await upsertTriage(client, studentId, { ...body.test, id });
            await client.query('COMMIT');
            return { ok: true, id: String(id) };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    server.delete('/api/diary/record/triage/:id', async (req, reply) => {
        const id = bigintish((req.params as any).id);
        if (id == null) return reply.code(400).send({ error: 'that test id is not a number' });
        const { rowCount } = await pool.query('DELETE FROM triage_tests WHERE sdnevnik_id = $1', [id]);
        return { ok: true, id: String(id), removed: (rowCount ?? 0) > 0 };
    });

    /** One rating scale. Its id is a string like "general_v2". */
    server.put('/api/diary/record/scale', async (req, reply) => {
        const body = TemplateBody.parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const id = await upsertScaleTemplate(client, body.template);
            if (id == null) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'a scale needs both an id and a name' });
            }
            await client.query('COMMIT');
            return { ok: true, id: String((body.template as any).id) };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    /**
     * Deleting a scale does NOT delete the assessments made with it.
     *
     * `template_id` is ON DELETE SET NULL and that is the right behaviour, not
     * an oversight to correct: the scores a therapist recorded are the record.
     * Losing a year of them because the form they were entered on was tidied
     * away would be the kind of quiet destruction this whole exercise exists to
     * stop. The answer says how many were cut loose.
     */
    server.delete('/api/diary/record/scale/:id', async (req) => {
        const id = String((req.params as any).id || '').trim();
        const affected = await pool.query(
            `SELECT count(*)::int AS n FROM assessments a
               JOIN scale_templates t ON t.id = a.template_id
              WHERE t.sdnevnik_id = $1`, [id]);
        const { rowCount } = await pool.query('DELETE FROM scale_templates WHERE sdnevnik_id = $1', [id]);
        return { ok: true, id, removed: (rowCount ?? 0) > 0, assessmentsUnlinked: affected.rows[0].n };
    });

    /**
     * One audiogram.
     *
     * The id is DERIVED from the record, so the caller does not send one — see
     * lib/records.ts. Two audiograms with the same subject, date, kind and
     * curves are one record, because nothing in the data can tell them apart.
     */
    server.put('/api/diary/record/audiogram', async (req, reply) => {
        const body = AudiogramBody.parse(req.body);
        const a = body.audiogram as any;
        if (!a?.subjectName) return reply.code(400).send({ error: 'an audiogram needs a subject name' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Matched, never created. An audiogram may name someone who left
            // years ago; that is a link this side does not have, not a new
            // person to invent.
            const studentId = await audiogramStudentId(client, a.subjectName);
            const id = await upsertAudiogram(client, a, studentId);
            await client.query('COMMIT');
            return { ok: true, id, linkedToStudent: studentId != null, subject: String(a.subjectName) };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    });

    server.delete('/api/diary/record/audiogram/:id', async (req) => {
        const id = String((req.params as any).id || '').trim();
        const { rowCount } = await pool.query('DELETE FROM audiograms WHERE sdnevnik_id = $1', [id]);
        return { ok: true, id, removed: (rowCount ?? 0) > 0 };
    });

    /**
     * Everything, in the diary's own shapes, in one call.
     *
     * One call rather than five because the app reads them together on open and
     * five round trips over a tailnet link is five chances to arrive half done.
     * The dossier is keyed by the diary's student id; the rest are lists,
     * exactly as the payload carries them.
     */
    server.get('/api/diary/records', async () => {
        const [dossiers, scales, assessments, triage, audiograms] = await Promise.all([
            pool.query(
                `SELECT s.sdnevnik_id::text AS sdnevnik_id, r.first_name, r.last_name, r.birth_date,
                        r.father_name, r.mother_name, r.address, r.residence, r.contact,
                        r.findings, r.opinion, r.attachment_links
                 FROM student_records r JOIN students s ON s.id = r.student_id
                 WHERE s.sdnevnik_id IS NOT NULL ORDER BY s.sdnevnik_id`),
            pool.query('SELECT sdnevnik_id, name, category, indicators FROM scale_templates ORDER BY sdnevnik_id'),
            pool.query(
                `SELECT a.sdnevnik_id::text AS id, s.sdnevnik_id::text AS student_sdn,
                        t.sdnevnik_id AS scale_type, a.date, a.period, a.scores, a.average, a.comment
                 FROM assessments a JOIN students s ON s.id = a.student_id
                 LEFT JOIN scale_templates t ON t.id = a.template_id
                 WHERE s.sdnevnik_id IS NOT NULL AND a.sdnevnik_id IS NOT NULL
                 ORDER BY a.sdnevnik_id`),
            pool.query(
                `SELECT t.sdnevnik_id::text AS id, s.sdnevnik_id::text AS student_sdn,
                        t.test_date, t.assessor, t.payload
                 FROM triage_tests t JOIN students s ON s.id = t.student_id
                 WHERE s.sdnevnik_id IS NOT NULL AND t.sdnevnik_id IS NOT NULL
                 ORDER BY t.sdnevnik_id`),
            pool.query(
                `SELECT sdnevnik_id, subject_name, date, record_type, right_air, right_bone, left_air, left_bone
                 FROM audiograms WHERE sdnevnik_id IS NOT NULL ORDER BY sdnevnik_id`)
        ]);

        return {
            student_records: dossiers.rows.map((r: any) => ({
                id: Number(r.sdnevnik_id),
                firstName: r.first_name, lastName: r.last_name, birthDate: r.birth_date,
                fatherName: r.father_name, motherName: r.mother_name,
                address: r.address, residence: r.residence, contact: r.contact,
                findings: r.findings, opinion: r.opinion, attachmentLinks: r.attachment_links
            })),
            scaleTemplates: scales.rows.map((r: any) => ({
                id: r.sdnevnik_id, name: r.name, category: r.category, indicators: r.indicators
            })),
            assessments: assessments.rows.map((r: any) => ({
                id: Number(r.id), studentId: Number(r.student_sdn), scaleType: r.scale_type,
                date: r.date, period: r.period, scores: r.scores,
                average: r.average == null ? null : Number(r.average), comment: r.comment
            })),
            trijazenTestovi: triage.rows.map((r: any) => ({
                id: Number(r.id), studentId: Number(r.student_sdn),
                date: r.test_date, assessor: r.assessor, assessments: r.payload
            })),
            audiograms: audiograms.rows.map((r: any) => ({
                _id: r.sdnevnik_id,        // derived; the app recomputes it and never stores it
                subjectName: r.subject_name, date: r.date, recordType: r.record_type,
                rightAir: r.right_air, rightBone: r.right_bone,
                leftAir: r.left_air, leftBone: r.left_bone
            }))
        };
    });

    /** So a test — or a curious person — can ask what id a record would get. */
    server.post('/api/diary/record/audiogram/id', async (req) => {
        return { id: audiogramId((req.body as any)?.audiogram ?? req.body) };
    });
}
