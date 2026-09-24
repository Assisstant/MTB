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
 * Three kinds of answer (docs/PLAN-formulari.md): `cabinet` — a therapist's
 * week and list; `class` — a class's lessons, plus reports about its pupils,
 * which are only ever noted: the owner decided the class form moves nobody;
 * `teacher` — a teacher's own week (class + subject per period).
 *
 * SIGNED WITH THE SENDER'S PIN (owner, 24 Sep 2026): an answer whose PIN
 * signature does not verify — none, a wrong PIN, somebody else's name — is
 * not stored at all (`verifySignature`). `GET /api/forms/signers` gives
 * the forms each person's PIN salt, never a hash.
 *
 * WHAT IS CLEAN IS WRITTEN AT ONCE (owner, 24 Sep 2026): colleagues answer for
 * their own data, and it is enough to know who entered it. On import every
 * clean item that touches only the sender's own facts is written in their
 * name (`<name> (од формулар)`); conflicts, changes made meanwhile, new
 * children and pupil reports wait for the administrator (`selfApplies`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { isAdmin, refuseScope, scopeOf } from '../lib/colleague.js';
import { Refused, whoIsSigned } from '../lib/evidence.js';
import {
    cabinetContext, cabinetItems, classContext, classItems, describeReply, fingerprintOf, personKey, selfApplies, settleNewest,
    signers, teacherContext, teacherItems, verifySignature, type Item
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

const sameName = (a: string, b: string) =>
    a.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK') === b.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');

type Result = {
    errors: string[]; therapist: { id: number; name: string } | null; classLabel: string | null; teacher: string | null;
    note: string; unchanged: number; items: Item[];
};

async function reviewOf(id: number) {
    const row = (await pool.query(
        `SELECT r.*, y.label AS year_label, y.is_current FROM form_replies r
           JOIN school_years y ON y.id = r.school_year_id WHERE r.id = $1`, [id])).rows[0];
    if (!row) return null;
    const decisions = new Map((await pool.query(
        `SELECT item_key, decision, outcome, decided_by, decided_at FROM form_reply_decisions WHERE reply_id = $1`, [id])).rows
        .map((d: any) => [d.item_key, d]));
    const year = { id: row.school_year_id, label: row.year_label, is_current: row.is_current };
    let result: Result;
    let names: Record<string, string> = {};
    if (row.kind === 'class') {
        const label = String(row.reply?.class?.label || '').replace(/\s+/g, ' ').trim();
        const found = classItems(row.reply, await classContext(pool, year, label));
        result = { ...found, therapist: null, classLabel: found.class, teacher: null };
    } else if (row.kind === 'teacher') {
        const found = teacherItems(row.reply, await teacherContext(pool, year, row.about_name));
        result = { ...found, therapist: null, classLabel: null };
    } else {
        const probe = await cabinetContext(pool, year, -1);
        const wanted = probe.therapists.find((t) => sameName(t.name, row.about_name));
        const ctx = wanted ? await cabinetContext(pool, year, wanted.id) : probe;
        result = { ...cabinetItems(row.reply, ctx), classLabel: null, teacher: null };
        names = Object.fromEntries(ctx.students.map((s) => [s.public_id, s.grade ? `${s.name} (${s.grade})` : s.name]));
    }
    result.items.forEach((item: Item) => { item.decision = decisions.get(item.key) || null; });
    // An item already written now agrees with the database, so the planner
    // counts it as unchanged and it would vanish from the answer. It is the
    // record of who entered what, so it is put back from the answer itself.
    const present = new Set(result.items.map((i) => i.key));
    for (const [key, decision] of decisions) {
        if (present.has(key)) continue;
        const restored = restoreItem(key, row.reply);
        if (!restored) continue;
        restored.decision = decision;
        result.items.push(restored);
        result.unchanged = Math.max(0, result.unchanged - 1);
    }
    return { row, year, result, names };
}

/** What an answer said about one item, read back from the answer. */
function restoreItem(key: string, reply: any): Item | null {
    const at = key.indexOf(':');
    const type = key.slice(0, at) as Item['type'];
    const rest = key.slice(at + 1);
    const [day, part] = rest.split('|');
    const base = (reply?.baseline || {})[rest] ?? null;
    if (type === 'block') {
        return { key, type, state: 'clean', day, time: part, from: base || [], to: (reply?.blocks || {})[rest] || [], reasons: [] };
    }
    if (type === 'lesson' || type === 'mylesson') {
        const to = (reply?.cells || {})[rest] ?? null;
        return { key, type, state: 'clean', day, ordinal: Number(part), fromCell: base, toCell: to, reasons: [] };
    }
    if (type === 'caseload' || type === 'uncaseload') return { key, type, state: 'clean', publicId: rest, name: rest, reasons: [] };
    if (type === 'pupil') return { key, type, state: 'clean', name: rest.replace(/^new:/, ''), reasons: [] };
    return null;
}

const summary = (row: any) => ({
    id: row.id, kind: row.kind, year: row.year_label, about: row.about_name, fileName: row.file_name,
    madeAt: row.made_at, filledAt: row.filled_at, receivedAt: row.received_at, receivedBy: row.received_by,
    status: row.status, supersededBy: row.superseded_by, closedAt: row.closed_at, closedBy: row.closed_by,
    decided: row.decided ?? undefined, waiting: row.waiting ?? undefined
});

/** Who an answer is about, in words, for a refusal. */
const sameKind = (kind: string) => kind === 'class' ? 'истото одделение' : kind === 'teacher' ? 'истиот наставник' : 'истиот терапевт';

export async function formReplyRoutes(server: FastifyInstance) {
    /**
     * Accept or reject items of one answer. Accepted items are written by the
     * routes that own each fact, with the caller's own credentials; every
     * decision and outcome is recorded under `by`.
     */
    async function decide(id: number, acceptKeys: string[], rejectKeys: string[], by: string, headers: Record<string, string>) {
        const review = await reviewOf(id);
        if (!review) return { code: 404, body: { error: 'нема таков одговор' } };
        const { row, year, result } = review;
        if (row.status !== 'pending') {
            return { code: 409, body: { error: row.status === 'superseded'
                ? `пристигнал понов одговор за ${sameKind(row.kind)} — се одлучува за него`
                : 'одговорот е веќе затворен' } };
        }
        if (result.errors.length || !(result.therapist || result.classLabel || result.teacher)) {
            return { code: 409, body: { error: result.errors.join(' ') } };
        }
        const therapist = result.therapist || { id: 0, name: '' };
        const byKey = new Map(result.items.map((item) => [item.key, item]));
        const accept = acceptKeys.filter((k) => byKey.has(k));
        const reject = rejectKeys.filter((k) => byKey.has(k) && !accept.includes(k));

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
        const order: Record<Item['type'], number> = { pupil: 0, caseload: 1, block: 2, uncaseload: 3, lesson: 4, mylesson: 4, report: 5 };
        // A teacher's own week: freeing a period first, so a lesson moved
        // from Monday to Tuesday does not meet itself on the way.
        const weight = (i: Item) => order[i.type] + (i.type === 'mylesson' && !i.toCell ? -0.5 : 0);
        const accepted = accept.map((k) => byKey.get(k)!).sort((a, b) => weight(a) - weight(b));
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
                            expected: from ? { subject: from.subject, teacher: from.teacher ?? null } : null
                        });
                    }
                } else if (item.type === 'mylesson') {
                    const to = item.toCell || null;
                    const from = item.fromCell || null;
                    // Co-teaching when the plan found the same subject; and a
                    // conflict the administrator accepts is theirs to call two
                    // teachers in one class (the route still refuses a third).
                    await call('PUT', '/api/teaching/teacher-lesson', {
                        year: year.label, day: item.day, ordinal: item.ordinal, teacher: result.teacher,
                        class: to ? to.class : null, subject: to ? to.subject : null,
                        expected: { class: from ? from.class : null },
                        together: !!item.together || item.state !== 'clean'
                    });
                } else {
                    const to = (item.to || []).map((x) => typeof x === 'string' ? x : created.get(x.create));
                    if (to.some((x) => !x)) throw new Error('новиот ученик во овој термин не е прифатен');
                    const theirs = new Set((await pool.query(
                        `SELECT s.public_id FROM therapist_students ts JOIN students s ON s.id = ts.student_id
                          WHERE ts.school_year_id = $1 AND ts.therapist_id = $2`, [year.id, therapist.id])).rows.map((r: any) => r.public_id));
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
                    [id, item.key, outcomes.get(item.key) || null, by]);
            }
            for (const key of reject) {
                await client.query(
                    `INSERT INTO form_reply_decisions (reply_id, item_key, decision, outcome, decided_by)
                     VALUES ($1, $2, 'rejected', NULL, $3) ON CONFLICT (reply_id, item_key) DO NOTHING`,
                    [id, key, by]);
            }
            // Closed when every item that can be decided has been — and an
            // answer that changes nothing is a confirmation, closed at once.
            const decided = new Set((await client.query(`SELECT item_key FROM form_reply_decisions WHERE reply_id = $1`, [id])).rows
                .map((r: any) => r.item_key));
            const open = result.items.filter((i) => i.state !== 'refused' && !decided.has(i.key));
            if (!open.length) {
                await client.query(`UPDATE form_replies SET status = 'done', closed_at = now(), closed_by = $2 WHERE id = $1`, [id, by]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
        return { code: 200, body: { id, outcomes: Object.fromEntries(outcomes), rejected: reject, waiting: result.items.filter((i) =>
            i.state !== 'refused' && !i.decision && !outcomes.has(i.key) && !reject.includes(i.key)).length } };
    }

    /** The inner writes carry the caller's own credentials. */
    const credentials = (req: FastifyRequest) => {
        const headers: Record<string, string> = {};
        for (const h of ['x-mtb-evidence-token', 'x-mtb-service-key']) {
            const v = req.headers[h];
            if (typeof v === 'string') headers[h] = v;
        }
        return headers;
    };

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
            const signed = await verifySignature(pool, incoming.reply, d);
            if (!signed.ok) { results.push({ fileName: label, outcome: 'refused', about: d.aboutName, error: signed.error }); continue; }
            const row = (await pool.query(
                `INSERT INTO form_replies (kind, school_year_id, about_key, about_name, made_at, filled_at, file_name,
                                           fingerprint, reply, received_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [d.kind, year.id, d.aboutKey, d.aboutName, d.madeAt, d.filledAt, incoming.fileName ?? null,
                 fingerprint, JSON.stringify(incoming.reply), who])).rows[0];
            touched.add(JSON.stringify([year.id, d.kind, d.aboutKey]));
            results.push({ fileName: label, outcome: 'stored', id: row.id, about: d.aboutName, filledAt: d.filledAt,
                           signedBy: signed.name, ...(signed.created ? { pinCreated: true } : {}) });
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
        // Colleagues answer for their own data (owner, 24 Sep 2026): what is
        // clean is written now, in their name; the rest waits. Oldest first,
        // so two people's answers land in the order they were filled in.
        const fresh = results.filter((r) => r.outcome === 'stored')
            .sort((a, b) => String(a.filledAt || '').localeCompare(String(b.filledAt || '')));
        for (const r of fresh) {
            const review = await reviewOf(Number(r.id));
            if (!review || review.result.errors.length) { r.applied = 0; r.waiting = review ? review.result.items.length : 0; continue; }
            const own = review.result.items.filter(selfApplies).map((i) => i.key);
            const done = await decide(Number(r.id), own, [], `${r.signedBy || review.row.about_name} (од формулар)`, credentials(req));
            const outcomes = Object.values((done.body as any).outcomes || {}) as string[];
            r.applied = outcomes.filter((o) => o === 'запишано').length;
            r.failed = outcomes.length - (r.applied as number);
            r.waiting = (done.body as any).waiting ?? 0;
            if (!review.result.items.length) r.confirmed = true;
        }
        return { results };
    });

    // Salts only: they are what a form needs to sign with, and useless
    // without the PIN. Open like /api/evidence/people, so any export works.
    server.get('/api/forms/signers', async () => ({ people: await signers(pool) }));

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

    /**
     * Who has answered and who has not — the owner's way to see whose data is
     * still missing. Everybody on the year's lists, with their latest answer.
     */
    server.get('/api/forms/coverage', async (req, reply) => {
        try { await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const year = await yearByLabel((req.query as any)?.year);
        if (!year) return reply.code(404).send({ error: 'нема таква учебна година' });
        const latest = new Map((await pool.query(
            `SELECT DISTINCT ON (about_key) about_key, filled_at, status FROM form_replies
              WHERE school_year_id = $1 AND status <> 'rejected'
              ORDER BY about_key, filled_at DESC NULLS LAST, id DESC`, [year.id])).rows.map((r: any) => [r.about_key, r]));
        const seen = (key: string) => {
            const r = latest.get(key);
            return r ? { filledAt: r.filled_at, status: r.status } : { filledAt: null, status: null };
        };
        const therapists = (await pool.query(
            `SELECT t.name, count(sl.id)::int AS terms FROM therapists t
               JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = $1 AND ty.active
               LEFT JOIN schedule_slots sl ON sl.therapist_id = t.id AND sl.school_year_id = $1
              GROUP BY t.id ORDER BY t.name`, [year.id])).rows
            .map((t: any) => ({ name: t.name, terms: t.terms, ...seen(personKey('therapist', t.name)) }));
        const teachers = (await pool.query(
            `SELECT t.name, count(l.id)::int AS lessons,
                    min(c.label) FILTER (WHERE tc.role = 'homeroom') AS homeroom
               FROM teachers t
               JOIN teacher_years ty ON ty.teacher_id = t.id AND ty.school_year_id = $1 AND ty.active
               LEFT JOIN lessons l ON l.teacher_id = t.id AND l.school_year_id = $1
               LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.school_year_id = $1 AND tc.role = 'homeroom'
               LEFT JOIN school_classes c ON c.id = tc.class_id
              GROUP BY t.id ORDER BY t.name`, [year.id])).rows
            .map((t: any) => ({ name: t.name, lessons: t.lessons, homeroom: t.homeroom, ...seen(personKey('teacher', t.name)),
                                classForm: t.homeroom ? seen(personKey('class', t.homeroom)).filledAt : null }));
        return { year: year.label, therapists, teachers };
    });

    server.get('/api/forms/replies/:id/review', async (req, reply) => {
        try { await administrator(req); } catch (err) { return refuseScope(reply, err); }
        const review = await reviewOf(Number((req.params as any).id));
        if (!review) return reply.code(404).send({ error: 'нема таков одговор' });
        const { row, result, names } = review;
        return { reply: summary(row), note: result.note, errors: result.errors, therapist: result.therapist,
                 class: result.classLabel, teacher: result.teacher, unchanged: result.unchanged, items: result.items, names };
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
        const body = DecideBody.parse(req.body);
        const done = await decide(Number((req.params as any).id), body.accept, body.reject, who, credentials(req));
        return reply.code(done.code).send(done.body);
    });
}
