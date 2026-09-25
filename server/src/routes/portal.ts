/**
 * The colleagues' door: sign in with your own name, see your own week
 * (docs/PLAN-kolegi-online.md; owner, 25 Sep 2026).
 *
 * EVERY ROUTE HERE CHECKS ITS OWN SESSION. In the cloud these are the only API
 * paths the Google gate lets through without the owner's sign-in
 * (`cloud-auth.ts`), so nothing may be answered here that a colleague should
 * not see. A colleague gets their own week, the names of their own pupils and
 * — for a clash — the other person's name and the term; never the roster and
 * never anybody else's week.
 *
 * The token travels in a header, not a cookie: a page on another site cannot
 * make the browser send it, so nothing here can be driven from elsewhere.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import { assertOwner, refuseScope, scopeOf } from '../lib/colleague.js';
import { TEACHING_DAYS } from '../lib/teaching.js';
import {
    addNotices, classLessonClashes, myLessonClashes, noticeSentence, putLesson, putTeacherLesson,
    standingClashes, yearClasses, yearLessons, yearTeachers, type Clash, type WeekLesson
} from '../lib/portal-week.js';
import { bellsOf, subjectOffer } from './teaching.js';
import { blockTimes, semanticBlock, writeBlock } from './schedule-write.js';
import { minutesOf, timeOf } from '../lib/crossing.js';
import {
    MIN_PASSWORD, PORTAL_TOKEN_HEADER, closeOtherSessions, closeSession, looseKey, nameKeys,
    openSession, passwordMatches, resetAccount, resolveUsername, sessionEmployee, setPassword,
    staffOfYear, usernamesOf, type Staff
} from '../lib/staff-accounts.js';

// Failed sign-ins, in memory: per username and per address. Five wrong
// passwords for one name in ten minutes stop that name for the rest of them;
// twenty from one address stop the address.
const WINDOW_MS = 10 * 60 * 1000;
const PER_NAME = 5;
const PER_ADDRESS = 20;
const failures = new Map<string, { n: number; until: number }>();

function blockedFor(key: string, limit: number): number {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.until <= Date.now()) { failures.delete(key); return 0; }
    return entry.n >= limit ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
}
function fail(key: string): void {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || entry.until <= now) failures.set(key, { n: 1, until: now + WINDOW_MS });
    else entry.n++;
}

const WRONG = 'Погрешно корисничко име или лозинка.';

/**
 * The year a colleague works in is the current one. A test names its own
 * invented year through the plugin's options instead, so it never has to put
 * invented people on the real year's lists.
 */
let yearLabel: string | undefined;
async function currentYear() {
    const { rows } = yearLabel
        ? await pool.query('SELECT id, label FROM school_years WHERE label = $1', [yearLabel])
        : await pool.query('SELECT id, label FROM school_years WHERE is_current LIMIT 1');
    return rows[0] as { id: number; label: string } | undefined;
}

/** Who is asking, from the portal token — or a 401 already sent. */
type Signed = {
    staff: Staff;
    year: { id: number; label: string };
    /** Who a notice names as having done it: the person, or the administrator in their form. */
    author: { employeeId: number | null; name: string };
    acting: boolean;
};

/**
 * „Отвори го формуларот на…" (owner, 25 Sep): the administrator sees a
 * colleague's own form, with the right to resolve. Such a sign-in is made
 * only by the owner's route below, lives in MEMORY for two hours and is
 * never written anywhere: it is a look, not an account. What it writes is
 * signed as the administrator, and the colleague is told.
 */
const ACTING_HOURS = 2;
const acting = new Map<string, { employeeId: number; until: number }>();
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
function actingEmployee(token: unknown): number | null {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!/^[0-9a-f]{64}$/.test(value)) return null;
    const entry = acting.get(hashToken(value));
    if (!entry) return null;
    if (entry.until <= Date.now()) { acting.delete(hashToken(value)); return null; }
    return entry.employeeId;
}
const ADMIN_AUTHOR = 'Администраторот';

async function signed(req: FastifyRequest, reply: FastifyReply): Promise<Signed | null> {
    const token = req.headers[PORTAL_TOKEN_HEADER];
    const own = await sessionEmployee(pool, token);
    const asAdmin = own ? null : actingEmployee(token);
    const employeeId = own || asAdmin;
    const year = await currentYear();
    if (!employeeId || !year) {
        reply.code(401).send({ error: 'Најавата е истечена. Најавете се повторно.', signedOut: true });
        return null;
    }
    const staff = (await staffOfYear(pool, year.id)).find((s) => s.employeeId === employeeId);
    if (!staff) {
        reply.code(403).send({ error: 'Не сте на списокот за оваа учебна година. Јавете се кај администраторот.', notOnList: true });
        return null;
    }
    return asAdmin
        ? { staff, year, author: { employeeId: null, name: ADMIN_AUTHOR }, acting: true }
        : { staff, year, author: { employeeId: staff.employeeId, name: staff.name }, acting: false };
}

/** When the administrator wrote in somebody's form, that somebody is told too. */
async function tellIfActing(db: any, who: Signed, where: { day: string; slot: string; about: string; kind: 'lesson' | 'term'; what: string }) {
    if (!who.acting) return 0;
    const recipient = who.staff.teacherId != null ? { teacherId: who.staff.teacherId } : { therapistId: who.staff.therapistId as number };
    return addNotices(db, { yearId: who.year.id, authorEmployeeId: null, authorName: ADMIN_AUTHOR,
        day: where.day, slot: where.slot, about: where.about, kind: where.kind,
        recipients: [{ ...recipient, sentence: `${ADMIN_AUTHOR} ја смени вашата недела: ${where.what}` }] });
}

/** What the person does this year: the roles their form is made of. */
async function rolesOf(staff: Staff, yearId: number) {
    const roles: string[] = [];
    let teacher = null;
    if (staff.teacherId != null) {
        const { rows } = await pool.query(
            `SELECT t.kind, t.subject,
                    coalesce(json_agg(json_build_object('label', c.label, 'role', tc.role)
                             ORDER BY (tc.role = 'homeroom') DESC, c.sort_key, c.label)
                             FILTER (WHERE c.id IS NOT NULL), '[]') AS classes
               FROM teachers t
               LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.school_year_id = $2
               LEFT JOIN school_classes c ON c.id = tc.class_id
              WHERE t.id = $1 GROUP BY t.id`, [staff.teacherId, yearId]);
        const row = rows[0] || { kind: null, subject: null, classes: [] };
        teacher = { id: staff.teacherId, kind: row.kind, subject: row.subject, classes: row.classes };
        roles.push('teacher');
        if (row.classes.some((c: any) => c.role === 'homeroom')) roles.push('homeroom');
    }
    if (staff.therapistId != null) roles.push('therapist');
    return { roles, teacher, therapist: staff.therapistId != null ? { id: staff.therapistId } : null };
}

const MyLessonBody = z.object({
    day: z.string().min(1).max(20),
    ordinal: z.number().int().min(1).max(12),
    class: z.string().max(40).nullable(),
    subject: z.string().max(120).nullable().optional(),
    expected: z.object({ class: z.string().max(40).nullable().optional() }).nullable().optional(),
    force: z.boolean().optional()
});
const ClassLessonBody = z.object({
    class: z.string().min(1).max(40),
    day: z.string().min(1).max(20),
    ordinal: z.number().int().min(1).max(12),
    subject: z.string().max(120).nullable().optional(),
    teacherId: z.number().int().positive().nullable().optional(),
    expected: z.object({
        subject: z.string().max(120).nullable().optional(),
        teacher: z.string().max(200).nullable().optional()
    }).nullable().optional(),
    force: z.boolean().optional()
});

const cleanText = (value: unknown) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 120) : null;
};

/** Writes to one period are made one at a time, so two colleagues cannot both see it free. */
async function lockPeriod(client: any, yearId: number, day: string, ordinal: number) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portal-lesson|${yearId}|${day}|${ordinal}`]);
}

/** The class, if the person leads it this year. */
async function homeroomClass(client: any, who: { staff: Staff; year: { id: number } }, label: string) {
    if (who.staff.teacherId == null) return undefined;
    const { rows } = await client.query(
        `SELECT c.id, c.label FROM teacher_classes tc JOIN school_classes c ON c.id = tc.class_id
          WHERE tc.teacher_id = $1 AND tc.school_year_id = $2 AND tc.role = 'homeroom' AND c.label = $3`,
        [who.staff.teacherId, who.year.id, label]);
    return rows[0] as { id: number; label: string } | undefined;
}

/** A clash, said before anything is saved: who, which class, which subject. */
function clashAnswer(clashes: Clash[], day: string, ordinal: number) {
    const lines = clashes.map((c) => c.why === 'teacher-busy'
        ? `${c.teacher || 'Наставникот'} во тој час има ${c.class}${c.subject ? ` („${c.subject}")` : ''}.`
        : c.why === 'lesson-replaced'
            ? `Во тој час ${c.class} има „${c.subject || 'час'}" кај ${c.teacher || 'друг наставник'} — ќе се смени.`
            : `Во тој час ${c.class} веќе има „${c.subject || 'час'}" кај ${c.teacher || 'друг наставник'}.`);
    return {
        clash: true,
        error: `${day}, ${ordinal}. час: ` + lines.join(' '),
        clashes: clashes.map((c) => ({ teacher: c.teacher, class: c.class, subject: c.subject, why: c.why }))
    };
}

const TermBody = z.object({
    day: z.string().min(1).max(20),
    /** The 40-minute cabinet bell, „08:00-08:40". */
    time: z.string().min(1).max(20),
    /** None clears; one pupil owns all 40 minutes; two share it in halves. */
    pupils: z.array(z.string().min(1).max(80)).max(2),
    expected: z.array(z.string().min(1).max(80)).max(2).optional(),
    force: z.boolean().optional()
});

/** The block writer's refusals, in the staff room's words. */
function termRefusal(body: any) {
    const raw = String((body && body.error) || '');
    if (/changed while you were editing/.test(raw)) {
        return { stale: true, error: 'Во меѓувреме терминот е сменет. Неделата е освежена: погледнете и обидете се повторно.' };
    }
    if (body && body.notInCaseload) return { error: 'Тој ученик не е на вашиот список за годинава.' };
    if (body && body.therapistOccupied) return { error: 'Имате друг термин што се преклопува со овој.' };
    if (body && body.blockOverlap) return { error: 'Во овој термин има стари записи што се преклопуваат. Јавете се кај администраторот.' };
    if (/not active in this school year/.test(raw)) return { error: 'Тој ученик не е на листата за годинава.' };
    if (/40-minute/.test(raw)) return { error: 'Терминот мора да е еден час во кабинет (40 минути).' };
    return { error: raw || 'Терминот не е зачуван.' };
}

/**
 * A therapist's own cabinet: the 40-minute bells, their blocks, their own
 * pupils, and — for those pupils only — where they are with somebody else.
 * The only place this door names a child, and only the therapist's own.
 */
async function cabinetWeek(staff: Staff, year: { id: number; label: string }) {
    if (staff.therapistId == null) return null;
    const bells = (await bellsOf('kabinet', year.id))
        .filter((bell) => Number(bell.minutes) === 40 && bell.startsAt)
        .map((bell) => ({ ordinal: bell.ordinal, label: bell.label,
            time: `${bell.startsAt}-${timeOf(minutesOf(bell.startsAt) + 40)}` }));
    const pupils = (await pool.query(
        `SELECT s.public_id AS "publicId", s.name, e.grade AS class
           FROM therapist_students ts
           JOIN students s ON s.id = ts.student_id
           JOIN student_enrollments e ON e.student_id = s.id AND e.school_year_id = ts.school_year_id AND e.active
          WHERE ts.therapist_id = $1 AND ts.school_year_id = $2 AND s.active
          ORDER BY s.name`, [staff.therapistId, year.id])).rows;
    const rows = (await pool.query(
        `SELECT sl.day, sl.time_slot, s.public_id AS student_public_id, s.name AS student_name
           FROM schedule_slots sl LEFT JOIN students s ON s.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.therapist_id = $2`, [year.id, staff.therapistId])).rows;
    const names: Record<string, string> = {};
    rows.forEach((r: any) => { if (r.student_public_id) names[r.student_public_id] = r.student_name; });
    const terms = [];
    for (const day of TEACHING_DAYS) {
        for (const bell of bells) {
            const times = blockTimes(bell.time);
            if (!times) continue;
            const here = rows.filter((r: any) => r.day === day && [times.full, ...times.halves].includes(r.time_slot));
            if (!here.length) continue;
            const ids = semanticBlock(here, times);
            terms.push({ day, time: bell.time, pupils: ids ?? here.map((r: any) => r.student_public_id).filter(Boolean), overlap: ids === null });
        }
    }
    const own = pupils.map((p: any) => p.publicId);
    const elsewhere = own.length ? (await pool.query(
        `SELECT s.public_id AS "publicId", sl.day, sl.time_slot AS time, t.name AS therapist
           FROM schedule_slots sl
           JOIN students s ON s.id = sl.student_id
           JOIN therapists t ON t.id = sl.therapist_id
          WHERE sl.school_year_id = $1 AND sl.therapist_id <> $2 AND s.public_id = ANY($3::text[])`,
        [year.id, staff.therapistId, own])).rows : [];
    return { bells, pupils, terms, names, elsewhere };
}

/** Is this pupil still with two therapists at once somewhere on this day? */
async function pupilStillTwice(yearId: number, day: string, publicId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT sl.time_slot, sl.therapist_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.day = $2 AND s.public_id = $3`, [yearId, day, publicId]);
    const spans = rows.map((r: any) => {
        const [from, to] = String(r.time_slot).split('-');
        return { therapist: r.therapist_id, from: minutesOf(from), to: minutesOf(to) };
    }).filter((x: any) => Number.isFinite(x.from) && Number.isFinite(x.to));
    return spans.some((a: any, i: number) => spans.some((b: any, j: number) =>
        j > i && a.therapist !== b.therapist && a.from < b.to && b.from < a.to));
}

/** Is the clash a notice is about still standing? Read from the live timetable. */
async function noticeOpen(n: any, lessons: WeekLesson[], teacherId: number | null, yearId: number): Promise<boolean> {
    if (n.kind === 'term') return pupilStillTwice(yearId, n.day, String(n.about).replace(/^pupil:/, ''));
    if (n.kind !== 'lesson') return false;
    const label = String(n.about).replace(/^class:/, '');
    const ordinal = Number(n.slot);
    const cell = lessons.filter((l) => l.day === n.day && l.ordinal === ordinal && l.class === label && l.teacherId != null);
    const subjects = new Set(cell.map((l) => String(l.subject || '').toLocaleLowerCase('mk-MK')));
    const twice = teacherId != null
        && lessons.filter((l) => l.day === n.day && l.ordinal === ordinal && l.teacherId === teacherId).length > 1;
    return (cell.length > 1 && subjects.size > 1) || twice;
}

/** The notices for this person, each with whether the clash still stands. */
async function noticesFor(staff: Staff, yearId: number, lessons: WeekLesson[]) {
    const { rows } = await pool.query(
        `SELECT id, created_at AS "createdAt", author_name AS author, kind, day, slot, about, sentence, seen_at IS NOT NULL AS seen
           FROM schedule_notices
          WHERE recipient_employee_id = $1 AND school_year_id = $2 AND closed_at IS NULL
          ORDER BY created_at DESC LIMIT 100`, [staff.employeeId, yearId]);
    const out = [];
    for (const n of rows) {
        const open = await noticeOpen(n, lessons, staff.teacherId, yearId);
        out.push({ ...n, id: Number(n.id), open });
    }
    return out;
}

const LoginBody = z.object({ username: z.string().min(1).max(120), password: z.string().min(1).max(200) });
const PasswordBody = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) });

export async function portalRoutes(server: FastifyInstance, options: { year?: string } = {}) {
    yearLabel = options.year;

    /**
     * The short link that is shared with colleagues. It SHOWS the page rather
     * than redirecting to it, so the address a colleague sees stays the one
     * they were given (owner, 25 Sep: „да изгледа генерички").
     */
    // With its leading slash: the public-file list is asked about this path too.
    server.get('/kolegi', async (_req, reply) => (reply as any).sendFile('/Kolega.html'));

    server.post('/api/portal/login', async (req, reply) => {
        const parsed = LoginBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Внесете корисничко име и лозинка.' });
        const { username, password } = parsed.data;
        const nameKey = 'name:' + looseKey(username);
        const addressKey = 'address:' + req.ip;
        const wait = Math.max(blockedFor(nameKey, PER_NAME), blockedFor(addressKey, PER_ADDRESS));
        if (wait) {
            return reply.header('Retry-After', String(wait)).code(429)
                .send({ error: 'Премногу погрешни обиди. Обидете се повторно за неколку минути.', retryAfterSeconds: wait });
        }
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const found = resolveUsername(await staffOfYear(pool, year.id), username);
        if (!found.ok) {
            fail(nameKey); fail(addressKey);
            if (found.reason === 'ambiguous') {
                return reply.code(409).send({ error: 'Повеќе колеги се викаат така. Јавете се кај администраторот.', ambiguous: true });
            }
            return reply.code(401).send({ error: WRONG });
        }
        const check = await passwordMatches(pool, found.staff.employeeId, password);
        if (!check.ok) {
            fail(nameKey); fail(addressKey);
            return reply.code(401).send({ error: WRONG });
        }
        failures.delete(nameKey);
        const session = await openSession(pool, found.staff.employeeId);
        return {
            token: session.token,
            expiresAt: session.expiresAt,
            person: { employeeId: found.staff.employeeId, name: found.staff.name },
            usernames: usernamesOf(found.staff.name),
            initialPassword: check.initial
        };
    });

    server.post('/api/portal/logout', async (req) => {
        await closeSession(pool, req.headers[PORTAL_TOKEN_HEADER]);
        return { ok: true };
    });

    /** Offered, never required: keeping the initial password is the person's call. */
    server.post('/api/portal/password', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        if (who.acting) return reply.code(403).send({ error: 'Лозинката ја менува само колегата.' });
        const parsed = PasswordBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Внесете ја сегашната и новата лозинка.' });
        const next = parsed.data.next.trim();
        if (next.length < MIN_PASSWORD) {
            return reply.code(400).send({ error: `Новата лозинка мора да има барем ${MIN_PASSWORD} знаци.` });
        }
        const check = await passwordMatches(pool, who.staff.employeeId, parsed.data.current);
        if (!check.ok) return reply.code(403).send({ error: 'Сегашната лозинка не е точна.' });
        await setPassword(pool, who.staff.employeeId, next);
        await closeOtherSessions(pool, who.staff.employeeId, req.headers[PORTAL_TOKEN_HEADER]);
        return { ok: true };
    });

    server.get('/api/portal/me', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const own = await pool.query('SELECT password_hash IS NOT NULL AS own FROM staff_accounts WHERE employee_id = $1',
            [who.staff.employeeId]);
        return {
            person: { employeeId: who.staff.employeeId, name: who.staff.name },
            acting: who.acting,
            usernames: usernamesOf(who.staff.name),
            initialPassword: !(own.rows[0] && own.rows[0].own),
            year: who.year.label,
            ...(await rolesOf(who.staff, who.year.id))
        };
    });

    // ── step 2: the teaching week ─────────────────────────────────────────

    /**
     * The person's week. A teacher gets the school's teaching timetable —
     * which is posted in every staff room anyway — so the form can show whose
     * lesson a cell would sit on before anything is saved; the server checks
     * again on every write. Nobody gets a pupil's name from this route.
     */
    server.get('/api/portal/week', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const role = await rolesOf(who.staff, who.year.id);
        const homeroom = (role.teacher?.classes || []).filter((c: any) => c.role === 'homeroom').map((c: any) => c.label);
        const teaching = who.staff.teacherId != null;
        const [periods, lessons, classes, teachers] = teaching
            ? await Promise.all([bellsOf('nastava-am', who.year.id), yearLessons(pool, who.year.id),
                yearClasses(pool, who.year.id), yearTeachers(pool, who.year.id)])
            : [[], [], [], []] as [any[], WeekLesson[], any[], any[]];
        return {
            year: who.year.label,
            days: TEACHING_DAYS,
            periods: periods.map((p: any) => ({ ordinal: p.ordinal, label: p.label, startsAt: p.startsAt })),
            me: { teacherId: who.staff.teacherId, therapistId: who.staff.therapistId, homeroom, subject: role.teacher?.subject || null },
            classes: classes.map((c: any) => ({ label: c.label, description: c.description, homeroom: c.homeroom })),
            teachers: teachers.map((t: any) => ({ id: t.id, name: t.name, subject: t.subject })),
            lessons,
            clashes: teaching ? standingClashes(lessons, who.staff.teacherId, homeroom) : [],
            cabinet: await cabinetWeek(who.staff, who.year),
            notices: await noticesFor(who.staff, who.year.id, lessons)
        };
    });

    /** The MON offer for one class, as Уреди настава has it. */
    server.get('/api/portal/subjects', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const label = String((req.query as any)?.class ?? '').trim().slice(0, 40);
        const offer = await subjectOffer(who.year, label);
        return { subjects: offer.subjects.map((s: any) => s.subject) };
    });

    server.post('/api/portal/notices/seen', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const ids = z.object({ ids: z.array(z.coerce.number().int().positive()).max(200) }).parse(req.body).ids;
        await pool.query(
            `UPDATE schedule_notices SET seen_at = coalesce(seen_at, now())
              WHERE id = ANY($1::bigint[]) AND recipient_employee_id = $2`, [ids, who.staff.employeeId]);
        return { ok: true };
    });

    /** A subject teacher's own period: which class, which subject — or nothing. */
    server.put('/api/portal/my-lesson', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const teacherId = who.staff.teacherId;
        if (teacherId == null) return reply.code(403).send({ error: 'Само наставник има свои часови.' });
        const b = MyLessonBody.parse(req.body);
        if (!TEACHING_DAYS.includes(b.day)) return reply.code(400).send({ error: 'Непознат ден.' });
        const subject = cleanText(b.subject);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await lockPeriod(client, who.year.id, b.day, b.ordinal);
            const lessons = await yearLessons(client, who.year.id);
            const classes = await yearClasses(client, who.year.id);
            const cls = b.class ? classes.find((c) => c.label === b.class) : null;
            if (b.class && !cls) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'Таа паралелка не е на листата за годинава.' });
            }
            const clashes = cls ? myLessonClashes(lessons, { teacherId, day: b.day, ordinal: b.ordinal, classLabel: cls.label, subject }) : [];
            if (clashes.length && !b.force) {
                await client.query('ROLLBACK');
                return reply.code(409).send(clashAnswer(clashes, b.day, b.ordinal));
            }
            const written = await putTeacherLesson(client,
                { yearId: who.year.id, day: b.day, ordinal: b.ordinal, teacherId },
                // The clash was decided above, with the subject taken into
                // account; the writer's own refusal of a taken class is not
                // asked a second time.
                { classId: cls ? cls.id : null, subject, together: true, force: true },
                b.expected === undefined ? undefined : { class: b.expected ? b.expected.class ?? null : null });
            if (!written.ok) {
                await client.query('ROLLBACK');
                return reply.code(409).send(written.code === 'conflict'
                    ? { stale: true, error: 'Во меѓувреме некој го сменил овој час. Неделата е освежена: погледнете и обидете се повторно.' }
                    : { error: 'Во овој час веќе имате повеќе од еден час. Прво испразнете го вишокот.' });
            }
            let notified = 0;
            if (cls && clashes.length) {
                const when = { day: b.day, ordinal: b.ordinal, classLabel: cls.label, subject };
                const recipients = clashes.filter((c) => c.teacherId != null)
                    .map((c) => ({ teacherId: c.teacherId as number, sentence: noticeSentence(who.author.name, c, when) }));
                if (cls.homeroomId != null && cls.homeroomId !== teacherId
                    && !recipients.some((r) => r.teacherId === cls.homeroomId)) {
                    const first = clashes[0];
                    recipients.push({ teacherId: cls.homeroomId, sentence:
                        `${who.author.name} запиша ${subject ? `„${subject}"` : 'час'} во вашата паралелка ${cls.label}, ${b.day}, ${b.ordinal}. час, `
                        + `каде веќе има „${first.subject || 'час'}"${first.teacher ? ` кај ${first.teacher}` : ''}.` });
                }
                notified = await addNotices(client, { yearId: who.year.id, authorEmployeeId: who.author.employeeId,
                    authorName: who.author.name, day: b.day, slot: String(b.ordinal), about: 'class:' + cls.label, recipients });
            }
            notified += await tellIfActing(client, who, { day: b.day, slot: String(b.ordinal), kind: 'lesson',
                about: 'class:' + (cls ? cls.label : ''), what: `${b.day}, ${b.ordinal}. час` + (cls ? ` — ${cls.label}${subject ? ` („${subject}")` : ''}` : ' — испразнет') + '.' });
            await client.query('COMMIT');
            return { ok: true, action: written.action, notified };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    });

    /** A homeroom teacher's class: one period, its subject and its teacher. */
    server.put('/api/portal/class-lesson', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const b = ClassLessonBody.parse(req.body);
        if (!TEACHING_DAYS.includes(b.day)) return reply.code(400).send({ error: 'Непознат ден.' });
        const subject = cleanText(b.subject);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await lockPeriod(client, who.year.id, b.day, b.ordinal);
            const cls = await homeroomClass(client, who, b.class);
            if (!cls) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'Може да се менува само паралелката на која сте раководител.' });
            }
            let teacherName: string | null = null;
            if (b.teacherId != null) {
                const t = (await yearTeachers(client, who.year.id)).find((x) => x.id === b.teacherId);
                if (!t) {
                    await client.query('ROLLBACK');
                    return reply.code(400).send({ error: 'Тој наставник не е на листата за годинава.' });
                }
                teacherName = t.name;
            }
            const lessons = await yearLessons(client, who.year.id);
            const here = lessons.filter((l) => l.day === b.day && l.ordinal === b.ordinal && l.class === cls.label);
            if (here.length > 1) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ cellClash: true, error: 'Во овој час паралелката има повеќе часови. Прво тргнете го вишокот.' });
            }
            const clashes = classLessonClashes(lessons, { meId: who.staff.teacherId as number, day: b.day, ordinal: b.ordinal,
                classLabel: cls.label, subject, teacherId: b.teacherId ?? null });
            if (clashes.length && !b.force) {
                await client.query('ROLLBACK');
                return reply.code(409).send(clashAnswer(clashes, b.day, b.ordinal));
            }
            const written = await putLesson(client, { yearId: who.year.id, day: b.day, ordinal: b.ordinal, classId: cls.id },
                { subject, teacherId: b.teacherId ?? null },
                b.expected === undefined ? undefined
                    : (b.expected ? { subject: b.expected.subject ?? null, teacher: b.expected.teacher ?? null } : null));
            if (!written.ok) {
                await client.query('ROLLBACK');
                return reply.code(409).send(written.code === 'conflict'
                    ? { stale: true, error: 'Во меѓувреме некој го сменил овој час. Неделата е освежена: погледнете и обидете се повторно.' }
                    : { cellClash: true, error: 'Во овој час паралелката има повеќе часови. Прво тргнете го вишокот.' });
            }
            const when = { day: b.day, ordinal: b.ordinal, classLabel: cls.label, subject, teacher: teacherName };
            let notified = clashes.length ? await addNotices(client, { yearId: who.year.id, authorEmployeeId: who.author.employeeId,
                authorName: who.author.name, day: b.day, slot: String(b.ordinal), about: 'class:' + cls.label,
                recipients: clashes.filter((c) => c.teacherId != null)
                    .map((c) => ({ teacherId: c.teacherId as number, sentence: noticeSentence(who.author.name, c, when) })) }) : 0;
            notified += await tellIfActing(client, who, { day: b.day, slot: String(b.ordinal), kind: 'lesson', about: 'class:' + cls.label,
                what: `${cls.label}, ${b.day}, ${b.ordinal}. час` + (subject ? ` („${subject}")` : '') + '.' });
            await client.query('COMMIT');
            return { ok: true, action: written.action, notified };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    });

    /** A homeroom teacher takes one lesson out of their class — how a clash is ended from that side. */
    server.post('/api/portal/class-lesson/remove', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const b = z.object({ lessonId: z.number().int().positive(), force: z.boolean().optional() }).parse(req.body);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `SELECT l.id, l.day, l.ordinal, l.subject, l.teacher_id AS "teacherId", t.name AS teacher, c.label AS class
                   FROM lessons l JOIN school_classes c ON c.id = l.class_id LEFT JOIN teachers t ON t.id = l.teacher_id
                  WHERE l.id = $1 AND l.school_year_id = $2 FOR UPDATE OF l`, [b.lessonId, who.year.id]);
            const lesson = rows[0];
            if (!lesson || !(await homeroomClass(client, who, lesson.class))) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'Може да се менува само паралелката на која сте раководител.' });
            }
            const theirs = lesson.teacherId != null && lesson.teacherId !== who.staff.teacherId;
            if (theirs && !b.force) {
                await client.query('ROLLBACK');
                return reply.code(409).send(clashAnswer([{ teacherId: lesson.teacherId, teacher: lesson.teacher, class: lesson.class,
                    subject: lesson.subject, why: 'lesson-replaced' }], lesson.day, lesson.ordinal));
            }
            await client.query('DELETE FROM lessons WHERE id = $1', [lesson.id]);
            let notified = theirs ? await addNotices(client, { yearId: who.year.id, authorEmployeeId: who.author.employeeId,
                authorName: who.author.name, day: lesson.day, slot: String(lesson.ordinal), about: 'class:' + lesson.class,
                recipients: [{ teacherId: lesson.teacherId, sentence:
                    `${who.author.name} го тргна вашиот час „${lesson.subject || 'час'}" од ${lesson.class}, ${lesson.day}, ${lesson.ordinal}. час.` }] }) : 0;
            notified += await tellIfActing(client, who, { day: lesson.day, slot: String(lesson.ordinal), kind: 'lesson', about: 'class:' + lesson.class,
                what: `од ${lesson.class} е тргнат „${lesson.subject || 'час'}", ${lesson.day}, ${lesson.ordinal}. час.` });
            await client.query('COMMIT');
            return { ok: true, notified };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    });

    // ── step 2: the cabinet ───────────────────────────────────────────────

    /**
     * A therapist's own 40-minute block: one pupil for all of it, or two for
     * its halves — the same writer as Кабинети (`writeBlock`), the same
     * `expected` check and the same caseload rule. A pupil who is with another
     * therapist then is a clash said before saving; „сепак запиши" books them
     * anyway and tells that therapist.
     */
    server.put('/api/portal/term', async (req, reply) => {
        const who = await signed(req, reply);
        if (!who) return;
        const therapistId = who.staff.therapistId;
        if (therapistId == null) return reply.code(403).send({ error: 'Само терапевт има свој кабинет.' });
        const b = TermBody.parse(req.body);
        if (!TEACHING_DAYS.includes(b.day)) return reply.code(400).send({ error: 'Непознат ден.' });
        const result = await writeBlock({
            year: who.year.label, day: b.day, time: b.time, therapistId,
            studentPublicIds: b.pupils, expectedStudentPublicIds: b.expected
        }, { force: Boolean(b.force) });
        if (result.status === 409 && result.body && result.body.doubleBooked) {
            const said = `${b.day}, ${b.time}: „${result.body.studentName || 'ученикот'}" тогаш е кај ${result.body.therapistName} (${result.body.time}).`;
            return reply.code(409).send({ clash: true, error: said,
                clashes: [{ therapist: result.body.therapistName, time: result.body.time, pupil: result.body.studentName }] });
        }
        if (result.status !== 200) return reply.code(result.status).send(termRefusal(result.body));
        let notified = 0;
        for (const f of result.forcedOver || []) {
            notified += await addNotices(pool, {
                yearId: who.year.id, authorEmployeeId: who.author.employeeId, authorName: who.author.name,
                day: b.day, slot: b.time, about: 'pupil:' + f.studentPublicId, kind: 'term',
                recipients: [{ therapistId: f.therapistId, sentence:
                    `${who.author.name} го закажа „${f.studentName}" во ${b.day}, ${b.time}, кога е кај вас (${f.time}). `
                    + 'Договорете се кој ќе го помести терминот.' }]
            });
        }
        notified += await tellIfActing(pool, who, { day: b.day, slot: b.time, kind: 'term', about: 'pupil:' + (b.pupils[0] || ''),
            what: `${b.day}, ${b.time}.` });
        return { ok: true, notified };
    });

    // ── the administrator's side, behind the owner's own sign-in ─────────
    // Deliberately NOT under /api/portal/: the cloud gate keeps these for the
    // owner, and on a local server the colleague boundary does.

    /** Every colleague who can sign in this year, and the state of the account. */
    server.get('/api/staff-accounts', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'сметките на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const staff = await staffOfYear(pool, year.id);
        const accounts = new Map((await pool.query(
            `SELECT employee_id, password_hash IS NOT NULL AS own, changed_at, reset_at, last_login_at FROM staff_accounts`
        )).rows.map((r: any) => [r.employee_id, r]));
        // A username that fits two people signs neither in; say which.
        const holders = new Map<string, number>();
        staff.forEach((s) => nameKeys(s.name).strict.forEach((k) => holders.set(k, (holders.get(k) || 0) + 1)));
        return {
            year: year.label,
            accounts: staff.map((s) => {
                const a: any = accounts.get(s.employeeId) || {};
                return {
                    employeeId: s.employeeId,
                    name: s.name,
                    usernames: usernamesOf(s.name),
                    teacher: s.teacherId != null,
                    therapist: s.therapistId != null,
                    ownPassword: Boolean(a.own),
                    changedAt: a.changed_at || null,
                    resetAt: a.reset_at || null,
                    lastLoginAt: a.last_login_at || null,
                    ambiguous: nameKeys(s.name).strict.some((k) => (holders.get(k) || 0) > 1)
                };
            })
        };
    });

    /** „Отвори го формуларот на…": a two-hour look at a colleague's own form, for the owner only. */
    server.post('/api/staff-accounts/:employeeId/open', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'формуларите на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const employeeId = Number((req.params as any).employeeId);
        if (!Number.isInteger(employeeId) || employeeId <= 0) return reply.code(400).send({ error: 'bad employee id' });
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const staff = (await staffOfYear(pool, year.id)).find((s) => s.employeeId === employeeId);
        if (!staff) return reply.code(404).send({ error: 'Тој колега не е на списокот за годинава.' });
        for (const [key, entry] of acting) if (entry.until <= Date.now()) acting.delete(key);
        const token = randomBytes(32).toString('hex');
        acting.set(hashToken(token), { employeeId, until: Date.now() + ACTING_HOURS * 3600 * 1000 });
        // In the fragment, so it is never sent to a server or kept in a log.
        return { url: '/Kolega.html#as=' + token, name: staff.name, hours: ACTING_HOURS };
    });

    /** Every notice of the year, and every clash standing now — the owner's overview. */
    server.get('/api/staff-notices', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'известувањата на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const year = await currentYear();
        if (!year) return reply.code(503).send({ error: 'Нема тековна учебна година.' });
        const lessons = await yearLessons(pool, year.id);
        const { rows } = await pool.query(
            `SELECT n.id, n.created_at AS "createdAt", n.author_name AS author, n.kind, n.day, n.slot, n.about, n.sentence,
                    n.seen_at IS NOT NULL AS seen, e.name AS recipient,
                    (SELECT t.id FROM teachers t WHERE t.employee_id = n.recipient_employee_id) AS "recipientTeacherId"
               FROM schedule_notices n JOIN employees e ON e.id = n.recipient_employee_id
              WHERE n.school_year_id = $1 AND n.closed_at IS NULL
              ORDER BY n.created_at DESC LIMIT 500`, [year.id]);
        const notices = [];
        for (const n of rows) notices.push({ ...n, id: Number(n.id), open: await noticeOpen(n, lessons, n.recipientTeacherId, year.id) });

        // The teaching timetable: two subjects in one class and period, or one teacher in two classes.
        const byCell = new Map<string, WeekLesson[]>();
        const byTeacher = new Map<string, WeekLesson[]>();
        for (const l of lessons) {
            const cell = `${l.day}|${l.ordinal}|${l.class}`;
            if (!byCell.has(cell)) byCell.set(cell, []);
            byCell.get(cell)!.push(l);
            if (l.teacherId != null) {
                const key = `${l.day}|${l.ordinal}|${l.teacherId}`;
                if (!byTeacher.has(key)) byTeacher.set(key, []);
                byTeacher.get(key)!.push(l);
            }
        }
        const teaching: any[] = [];
        for (const list of byCell.values()) {
            const named = list.filter((l) => l.teacherId != null);
            if (named.length > 1 && new Set(named.map((l) => String(l.subject || '').toLocaleLowerCase('mk-MK'))).size > 1) {
                teaching.push({ day: list[0].day, ordinal: list[0].ordinal, class: list[0].class,
                    who: named.map((l) => `${l.teacher} („${l.subject || 'час'}")`) });
            }
        }
        for (const list of byTeacher.values()) {
            if (list.length > 1) teaching.push({ day: list[0].day, ordinal: list[0].ordinal, class: list.map((l) => l.class).join(' + '),
                who: [`${list[0].teacher} во ${list.length} паралелки`] });
        }

        // The cabinets: one pupil with two therapists at overlapping times.
        const pairs = (await pool.query(
            `SELECT a.day, a.time_slot AS a_time, b.time_slot AS b_time, s.name AS pupil,
                    ta.name AS a_therapist, tb.name AS b_therapist
               FROM schedule_slots a
               JOIN schedule_slots b ON b.school_year_id = a.school_year_id AND b.day = a.day
                                    AND b.student_id = a.student_id AND b.therapist_id > a.therapist_id
               JOIN students s ON s.id = a.student_id
               JOIN therapists ta ON ta.id = a.therapist_id
               JOIN therapists tb ON tb.id = b.therapist_id
              WHERE a.school_year_id = $1`, [year.id])).rows;
        const span = (range: string) => { const [f, t] = String(range).split('-'); return [minutesOf(f), minutesOf(t)]; };
        const cabinet = pairs.filter((r: any) => {
            const [af, at] = span(r.a_time);
            const [bf, bt] = span(r.b_time);
            return af < bt && bf < at;
        }).map((r: any) => ({ day: r.day, pupil: r.pupil, who: [`${r.a_therapist} (${r.a_time})`, `${r.b_therapist} (${r.b_time})`] }));

        return { year: year.label, notices, teaching, cabinet };
    });

    /** Back on the initial password, every sign-in ended. */
    server.post('/api/staff-accounts/:employeeId/reset', async (req, reply) => {
        try { assertOwner(await scopeOf(req), 'сметките на колегите'); }
        catch (err) { return refuseScope(reply, err); }
        const employeeId = Number((req.params as any).employeeId);
        if (!Number.isInteger(employeeId) || employeeId <= 0) return reply.code(400).send({ error: 'bad employee id' });
        const known = await pool.query('SELECT 1 FROM employees WHERE id = $1', [employeeId]);
        if (!known.rows.length) return reply.code(404).send({ error: 'no such employee' });
        await resetAccount(pool, employeeId);
        return { ok: true };
    });
}
