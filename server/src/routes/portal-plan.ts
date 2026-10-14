/**
 * Акциски план, through the colleagues' door and for the administrator
 * (061; owner, 14 Oct 2026).
 *
 * WHAT THE OWNER DECIDED, and this file does exactly:
 *  - the same Kolega sign-in, with no second password;
 *  - everybody signed in — cabinets AND teachers — reads and writes every
 *    pupil's plan; it is not cut by caseload or class, because who takes which
 *    pupil changes through the year and following that made the plan
 *    unworkable;
 *  - the cabinets in a pupil's plan are chosen and stay as chosen;
 *  - the control is the record: who wrote what, when, before and after;
 *  - „потврда" is one person saying „my part for this quarter is done", for
 *    one pupil or for many at once.
 *
 * `MTB_PLAN_OWN_PASSWORD=1` is the switch the owner left for later („security
 * ке имаме кога ќе ја дефинираме конечната форма"): with it the plan is read
 * and written only on one's own password, as the check list already is.
 *
 * The /api/portal/plan routes are reachable in the cloud without the owner's
 * sign-in, so each one checks its own session through `signed` (handed in by
 * routes/portal.ts — one copy of that check). The /api/plan-changes routes are
 * the administrator's and stand outside the door.
 *
 * „Врати" and „Премести" are NEW writes through the one writer, guarded by
 * what the part holds now: a part somebody changed since is refused and said.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import {
    PART, applyPart, confirmable, hasReasons, isEmpty, keepAdded, lockPart, parsePart, partOf, quarterOf, readPart, reasonOf, sameState, stateOf,
    type PartRow, type PartState
} from '../lib/pupil-plan.js';
import type { Staff } from '../lib/staff-accounts.js';
import { readPlanBank } from '../lib/pupil-plan-bank.js';
import { prioritiesOf } from '../lib/pupil-plan-evidence.js';

type Who = {
    staff: Staff;
    year: { id: number; label: string };
    author: { employeeId: number | null; name: string };
    acting: boolean;
};
type SignedCheck = (req: FastifyRequest, reply: FastifyReply) => Promise<Who | null>;

const ADMIN_AUTHOR = 'Администраторот';
const NO_TABLE = 'Акцискиот план уште не е вклучен на овој сервер (миграција 061).';
const missing = (err: any) => err && err.code === '42P01';
const STALE = 'Овој дел е сменет во меѓувреме, па не е запишано.';
const NO_REASON = 'Причината не може да се запише на овој сервер (миграција 062). Тргнете ја причината и зачувајте пак.';

async function pupilOf(db: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> }, yearId: number, publicId: string) {
    const { rows } = await db.query(
        `SELECT s.id, s.public_id AS "publicId", s.name, e.grade AS class
           FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND s.active AND s.public_id = $2`, [yearId, publicId]);
    return rows[0] as { id: number; publicId: string; name: string; class: string | null } | undefined;
}

async function categoriesOf() {
    return (await pool.query('SELECT code, name FROM specialist_categories WHERE active ORDER BY ord, name')).rows as { code: string; name: string }[];
}

/** What is „mine" in the lists: the category one holds this year, and the classes one leads (or teaches, where one leads none). */
async function mineOf(staff: Staff, yearId: number) {
    const codes = (await pool.query(
        `SELECT c.code FROM therapist_years ty JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ty.school_year_id = $1 AND ty.therapist_id = $2 AND ty.active
         UNION
         SELECT c.code FROM teacher_years ty JOIN specialist_categories c ON c.id = ty.category_id
          WHERE ty.school_year_id = $1 AND ty.teacher_id = $3 AND ty.active`,
        [yearId, staff.therapistId, staff.teacherId])).rows.map((r: any) => r.code as string);
    const classes = staff.teacherId == null ? [] : (await pool.query(
        `SELECT c.label, tc.role FROM teacher_classes tc JOIN school_classes c ON c.id = tc.class_id
          WHERE tc.school_year_id = $1 AND tc.teacher_id = $2`, [yearId, staff.teacherId])).rows;
    const led = classes.filter((c: any) => c.role === 'homeroom');
    return { codes, classes: (led.length ? led : classes).map((c: any) => c.label as string) };
}

const shown = (row: PartRow) => ({ data: row.data, version: row.version, by: row.by, at: row.updatedAt,
    confirmedBy: row.confirmed ? row.confirmed.by : null, confirmedAt: row.confirmed ? row.confirmed.at : null });

export function registerPortalPlan(server: FastifyInstance, signed: SignedCheck) {
    /** The signed-in colleague, or an answer already sent. */
    async function entering(req: FastifyRequest, reply: FastifyReply): Promise<Who | null> {
        const who = await signed(req, reply);
        if (!who) return null;
        reply.header('Cache-Control', 'no-store');
        if (process.env.MTB_PLAN_OWN_PASSWORD === '1' && !who.acting) {
            const own = await pool.query('SELECT password_hash IS NOT NULL AS own FROM staff_accounts WHERE employee_id = $1', [who.staff.employeeId]);
            if (!(own.rows[0] && own.rows[0].own)) {
                reply.code(403).send({ needsPassword: true,
                    error: 'За акцискиот план прво поставете своја лозинка („Смени лозинка"). Почетната ја знаат сите.' });
                return null;
            }
        }
        return who;
    }
    const noTable = (reply: FastifyReply) => reply.code(503).send({ missing: true, error: NO_TABLE });

    // Keep the source/review files private. Only approved text leaves this
    // authenticated route; a broken bank never prevents writing a plan by hand.
    server.get('/api/portal/plan/bank', async (req, reply) => {
        if (!await entering(req, reply)) return;
        try { return readPlanBank(); }
        catch (err) {
            req.log.error({ err }, 'Action-plan bank unavailable');
            return reply.code(503).send({ error: 'Банката не е достапна. Може да продолжите со рачно пишување.' });
        }
    });

    /**
     * Phase 5: what the pupil's евидентен лист for this year suggests as a
     * priority (lib/pupil-plan-evidence.ts). Only the suggested items, with
     * their own marks: the owner chose that everybody in Kolega sees these, not
     * that the sheet is opened to everybody. It only reads — a year without
     * columns is not given any here.
     */
    server.get('/api/portal/plan/evidence', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        const query = z.object({ publicId: z.string().min(1).max(80) }).strict().safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Изберете ученик.' });
        const pupil = await pupilOf(pool, who.year.id, query.data.publicId);
        if (!pupil) return reply.code(404).send({ error: 'Ученикот не е на списокот за годинава.' });
        const sheet = (await pool.query('SELECT id FROM evidence_sheets WHERE student_id = $1 AND school_year_id = $2',
            [pupil.id, who.year.id])).rows[0];
        if (!sheet) return { sheet: false, periods: [], items: [] };
        const [periods, items, scores] = await Promise.all([
            pool.query(`SELECT id, ord, label, short_label AS short FROM evidence_periods WHERE school_year_id = $1 AND active ORDER BY ord`, [who.year.id]),
            // The prescribed form only: the `action` catalogue is the old app's plan, which this one is not linked to.
            pool.query(`SELECT i.id, i.label, g.label AS "group", s.code, s.title, s.scale
                          FROM evidence_items i JOIN evidence_sections s ON s.id = i.section_id
                          LEFT JOIN evidence_groups g ON g.id = i.group_id
                         WHERE i.active AND s.active AND s.catalog = 'prescribed' ORDER BY s.ord, i.ord`),
            pool.query('SELECT item_id, period_id, value FROM evidence_scores WHERE sheet_id = $1', [sheet.id])
        ]);
        const values = new Map<number, Map<number, string>>();
        for (const r of scores.rows) (values.get(r.item_id) || values.set(r.item_id, new Map()).get(r.item_id)!).set(r.period_id, r.value);
        const suggested = prioritiesOf(items.rows.map((r: any) => ({ id: r.id, label: r.label, group: r.group,
            section: { code: r.code, title: r.title, scale: r.scale } })), periods.rows, values);
        return { sheet: true, periods: periods.rows.map((p: any) => p.short || p.label), items: suggested };
    });

    /**
     * The whole year at a glance: every pupil, the cabinets in their plan, and
     * for each part only whether it is started or confirmed and by whom. No
     * text of any part leaves here.
     */
    server.get('/api/portal/plan', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        let parts: any[];
        try {
            parts = (await pool.query(
                `SELECT s.public_id, p.part, p.data, p.version, p.updated_by, p.confirmed_by
                   FROM pupil_plan_parts p JOIN students s ON s.id = p.student_id WHERE p.school_year_id = $1`, [who.year.id])).rows;
        } catch (err) { if (missing(err)) return noTable(reply); throw err; }
        const pupils = (await pool.query(
            `SELECT s.public_id AS "publicId", s.name, e.grade AS class
               FROM student_enrollments e JOIN students s ON s.id = e.student_id
              WHERE e.school_year_id = $1 AND e.active AND s.active ORDER BY s.name`, [who.year.id])).rows;
        const byPupil = new Map<string, any>(pupils.map((p: any) => [p.publicId, { ...p, cabinets: [], parts: {} }]));
        for (const r of parts) {
            const pupil = byPupil.get(r.public_id);
            if (!pupil) continue;
            if (r.part === 'cabinets') pupil.cabinets = Array.isArray(r.data.codes) ? r.data.codes : [];
            // An emptied part keeps its row and its version: the screen needs the version to write it again.
            else pupil.parts[r.part] = { version: r.version, by: r.updated_by, confirmedBy: r.confirmed_by, ...(isEmpty(r.data) ? { empty: true } : {}) };
        }
        const therapistId = who.staff.therapistId;
        const caseload = therapistId == null ? 0 : (await pool.query(
            'SELECT count(*)::int AS n FROM therapist_students WHERE school_year_id = $1 AND therapist_id = $2', [who.year.id, therapistId])).rows[0].n;
        return { year: who.year.label, quarter: quarterOf(new Date()), categories: await categoriesOf(),
            mine: { ...(await mineOf(who.staff, who.year.id)), caseload }, pupils: [...byPupil.values()] };
    });

    /** One pupil's plan, whole — and what each cabinet has already called its areas this year, to pick from. */
    server.get('/api/portal/plan/pupil', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        const query = z.object({ publicId: z.string().min(1).max(80) }).strict().safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Изберете ученик.' });
        const pupil = await pupilOf(pool, who.year.id, query.data.publicId);
        if (!pupil) return reply.code(404).send({ error: 'Ученикот не е на списокот за годинава.' });
        let rows: any[], named: any[];
        try {
            rows = (await pool.query(
                `SELECT part, data, version, updated_at, updated_by, confirmed_at, confirmed_by
                   FROM pupil_plan_parts WHERE school_year_id = $1 AND student_id = $2`, [who.year.id, pupil.id])).rows;
            named = (await pool.query(
                `SELECT part, data FROM pupil_plan_parts WHERE school_year_id = $1 AND part LIKE 'marks:%'`, [who.year.id])).rows;
        } catch (err) { if (missing(err)) return noTable(reply); throw err; }
        const labels: Record<string, string[]> = {};
        for (const r of named) {
            const code = partOf(r.part)?.code as string;
            const list = (labels[code] ||= []);
            for (const row of Array.isArray(r.data.rows) ? r.data.rows : []) if (row && row.label && !list.includes(row.label)) list.push(row.label);
        }
        Object.values(labels).forEach((list) => list.sort((a, b) => a.localeCompare(b, 'mk')));
        // The reason given with the change that left each part's text as it stands (062). A confirmation
        // changes no text, so it is passed over; an „undo" or a move that came after has no reason of its own.
        const reasons = await hasReasons(pool);
        const why = new Map<string, string>(reasons ? (await pool.query(
            `SELECT DISTINCT ON (part) part, reason FROM pupil_plan_changes
              WHERE school_year_id = $1 AND student_id = $2 AND kind NOT IN ('confirm', 'unconfirm') ORDER BY part, id DESC`,
            [who.year.id, pupil.id])).rows.filter((r: any) => r.reason).map((r: any) => [r.part, r.reason]) : []);
        return { year: who.year.label, pupil: { publicId: pupil.publicId, name: pupil.name, class: pupil.class }, labels, reasons,
            parts: Object.fromEntries(rows.map((r: any) => [r.part, { data: r.data, version: r.version, by: r.updated_by,
                at: r.updated_at, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at, ...(why.has(r.part) ? { reason: why.get(r.part) } : {}) }])) };
    });

    const PartBody = z.object({
        publicId: z.string().min(1).max(80),
        part: z.string().regex(PART),
        data: z.unknown(),
        /** The version the screen showed; 0 where it showed nothing written yet. */
        version: z.number().int().min(0),
        /** Why it was changed (phase 3, 062): optional, kept with the change in the record, never in the part. */
        reason: z.string().max(500).optional()
    }).strict();

    /** One part, written whole. A confirmed part that is changed is open again. */
    server.put('/api/portal/plan/part', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        const body = PartBody.safeParse(req.body);
        const data = body.success ? parsePart(body.data.part, body.data.data) : { ok: false as const };
        if (!body.success || !data.ok) return reply.code(400).send({ error: 'Проверете го внесеното: некое поле е предолго или не е во очекуваниот облик.' });
        const where = partOf(body.data.part);
        if (where?.code || body.data.part === 'cabinets') {
            // Also one retired since: a plan that already names it must stay writable.
            const known = new Set((await pool.query('SELECT code FROM specialist_categories')).rows.map((c: any) => c.code as string));
            const asked = where?.code ? [where.code] : (data.data.codes as string[]);
            if (asked.some((code) => !known.has(code))) return reply.code(400).send({ error: 'Тој кабинет не е на списокот на профили.' });
        }
        const pupil = await pupilOf(pool, who.year.id, body.data.publicId);
        if (!pupil) return reply.code(404).send({ error: 'Ученикот не е на списокот за годинава.' });
        // A reason the server cannot keep is said, never dropped: the page offers the field only where it can.
        const reason = reasonOf(body.data.reason);
        if (reason && !await hasReasons(pool)) return reply.code(409).send({ error: NO_REASON });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const key = { yearId: who.year.id, studentId: pupil.id, part: body.data.part };
            const current = await lockPart(client, key);
            if ((current?.version ?? 0) !== body.data.version) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ stale: true, error: STALE, current: current ? shown(current) : null });
            }
            const done = await applyPart(client, { ...key, kind: 'write', author: who.author, current, reason,
                next: { data: keepAdded(body.data.part, data.data, current?.data), by: who.author.name, confirmed: null } });
            await client.query('COMMIT');
            const now = done ? await readPart(pool, key) : current;
            return { ok: true, pupil: pupil.name, changeId: done ? done.changeId : null, part: now ? shown(now) : null,
                reopened: Boolean(done && current?.confirmed) };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (missing(err)) return noTable(reply);
            throw err;
        } finally { client.release(); }
    });

    const ConfirmBody = z.object({
        on: z.boolean(),
        items: z.array(z.object({
            publicId: z.string().min(1).max(80),
            part: z.string().regex(PART),
            version: z.number().int().min(0),
            /** A quarter's marks nobody has written yet: take the quarter before as they stand, and confirm that. */
            carry: z.boolean().optional()
        }).strict()).min(1).max(300)
    }).strict();

    /**
     * „Потврди" for one part or for many pupils at once. Each part is its own
     * transaction and its own answer: one that somebody changed meanwhile is
     * refused and named while the others are confirmed.
     */
    server.post('/api/portal/plan/confirm', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        const body = ConfirmBody.safeParse(req.body);
        if (!body.success || body.data.items.some((item) => !confirmable(item.part))) {
            return reply.code(400).send({ error: 'Проверете што се потврдува.' });
        }
        const results: any[] = [];
        for (const item of body.data.items) {
            const pupil = await pupilOf(pool, who.year.id, item.publicId);
            if (!pupil) { results.push({ publicId: item.publicId, part: item.part, ok: false, error: 'Ученикот не е на списокот за годинава.' }); continue; }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const key = { yearId: who.year.id, studentId: pupil.id, part: item.part };
                let current = await lockPart(client, key);
                const fail = async (error: string, extra: object = {}) => {
                    await client.query('ROLLBACK');
                    results.push({ publicId: item.publicId, part: item.part, pupil: pupil.name, ok: false, error, ...extra });
                };
                if ((current?.version ?? 0) !== item.version) { await fail(STALE, { stale: true }); continue; }
                const at = partOf(item.part)!;
                if (body.data.on && item.carry && (!current || isEmpty(current.data)) && at.kind === 'marks' && at.quarter! > 1) {
                    // The nearest earlier quarter that holds something: a cabinet may have skipped one.
                    let rows: unknown[] = [];
                    for (let quarter = at.quarter! - 1; quarter >= 1 && !rows.length; quarter--) {
                        const earlier = await readPart(client, { ...key, part: `marks:${at.code}:${quarter}` });
                        rows = earlier && Array.isArray(earlier.data.rows) ? earlier.data.rows : [];
                    }
                    if (!rows.length) { await fail('Нема оцени од претходен квартал за да се преземат.'); continue; }
                    await applyPart(client, { ...key, kind: 'write', author: who.author, current,
                        // A note is about its own quarter: the areas and their marks are taken, the notes are not.
                        next: { data: { rows: rows.map((row: any) => ({ ...row, note: '' })), note: '' }, by: who.author.name, confirmed: null } });
                    current = await lockPart(client, key);
                }
                if (!current || isEmpty(current.data)) { await fail('Празно е — нема што да се потврди.'); continue; }
                const next: PartState = { data: current.data, by: current.by,
                    confirmed: body.data.on ? { by: who.author.name, employeeId: who.author.employeeId, at: new Date().toISOString() } : null };
                // Confirmed already, by anybody: it stays theirs. Not confirmed and asked to open: nothing to do.
                if (body.data.on === Boolean(current.confirmed)) {
                    await client.query('COMMIT');
                    results.push({ publicId: item.publicId, part: item.part, pupil: pupil.name, ok: true, now: shown(current) });
                    continue;
                }
                await applyPart(client, { ...key, kind: body.data.on ? 'confirm' : 'unconfirm', author: who.author, current, next });
                const now = await lockPart(client, key);
                await client.query('COMMIT');
                results.push({ publicId: item.publicId, part: item.part, pupil: pupil.name, ok: true, now: shown(now as PartRow) });
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                if (missing(err)) return noTable(reply);
                throw err;
            } finally { client.release(); }
        }
        return { ok: results.every((r) => r.ok), done: results.filter((r) => r.ok).length,
            results };
    });

    /**
     * „Врати" for the colleague's OWN change, straight after making it — the
     * wrong pupil was open, the wrong button pressed. Only one's own, and only
     * while the part still stands as that change left it.
     */
    server.post('/api/portal/plan/undo', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        const body = z.object({ id: z.number().int().positive() }).strict().safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Проверете ја избраната промена.' });
        if (who.acting || who.author.employeeId == null) {
            return reply.code(403).send({ error: 'Како администратор, вратете ја промената од записот во „Списоци и пристап".' });
        }
        const answer = await undo(who.year, body.data.id, who.author, who.author.employeeId);
        return reply.code(answer.status).send(answer.body);
    });

    /**
     * A therapist's whole list at once: their category goes into the plan of
     * every pupil on their annual list. A copy made on this press — after it
     * the plan no longer follows the list, which is the point.
     */
    server.post('/api/portal/plan/from-caseload', async (req, reply) => {
        const who = await entering(req, reply);
        if (!who) return;
        if (who.staff.therapistId == null) return reply.code(403).send({ error: 'Листа на ученици имаат само кабинетите.' });
        const code = (await mineOf(who.staff, who.year.id)).codes[0];
        if (!code) return reply.code(409).send({ error: 'Уште немате доделен профил за годинава. Го доделува администраторот во „Списоци и пристап".' });
        const pupils = (await pool.query(
            `SELECT s.id FROM therapist_students ts JOIN students s ON s.id = ts.student_id
               JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = ts.school_year_id AND e.active
              WHERE ts.school_year_id = $1 AND ts.therapist_id = $2 AND s.active`, [who.year.id, who.staff.therapistId])).rows;
        let added = 0;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const pupil of pupils) {
                const key = { yearId: who.year.id, studentId: pupil.id, part: 'cabinets' };
                const current = await lockPart(client, key);
                const codes: string[] = current && Array.isArray(current.data.codes) ? current.data.codes as string[] : [];
                if (codes.includes(code)) continue;
                await applyPart(client, { ...key, kind: 'write', author: who.author, current,
                    next: { data: { codes: [...codes, code] }, by: who.author.name, confirmed: null } });
                added++;
            }
            await client.query('COMMIT');
            return { ok: true, added, already: pupils.length - added };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (missing(err)) return noTable(reply);
            throw err;
        } finally { client.release(); }
    });
}

type Answer = { status: number; body: Record<string, unknown> };

/**
 * Put one part back to what stood before a recorded change. `onlyAuthor`: the
 * employee whose own change this must be (a colleague); null for the administrator.
 */
async function undo(year: { id: number; label: string }, id: number, author: { employeeId: number | null; name: string },
    onlyAuthor: number | null, moveTo?: string): Promise<Answer> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const change = (await client.query(
            `SELECT c.id, c.student_id, c.part, c.kind, c.author_employee_id, c.before, c.after, c.undone_at, s.name
               FROM pupil_plan_changes c JOIN students s ON s.id = c.student_id
              WHERE c.id = $1 AND c.school_year_id = $2 FOR UPDATE OF c`, [id, year.id])).rows[0];
        const refuse = async (status: number, body: Record<string, unknown>): Promise<Answer> => { await client.query('ROLLBACK'); return { status, body }; };
        if (!change) return refuse(404, { error: 'Таа промена не е во записот за годинава.' });
        if (onlyAuthor != null && change.author_employee_id !== onlyAuthor) return refuse(403, { error: 'Може да се врати само сопствена промена.' });
        // A second press, or an old screen: put back once already.
        if (change.undone_at) return refuse(409, { stale: true, error: 'Оваа промена веќе е вратена. Списокот е освежен.' });
        const key = { yearId: year.id, studentId: change.student_id as number, part: change.part as string };
        const current = await lockPart(client, key);
        if (!sameState(stateOf(current), change.after as PartState)) {
            return refuse(409, { stale: true, error: 'Делот е сменет во меѓувреме, па не е вратен. Погледнете што стои сега.' });
        }
        let moved: { name: string } | null = null;
        if (moveTo !== undefined) {
            if (change.kind !== 'write' || change.part === 'cabinets') return refuse(409, { error: 'Се преместува само запишан текст или оцени.' });
            const target = await pupilOf(client, year.id, moveTo);
            if (!target) return refuse(404, { error: 'Тој ученик не е на списокот за годинава.' });
            if (target.id === change.student_id) return refuse(409, { error: 'Тоа е истиот ученик.' });
            const targetKey = { ...key, studentId: target.id };
            const there = await lockPart(client, targetKey);
            if (there && !isEmpty(there.data)) {
                return refuse(409, { occupied: true, error: `Кај „${target.name}" тој дел веќе е пополнет, па не е преместено. Ништо не е сменето.` });
            }
            // The words are the colleague's; that the administrator carried them over is what the record says.
            await applyPart(client, { ...targetKey, kind: 'move', author, current: there, undoOf: Number(change.id),
                next: { data: (change.after as PartState).data, by: (change.after as PartState).by, confirmed: null } });
            moved = { name: target.name };
        }
        const before = change.before as PartState | null;
        await applyPart(client, { ...key, kind: 'undo', author, current, undoOf: Number(change.id),
            next: before ?? { data: parsePartEmpty(change.part), by: author.name, confirmed: null } });
        await client.query('UPDATE pupil_plan_changes SET undone_at = now() WHERE id = $1', [change.id]);
        await client.query('COMMIT');
        return { status: 200, body: { ok: true, pupil: change.name, part: change.part, ...(moved ? { movedTo: moved.name } : {}) } };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (missing(err)) return { status: 503, body: { missing: true, error: NO_TABLE } };
        throw err;
    } finally { client.release(); }
}

/** A part with nothing in it, in its own shape: what „there was no row yet" is put back as. */
function parsePartEmpty(part: string): Record<string, unknown> {
    const parsed = parsePart(part, {});
    return parsed.ok ? parsed.data : {};
}

/** The administrator's record of the plans: read, put back, give to the right pupil. */
export async function planChangesRoutes(server: FastifyInstance, options: { year?: string } = {}) {
    const currentYear = async () => {
        const { rows } = options.year
            ? await pool.query('SELECT id, label FROM school_years WHERE label = $1', [options.year])
            : await pool.query('SELECT id, label FROM school_years WHERE is_current LIMIT 1');
        return rows[0] as { id: number; label: string } | undefined;
    };
    const owner = async (req: FastifyRequest, reply: FastifyReply) => {
        try { assertOwner(await scopeOf(req), 'акциските планови'); }
        catch (err) { refuseScope(reply, err); return null; }
        const year = await currentYear();
        if (!year) { reply.code(503).send({ error: 'Нема тековна учебна година.' }); return null; }
        return year;
    };

    const ListQuery = z.object({ employeeId: z.coerce.number().int().positive().optional(),
        publicId: z.string().min(1).max(80).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();

    server.get('/api/plan-changes', async (req, reply) => {
        const year = await owner(req, reply);
        if (!year) return;
        const query = ListQuery.safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'Проверете го изборот.' });
        const pupils = (await pool.query(
            `SELECT s.public_id AS "publicId", s.name, e.grade AS class
               FROM student_enrollments e JOIN students s ON s.id = e.student_id
              WHERE e.school_year_id = $1 AND e.active AND s.active ORDER BY s.name`, [year.id])).rows;
        const categories = await categoriesOf();
        let rows: any[], authors: any[], now: any[];
        try {
            const reason = await hasReasons(pool) ? 'c.reason' : 'NULL::text AS reason';
            rows = (await pool.query(
                `SELECT c.id, c.created_at, c.part, c.kind, c.author_employee_id, c.author_name, c.before, c.after, c.undo_of, c.undone_at, ${reason},
                        c.student_id, s.public_id, s.name, e.grade AS class
                   FROM pupil_plan_changes c JOIN students s ON s.id = c.student_id
                   LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = c.school_year_id
                  WHERE c.school_year_id = $1 AND ($2::int IS NULL OR c.author_employee_id = $2) AND ($3::text IS NULL OR s.public_id = $3)
                  ORDER BY c.id DESC LIMIT $4`, [year.id, query.data.employeeId ?? null, query.data.publicId ?? null, query.data.limit ?? 200])).rows;
            authors = (await pool.query(
                `SELECT DISTINCT c.author_employee_id AS "employeeId", c.author_name AS name FROM pupil_plan_changes c
                  WHERE c.school_year_id = $1 AND c.author_employee_id IS NOT NULL ORDER BY 2`, [year.id])).rows;
            now = (await pool.query(
                `SELECT student_id, part, data, updated_by, confirmed_at, confirmed_by, confirmed_by_employee
                   FROM pupil_plan_parts WHERE school_year_id = $1`, [year.id])).rows;
        } catch (err) {
            if (missing(err)) return { year: year.label, pupils, categories, authors: [], changes: [], missing: true, note: NO_TABLE };
            throw err;
        }
        const standing = new Map<string, PartState>(now.map((r: any) => [`${r.student_id}|${r.part}`, { data: r.data, by: r.updated_by,
            confirmed: r.confirmed_at ? { by: r.confirmed_by, employeeId: r.confirmed_by_employee, at: new Date(r.confirmed_at).toISOString() } : null }]));
        return {
            year: year.label, pupils, categories, authors,
            changes: rows.map((r: any) => {
                // Only while the part still stands exactly as this change left it: otherwise somebody has moved on from it.
                const canUndo = !r.undone_at && sameState(standing.get(`${r.student_id}|${r.part}`) ?? null, r.after);
                return { id: Number(r.id), at: r.created_at, author: r.author_name, kind: r.kind, part: r.part, reason: r.reason,
                    pupil: { publicId: r.public_id, name: r.name, class: r.class },
                    before: r.before, after: r.after, undoOf: r.undo_of == null ? null : Number(r.undo_of), undoneAt: r.undone_at,
                    canUndo, canMove: canUndo && r.kind === 'write' && r.part !== 'cabinets' && !isEmpty(r.after.data) };
            })
        };
    });

    server.post('/api/plan-changes/undo', async (req, reply) => {
        const year = await owner(req, reply);
        if (!year) return;
        const body = z.object({ id: z.number().int().positive() }).strict().safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Проверете ја избраната промена.' });
        const answer = await undo(year, body.data.id, { employeeId: null, name: ADMIN_AUTHOR }, null);
        return reply.code(answer.status).send(answer.body);
    });

    /**
     * „Премести кај друго дете": the colleague had the wrong pupil open. In one
     * transaction the part goes back as it was for the pupil it was written
     * on, and the same words are written for the pupil it was meant for —
     * unless that pupil's part already holds something, when nothing moves.
     */
    server.post('/api/plan-changes/move', async (req, reply) => {
        const year = await owner(req, reply);
        if (!year) return;
        const body = z.object({ id: z.number().int().positive(), toPublicId: z.string().min(1).max(80) }).strict().safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Изберете на кој ученик му припаѓа записот.' });
        const answer = await undo(year, body.data.id, { employeeId: null, name: ADMIN_AUTHOR }, null, body.data.toPublicId);
        return reply.code(answer.status).send(answer.body);
    });
}
