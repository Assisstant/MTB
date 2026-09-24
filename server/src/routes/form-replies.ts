/**
 * The review queue for offline form answers (docs/PLAN-formulari.md, step 1).
 *
 *   POST /api/forms/replies                  store one or many answers (files)
 *   GET  /api/forms/replies?year=            the year's answers, newest first
 *   GET  /api/forms/replies/:id/review       the items, checked against the database NOW
 *   POST /api/forms/replies/:id/decide       accept / reject items; accepted ones are written
 *   POST /api/forms/replies/:id/reject       set the whole answer aside
 *
 * THE ADMINISTRATOR, SIGNED IN — ALWAYS. The rest of this server stays open
 * until MTB_REQUIRE_SIGNIN=1 (see colleague.ts). The owner decided on 24 Sep
 * 2026 that this queue is different: an answer holds a colleague's whole week
 * and can move a child out of another cabinet, so only the administrator
 * named in MTB_ADMIN, signed in with their PIN, may read or decide it, on
 * every machine and in every mode. Without MTB_ADMIN nobody can, and the
 * refusal says how to set it.
 *
 * WRITING GOES THROUGH THE OWNERS. An accepted item is not written here: it is
 * handed to the route that already owns that fact — POST /api/workspace/pupils,
 * PUT/DELETE /api/therapists/:name/students/:id, PUT /api/schedule/block with
 * `expectedStudentPublicIds`, and for a class PUT /api/teaching/lesson with
 * `expected` or DELETE /api/teaching/lesson/:id — through `server.inject`,
 * with the administrator's own token. Every check those routes make still
 * happens, and a refusal is recorded as the item's outcome, in words.
 *
 * Two kinds of answer (docs/PLAN-formulari.md): `cabinet` — a therapist's
 * week and list; `class` — a class's lessons, plus reports about its pupils,
 * which are only ever noted: the owner decided the class form moves nobody.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { isAdmin, refuseScope, scopeOf } from '../lib/colleague.js';
import { Refused, whoIsSigned } from '../lib/evidence.js';
import {
    cabinetContext, cabinetItems, classContext, classItems, describeReply, fingerprintOf, settleNewest, type Item
} from '../lib/form-replies.js';

const StoreBody = z.object({
    replies: z.array(z.object({ fileName: z.string().max(300).optional(), reply: z.unknown() })).min(1).max(100)
});
const DecideBody = z.object({
    accept: z.array(z.string().min(1).max(300)).max(500).default([]),
    reject: z.array(z.string().min(1).max(300)).max(500).default([])
});

async function administrator(req: FastifyRequest): Promise<string> {
    const scope = await scopeOf(req);
    if (!scope.open && scope.service) return 'service';
    if (!(process.env.MTB_ADMIN || '').trim()) {
        throw new Refused(403, 'Нема поставен администратор. Во server/.env додај MTB_ADMIN=therapist:Име Презиме '
            + '(или teacher:Име Презиме) и рестартирај го серверот.', { needsAdmin: true, noAdmin: true });
    }
    const signed = await whoIsSigned(req.headers['x-mtb-evidence-token']);
    if (!isAdmin(signed)) {
        throw new Refused(403, 'Пристигнатите формулари ги прегледува само администраторот.', { needsAdmin: true });
    }
    return signed.name;
}

async function yearByLabel(label: string | undefined) {
    return (await pool.query(
        `SELECT id, label, is_current FROM school_years WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [label ?? null])).rows[0] || null;
}

async function reviewOf(id: number) {
    const row = (await pool.query(
        `SELECT r.*, y.label AS year_label, y.is_current FROM form_replies r
           JOIN school_years y ON y.id = r.school_year_id WHERE r.id = $1`, [id])).rows[0];
    if (!row) return null;
    const decisions = new Map((await pool.query(
        `SELECT item_key, decision, outcome, decided_by, decided_at FROM form_reply_decisions WHERE reply_id = $1`, [id])).rows
        .map((d: any) => [d.item_key, d]));
    const year = { id: row.school_year_id, label: row.year_label, is_current: row.is_current };
    if (row.kind === 'class') {
        const label = String(row.reply?.class?.label || '').replace(/\s+/g, ' ').trim();
        const ctx = await classContext(pool, year, label);
        const found = classItems(row.reply, ctx);
        found.items.forEach((item: Item) => { item.decision = decisions.get(item.key) || null; });
        const result = { errors: found.errors, therapist: null, classLabel: found.class, note: found.note, unchanged: found.unchanged, items: found.items };
        return { row, year, result, names: {} as Record<string, string> };
    }
    const probe = await cabinetContext(pool, year, -1);
    const wanted = probe.therapists.find((t) =>
        t.name.normalize('NFKC').trim().toLocaleLowerCase('mk-MK') === row.about_name.normalize('NFKC').trim().toLocaleLowerCase('mk-MK'));
    const ctx = wanted ? await cabinetContext(pool, year, wanted.id) : probe;
    const result = { ...cabinetItems(row.reply, ctx), classLabel: null as string | null };
    result.items.forEach((item: Item) => { item.decision = decisions.get(item.key) || null; });
    const names = Object.fromEntries(ctx.students.map((s) => [s.public_id, s.grade ? `${s.name} (${s.grade})` : s.name]));
    return { row, year, result, names };
}

const summary = (row: any) => ({
    id: row.id, kind: row.kind, year: row.year_label, about: row.about_name, fileName: row.file_name,
    madeAt: row.made_at, filledAt: row.filled_at, receivedAt: row.received_at, receivedBy: row.received_by,
    status: row.status, supersededBy: row.superseded_by, closedAt: row.closed_at, closedBy: row.closed_by,
    decided: row.decided ?? undefined
});

export async function formReplyRoutes(server: FastifyInstance) {
    server.post('/api/forms/replies', async (req, reply) => {
        let who: string;
        try { who = await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const body = StoreBody.parse(req.body);
        const results: Array<Record<string, unknown>> = [];
        const touched = new Set<string>();
        for (const incoming of body.replies) {
            const label = incoming.fileName || 'одговор';
            const d = describeReply(incoming.reply);
            if (!d.ok) { results.push({ fileName: label, outcome: 'refused', error: d.error }); continue; }
            const year = await yearByLabel(d.year);
            if (!year) { results.push({ fileName: label, outcome: 'refused', error: `учебната ${d.year} ја нема во базата` }); continue; }
            const fingerprint = fingerprintOf(incoming.reply);
            const existing = (await pool.query(`SELECT id, status FROM form_replies WHERE fingerprint = $1`, [fingerprint])).rows[0];
            if (existing) { results.push({ fileName: label, outcome: 'duplicate', id: existing.id, about: d.aboutName }); continue; }
            const row = (await pool.query(
                `INSERT INTO form_replies (kind, school_year_id, about_key, about_name, made_at, filled_at, file_name,
                                           fingerprint, reply, received_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [d.kind, year.id, d.aboutKey, d.aboutName, d.madeAt, d.filledAt, incoming.fileName ?? null,
                 fingerprint, JSON.stringify(incoming.reply), who])).rows[0];
            touched.add(JSON.stringify([year.id, d.kind, d.aboutKey]));
            results.push({ fileName: label, outcome: 'stored', id: row.id, about: d.aboutName, filledAt: d.filledAt });
        }
        for (const key of touched) {
            const [yearId, kind, aboutKey] = JSON.parse(key);
            await settleNewest(pool, yearId, kind, aboutKey);
        }
        // Say which of the stored ones ended up superseded by a newer answer.
        const ids = results.filter((r) => r.outcome === 'stored').map((r) => r.id);
        if (ids.length) {
            const status = new Map((await pool.query(`SELECT id, status FROM form_replies WHERE id = ANY($1::int[])`, [ids])).rows
                .map((r: any) => [r.id, r.status]));
            results.forEach((r) => { if (r.outcome === 'stored' && status.get(r.id) === 'superseded') r.outcome = 'superseded'; });
        }
        return { results };
    });

    server.get('/api/forms/replies', async (req, reply) => {
        try { await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const year = await yearByLabel((req.query as any)?.year);
        if (!year) return reply.code(404).send({ error: 'нема таква учебна година' });
        const rows = (await pool.query(
            `SELECT r.id, r.kind, y.label AS year_label, r.about_name, r.file_name, r.made_at, r.filled_at,
                    r.received_at, r.received_by, r.status, r.superseded_by, r.closed_at, r.closed_by,
                    (SELECT count(*)::int FROM form_reply_decisions d WHERE d.reply_id = r.id) AS decided
               FROM form_replies r JOIN school_years y ON y.id = r.school_year_id
              WHERE r.school_year_id = $1
              ORDER BY (r.status = 'pending') DESC, r.filled_at DESC NULLS LAST, r.id DESC`, [year.id])).rows;
        return { year: year.label, replies: rows.map(summary) };
    });

    server.get('/api/forms/replies/:id/review', async (req, reply) => {
        try { await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const review = await reviewOf(Number((req.params as any).id));
        if (!review) return reply.code(404).send({ error: 'нема таков одговор' });
        const { row, result, names } = review;
        return { reply: summary(row), note: result.note, errors: result.errors, therapist: result.therapist,
                 class: result.classLabel, unchanged: result.unchanged, items: result.items, names };
    });

    server.post('/api/forms/replies/:id/reject', async (req, reply) => {
        let who: string;
        try { who = await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const id = Number((req.params as any).id);
        const done = await pool.query(
            `UPDATE form_replies SET status = 'rejected', closed_at = now(), closed_by = $2
              WHERE id = $1 AND status IN ('pending', 'superseded') RETURNING id`, [id, who]);
        if (!done.rowCount) return reply.code(409).send({ error: 'одговорот е веќе затворен или го нема' });
        return { id, status: 'rejected' };
    });

    server.post('/api/forms/replies/:id/decide', async (req, reply) => {
        let who: string;
        try { who = await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const id = Number((req.params as any).id);
        const body = DecideBody.parse(req.body);
        const review = await reviewOf(id);
        if (!review) return reply.code(404).send({ error: 'нема таков одговор' });
        const { row, year, result } = review;
        if (row.status !== 'pending') {
            return reply.code(409).send({ error: row.status === 'superseded'
                ? (row.kind === 'class' ? 'пристигнал понов одговор за истото одделение — се одлучува за него'
                                        : 'пристигнал понов одговор за истиот терапевт — се одлучува за него')
                : 'одговорот е веќе затворен' });
        }
        if (result.errors.length || !(result.therapist || result.classLabel)) return reply.code(409).send({ error: result.errors.join(' ') });
        const therapist = result.therapist || { id: 0, name: '' };
        const byKey = new Map(result.items.map((item) => [item.key, item]));
        const accept = body.accept.filter((k) => byKey.has(k));
        const reject = body.reject.filter((k) => byKey.has(k) && !accept.includes(k));

        // Every inner write carries the administrator's own credentials, so the
        // owning route applies exactly the checks it applies to them directly.
        const headers: Record<string, string> = {};
        for (const h of ['x-mtb-evidence-token', 'x-mtb-service-key']) {
            const v = req.headers[h];
            if (typeof v === 'string') headers[h] = v;
        }
        const call = async (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
            // A content-type with no body is a 400 in Fastify; only a body carries one.
            const res = await server.inject(payload === undefined
                ? { method, url, headers }
                : { method, url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
            let json: any = null;
            try { json = res.json(); } catch { /* no body */ }
            if (res.statusCode >= 400) throw new Error((json && json.error) || `HTTP ${res.statusCode}`);
            return json;
        };
        const yearQuery = '?year=' + encodeURIComponent(year.label);
        const linkToList = (publicId: string) =>
            call('PUT', `/api/therapists/${encodeURIComponent(therapist.name)}/students/${encodeURIComponent(publicId)}${yearQuery}`);

        const outcomes = new Map<string, string>();
        const created = new Map<string, string>();
        const order = (t: Item['type']) => ({ pupil: 0, caseload: 1, block: 2, uncaseload: 3, lesson: 4, report: 5 })[t];
        const accepted = accept.map((k) => byKey.get(k)!).sort((a, b) => order(a.type) - order(b.type));
        for (const item of accepted) {
            if (item.decision) { outcomes.set(item.key, 'веќе одлучено'); continue; }
            if (item.state === 'refused') { outcomes.set(item.key, 'не може да се запише: ' + item.reasons.join('; ')); continue; }
            try {
                if (item.type === 'pupil') {
                    const answer = await call('POST', '/api/workspace/pupils', {
                        year: year.label, name: item.name, grade: null, oddelenie: null,
                        enrollmentType: 'external', boarding: false, programme: 'unknown',
                        placement: 'observation', active: true
                    });
                    created.set(String(item.name), answer.pupil.public_id);
                    await linkToList(answer.pupil.public_id);
                } else if (item.type === 'caseload') {
                    await linkToList(String(item.publicId));
                } else if (item.type === 'uncaseload') {
                    await call('DELETE', `/api/therapists/${encodeURIComponent(therapist.name)}/students/${encodeURIComponent(String(item.publicId))}${yearQuery}`);
                } else if (item.type === 'report') {
                    // Nothing to write: the administrator has read it, and
                    // moves the child in Податоци if the report is right.
                    outcomes.set(item.key, 'забележано');
                    continue;
                } else if (item.type === 'lesson') {
                    const to = item.toCell || null;
                    const from = item.fromCell || null;
                    if (!to) {
                        if (item.lessonId) await call('DELETE', `/api/teaching/lesson/${item.lessonId}`);
                    } else {
                        await call('PUT', '/api/teaching/lesson', {
                            year: year.label, day: item.day, ordinal: item.ordinal, class: result.classLabel,
                            subject: to.subject, teacher: to.teacher,
                            expected: from ? { subject: from.subject, teacher: from.teacher } : null
                        });
                    }
                } else {
                    const to = (item.to || []).map((x) => typeof x === 'string' ? x : created.get(x.create));
                    if (to.some((x) => !x)) throw new Error('новиот ученик во овој термин не е прифатен');
                    const theirs = new Set(result.items.length ? (await pool.query(
                        `SELECT s.public_id FROM therapist_students ts JOIN students s ON s.id = ts.student_id
                          WHERE ts.school_year_id = $1 AND ts.therapist_id = $2`, [year.id, therapist.id])).rows.map((r: any) => r.public_id) : []);
                    for (const publicId of to as string[]) if (!theirs.has(publicId)) await linkToList(publicId);
                    await call('PUT', '/api/schedule/block', {
                        year: year.label, day: item.day, time: item.time, therapistId: Number(therapist.id),
                        studentPublicIds: to, expectedStudentPublicIds: item.from || []
                    });
                }
                outcomes.set(item.key, 'запишано');
            } catch (err) {
                outcomes.set(item.key, 'одбиено при запишување: ' + (err as Error).message);
            }
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const item of accepted) {
                if (item.decision) continue;
                await client.query(
                    `INSERT INTO form_reply_decisions (reply_id, item_key, decision, outcome, decided_by)
                     VALUES ($1, $2, 'accepted', $3, $4) ON CONFLICT (reply_id, item_key) DO NOTHING`,
                    [id, item.key, outcomes.get(item.key) || null, who]);
            }
            for (const key of reject) {
                await client.query(
                    `INSERT INTO form_reply_decisions (reply_id, item_key, decision, outcome, decided_by)
                     VALUES ($1, $2, 'rejected', NULL, $3) ON CONFLICT (reply_id, item_key) DO NOTHING`,
                    [id, key, who]);
            }
            // Closed when every item that can be decided has been.
            const decided = new Set((await client.query(`SELECT item_key FROM form_reply_decisions WHERE reply_id = $1`, [id])).rows
                .map((r: any) => r.item_key));
            const open = result.items.filter((i) => i.state !== 'refused' && !decided.has(i.key));
            if (!open.length) {
                await client.query(`UPDATE form_replies SET status = 'done', closed_at = now(), closed_by = $2 WHERE id = $1`, [id, who]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
        return { id, outcomes: Object.fromEntries(outcomes), rejected: reject };
    });
}
