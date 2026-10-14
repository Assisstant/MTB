/**
 * The administrator's safety net for what colleagues change in their own
 * cabinets (060; owner, 13 Oct 2026: „да знам од која почетна состојба
 * почнале да ја менуваат", with a way back).
 *
 * Outside /api/portal/, so in the cloud the owner's sign-in stands in front
 * of it, and `assertOwner` keeps a colleague's sign-in out on a local server.
 *
 * „Врати" is a NEW write through the block writer every other screen uses,
 * with what the block holds now as `expected`: a term somebody changed since
 * is refused and said, never overwritten. It is not the ten-step undo of
 * app-navigation.js and shares nothing with it — that one is a window's own
 * memory of its own writes; this is a record of somebody else's.
 *
 * A block is compared and put back by its pupils AND their exact minutes: a
 * legacy row can be one lone half, and the pupil alone would come back as the
 * whole bell (review, 13 Oct 2026).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import { logTermChange, sameIds } from '../lib/portal-changes.js';
import { addNotices } from '../lib/portal-week.js';
import { TEACHING_DAYS } from '../lib/teaching.js';
import { blockState, blockTimes, writeBlockInTransaction } from './schedule-write.js';

const ADMIN_AUTHOR = 'Администраторот';
const NO_TABLE = 'Записот на промените уште не е вклучен на овој сервер (миграција 060).';
type State = { ids: string[]; times: string[] };
const sameState = (a: State | null, ids: string[], times: string[]) => a != null && sameIds(a.ids, ids) && sameIds(a.times, times);

export async function portalChangesRoutes(server: FastifyInstance, options: { year?: string } = {}) {
    const currentYear = async () => {
        const { rows } = options.year
            ? await pool.query('SELECT id, label FROM school_years WHERE label = $1', [options.year])
            : await pool.query('SELECT id, label FROM school_years WHERE is_current LIMIT 1');
        return rows[0] as { id: number; label: string } | undefined;
    };

    /** What a block of the year's cabinets holds now: its pupils and their minutes. */
    async function blocksNow(yearId: number, therapistId?: number) {
        const { rows } = await pool.query(
            `SELECT sl.therapist_id, sl.day, sl.time_slot, s.public_id AS student_public_id
               FROM schedule_slots sl LEFT JOIN students s ON s.id = sl.student_id
              WHERE sl.school_year_id = $1 AND ($2::int IS NULL OR sl.therapist_id = $2) ORDER BY sl.time_slot, sl.id`, [yearId, therapistId ?? null]);
        return (therapist: number, day: string, slot: string): State | null => {
            const times = blockTimes(slot);
            if (!times) return null;
            return blockState(rows.filter((r: any) => r.therapist_id === therapist && r.day === day
                && [times.full, ...times.halves].includes(r.time_slot)), times);
        };
    }

    async function namesOf(ids: string[]) {
        const out = new Map<string, string>();
        if (!ids.length) return out;
        const { rows } = await pool.query('SELECT public_id, name FROM students WHERE public_id = ANY($1::text[])', [[...new Set(ids)]]);
        rows.forEach((r: any) => out.set(r.public_id, r.name));
        return out;
    }
    const named = (ids: string[], times: string[], names: Map<string, string>) => ids.map((id, i) => ({
        publicId: id, name: names.get(id) || 'ученик што повеќе не е во списокот', time: times[i] }));

    const ListQuery = z.object({ therapistId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional() }).strict();

    /** The latest changes, newest first, each with whether it can still be put back. */
    server.get('/api/portal-changes', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'промените на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const query = ListQuery.safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Проверете го изборот.' });
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const therapists = (await pool.query(
            `SELECT t.id, t.name FROM therapists t JOIN therapist_years ty ON ty.therapist_id = t.id
              WHERE ty.school_year_id = $1 AND ty.active ORDER BY t.name`, [year.id])).rows;
        let rows: any[];
        try {
            rows = (await pool.query(
                `SELECT c.id, c.created_at, c.therapist_id, t.name AS therapist, c.author_name, c.day, c.slot,
                        c.before_ids, c.after_ids, c.before_times, c.after_times, c.forced, c.undo_of, c.undone_at
                   FROM portal_changes c JOIN therapists t ON t.id = c.therapist_id
                  WHERE c.school_year_id = $1 AND ($2::int IS NULL OR c.therapist_id = $2)
                  ORDER BY c.id DESC LIMIT $3`, [year.id, query.data.therapistId ?? null, query.data.limit ?? 200])).rows;
        } catch (err: any) {
            if (err && err.code === '42P01') return { year: year.label, therapists, changes: [], missing: true, note: NO_TABLE };
            throw err;
        }
        const names = await namesOf(rows.flatMap((r) => [...r.before_ids, ...r.after_ids]));
        const now = await blocksNow(year.id, query.data.therapistId);
        return {
            year: year.label, therapists,
            changes: rows.map((r) => ({
                id: Number(r.id), at: r.created_at, therapistId: r.therapist_id, therapist: r.therapist, author: r.author_name,
                day: r.day, slot: r.slot, before: named(r.before_ids, r.before_times, names), after: named(r.after_ids, r.after_times, names),
                forced: r.forced, undoOf: r.undo_of == null ? null : Number(r.undo_of), undoneAt: r.undone_at,
                // Only while the block still holds exactly what this change wrote: otherwise somebody has moved on from it.
                canUndo: !r.undone_at && sameState(now(r.therapist_id, r.day, r.slot), r.after_ids, r.after_times)
            }))
        };
    });

    /**
     * Where one colleague started from: for every block they have touched, what
     * stood there before the FIRST recorded change, beside what stands now.
     * A block nobody changed is as it was, so it is not listed.
     */
    server.get('/api/portal-changes/baseline', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'промените на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const query = z.object({ therapistId: z.coerce.number().int().positive() }).strict().safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Изберете кабинет.' });
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        let rows: any[];
        let since: Date | null;
        try {
            rows = (await pool.query(
                `SELECT DISTINCT ON (day, slot) id, day, slot, before_ids, before_times
                   FROM portal_changes WHERE school_year_id = $1 AND therapist_id = $2
                  ORDER BY day, slot, id`, [year.id, query.data.therapistId])).rows;
            // Asked of the database: sorting dates in JavaScript sorts their text, and Friday comes before Tuesday.
            since = (await pool.query('SELECT min(created_at) AS since FROM portal_changes WHERE school_year_id = $1 AND therapist_id = $2',
                [year.id, query.data.therapistId])).rows[0].since;
        } catch (err: any) {
            if (err && err.code === '42P01') return { year: year.label, since: null, blocks: [], unchanged: 0, missing: true, note: NO_TABLE };
            throw err;
        }
        const now = await blocksNow(year.id, query.data.therapistId);
        const all = rows.map((r) => ({ r, current: now(query.data.therapistId, r.day, r.slot) }));
        const differing = all.filter((x) => !sameState(x.current, x.r.before_ids, x.r.before_times));
        const names = await namesOf(differing.flatMap((x) => [...x.r.before_ids, ...(x.current ? x.current.ids : [])]));
        return {
            year: year.label, since,
            unchanged: all.length - differing.length,
            blocks: differing
                .sort((a, b) => TEACHING_DAYS.indexOf(a.r.day) - TEACHING_DAYS.indexOf(b.r.day) || String(a.r.slot).localeCompare(String(b.r.slot)))
                .map((x) => ({ changeId: Number(x.r.id), day: x.r.day, slot: x.r.slot, was: named(x.r.before_ids, x.r.before_times, names),
                    now: x.current ? named(x.current.ids, x.current.times, names) : [], overlap: x.current == null }))
        };
    });

    const Shown = z.object({ ids: z.array(z.string().min(1).max(80)).max(2), times: z.array(z.string().min(1).max(20)).max(2) }).strict();
    const UndoBody = z.object({
        id: z.number().int().positive(),
        /**
         * „Врати на почетното": the block as the comparison showed it standing
         * now. Without it this is the undo of ONE change, which must still be
         * the last word on its block and not undone already.
         */
        baseline: Shown.optional()
    }).strict();

    /** Put one block back to what stood before a recorded change. */
    server.post('/api/portal-changes/undo', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'промените на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const parsed = UndoBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Проверете ја избраната промена.' });
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const change = (await client.query(
                `SELECT id, therapist_id, day, slot, before_ids, after_ids, before_times, after_times, undone_at FROM portal_changes
                  WHERE id = $1 AND school_year_id = $2 FOR UPDATE`, [parsed.data.id, year.id])).rows[0];
            if (!change) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Таа промена не е во записот за годинава.' }); }
            // A second press, or an old screen: the change was put back once already. Doing it
            // again would clear whatever was booked there since, if it happens to look the same.
            if (!parsed.data.baseline && change.undone_at) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ stale: true, error: 'Оваа промена веќе е вратена. Списокот е освежен.' });
            }
            const expected = parsed.data.baseline ?? { ids: change.after_ids as string[], times: change.after_times as string[] };
            const result = await writeBlockInTransaction(client, { year: year.label, day: change.day, time: change.slot,
                therapistId: change.therapist_id, studentPublicIds: change.before_ids, expectedStudentPublicIds: expected.ids },
                { exactTimes: change.before_times, expectedTimes: expected.times });
            if (result.status !== 200) {
                await client.query('ROLLBACK');
                const body = result.body || {};
                const raw = String(body.error || '');
                if (/changed while you were editing/.test(raw)) return reply.code(409).send({ stale: true,
                    error: 'Терминот е сменет во меѓувреме, па не е вратен. Списокот е освежен — погледнете што стои сега.' });
                if (body.doubleBooked) return reply.code(409).send({ clash: true,
                    error: `Не може да се врати: „${body.studentName || 'ученикот'}" во тоа време сега е кај ${body.therapistName} (${body.time}).` });
                if (body.notInCaseload) return reply.code(409).send({ error: 'Не може да се врати: ученикот повеќе не е на листата на тој колега.' });
                if (/not active in this school year/.test(raw)) return reply.code(409).send({ error: 'Не може да се врати: ученикот повеќе не е на списокот за годинава.' });
                return reply.code(result.status).send({ error: raw || 'Терминот не е вратен.' });
            }
            await logTermChange(client, { yearId: year.id, therapistId: change.therapist_id, authorEmployeeId: null, authorName: ADMIN_AUTHOR,
                day: change.day, slot: change.slot, before: result.body.previousStudentPublicIds || [], after: result.body.studentPublicIds || [],
                beforeTimes: result.body.previousTimes || [], afterTimes: result.body.times || [], undoOf: Number(change.id) });
            // Everything written in this block since that change is now behind the block: none of it can be put back
            // as it stood. The change itself is closed even when it is an earlier undo, so it cannot be pressed twice.
            await client.query(
                `UPDATE portal_changes SET undone_at = now()
                  WHERE school_year_id = $1 AND therapist_id = $2 AND day = $3 AND slot = $4 AND id >= $5 AND undone_at IS NULL
                    AND (undo_of IS NULL OR id = $5)`,
                [year.id, change.therapist_id, change.day, change.slot, change.id]);
            const names = (await client.query('SELECT public_id, name FROM students WHERE public_id = ANY($1::text[])', [change.before_ids])).rows;
            const said = change.before_ids.map((id: string) => (names.find((n: any) => n.public_id === id) || {}).name || 'ученик').join(' и ') || 'слободен';
            const notified = await addNotices(client, { yearId: year.id, authorEmployeeId: null, authorName: ADMIN_AUTHOR,
                day: change.day, slot: change.slot, about: 'pupil:' + (change.before_ids[0] || change.after_ids[0] || ''), kind: 'term',
                recipients: [{ therapistId: change.therapist_id,
                    sentence: `${ADMIN_AUTHOR} го врати вашиот термин ${change.day}, ${change.slot} како што беше: ${said}.` }] });
            await client.query('COMMIT');
            return { ok: true, notified };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    });
}
