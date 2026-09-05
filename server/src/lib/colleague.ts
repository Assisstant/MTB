/**
 * Кој смее што да смени — the one place that answers it.
 *
 * WHY THIS FILE EXISTS. Until now every write endpoint on this server was open,
 * and `evidence-auth.ts` said so out loud: the server listens on localhost and
 * the tailnet, so anyone who could reach the port could reach the tables, and a
 * PIN was an authorship stamp rather than a lock. That was honest while the
 * only person reaching the port was the owner. The moment colleagues get the
 * address it stops being true, and a boundary spelled out in three route files
 * is three boundaries that will eventually disagree. Rule 5 applied to
 * permission: name the owner of the fact before adding it.
 *
 * IT IS OFF UNTIL IT IS TURNED ON. Without MTB_REQUIRE_SIGNIN=1 every helper
 * here answers "allowed" and every endpoint behaves exactly as it does today.
 * That is deliberate and not laziness: the owner's own browser, `sync-peer`,
 * the import scripts and the whole e2e suite all call these endpoints with no
 * token. A guard that broke them the day it landed would be reverted rather
 * than fixed.
 *
 * WHAT A COLLEAGUE MAY DO.
 *
 *   read   — the shared roster, schedule and conflicts stay open: a colleague
 *            who cannot see the other cabinet cannot resolve the red cell.
 *            Evidence-sheet reads are narrower and follow the pupil ownership
 *            rule below.
 *   write  — only rows that are theirs: a therapist's own caseload and terms,
 *            and evidence for pupils in their annual caseload; a teacher's
 *            evidence pupils come from their assigned annual classes.
 *   never  — the roster itself, the prescribed catalogue or unlisted system
 *            settings. Action catalogue content keeps its existing, finer
 *            annual-category-holder ownership.
 *
 * WHO IS THE OWNER. MTB_ADMIN names kind-qualified identities
 * (`therapist:name` or `teacher:name`), comma separated and normalized with
 * lower(btrim(name)). It lives in `.env` because it is a fact about this
 * deployment. A separate random MTB_SERVICE_KEY lets local maintenance scripts
 * cross the write perimeter without placing a human PIN in automation.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { Refused, whoIsSigned, type Signed } from './evidence.js';
import { normalizeClassLabel } from './crossing.js';

type Queryable = Pick<PoolClient, 'query'>;

export type Scope =
    /** Enforcement off: the server behaves as it always has. */
    | { open: true; signed: Signed | null }
    /** Enforcement on: somebody is signed in and these are their rights. */
    | { open: false; signed: Signed; admin: boolean; service: false }
    /** A long random deployment key used only by local maintenance scripts. */
    | { open: false; signed: null; admin: true; service: true };

export function enforcing(): boolean {
    return process.env.MTB_REQUIRE_SIGNIN === '1';
}

const norm = (value: string) => value.trim().toLowerCase();

function admins(): Set<string> {
    return new Set((process.env.MTB_ADMIN || '').split(',').map((raw) => {
        const value = raw.trim();
        const typed = value.match(/^(therapist|teacher)\s*:\s*(.+)$/i);
        // Compatibility with the first branch handover: an unqualified name is
        // a therapist.  Treating the same display name in the teachers table as
        // admin was an account-takeover path, because those are separate people.
        return typed
            ? `${typed[1].toLowerCase()}:${norm(typed[2])}`
            : (value ? `therapist:${norm(value)}` : '');
    }).filter(Boolean));
}

/** Admin identity includes the directory kind; a display name alone is ambiguous. */
export function isAdmin(signed: Signed): boolean {
    return admins().has(`${signed.kind}:${norm(signed.name)}`);
}

function serviceKeyMatches(req: FastifyRequest): boolean {
    const expected = String(process.env.MTB_SERVICE_KEY || '').trim();
    const offered = req.headers['x-mtb-service-key'];
    if (expected.length < 32 || typeof offered !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(offered.trim());
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who is asking, and what may they do.
 *
 * With enforcement off this still reads the token when one is offered, so a
 * write can be attributed to a name even before the boundary is switched on.
 * A bad token in that mode is ignored rather than refused: the caller was not
 * required to send one, so failing on it would be a new way to break a script.
 */
export async function scopeOf(req: FastifyRequest): Promise<Scope> {
    const token = req.headers['x-mtb-evidence-token'];
    if (!enforcing()) {
        try {
            return { open: true, signed: await whoIsSigned(token) };
        } catch {
            return { open: true, signed: null };
        }
    }
    if (serviceKeyMatches(req)) {
        return { open: false, signed: null, admin: true, service: true };
    }
    const signed = await whoIsSigned(token);
    return { open: false, signed, admin: isAdmin(signed), service: false };
}

/**
 * The scope that actually has to be checked: enforcement on, and not the owner.
 *
 * Written as a type predicate rather than the more obvious `unrestricted()`
 * so that every guard below reads `scope.signed` without a non-null assertion.
 * The compiler then holds the invariant instead of a comment promising it.
 */
function restricted(scope: Scope): scope is { open: false; signed: Signed; admin: false; service: false } {
    return !scope.open && !scope.admin;
}

/**
 * The roster and the catalogue: the owner's alone.
 *
 * `what` is named in the refusal because "403" on a page with four save
 * buttons tells the colleague nothing about which one to stop pressing.
 */
export function assertOwner(scope: Scope, what: string): void {
    if (!restricted(scope)) return;
    throw new Refused(403, `само администраторот може да менува ${what}`, { needsAdmin: true });
}

/**
 * These terms, this caseload -- are they the signer's own?
 *
 * A teacher signed in through the same PIN box has `therapistId: null`; they
 * hold evidence sections, never a cabinet timetable, so they are refused here
 * rather than silently matching nobody.
 */
export function assertOwnTherapistId(scope: Scope, therapistId: number): void {
    if (!restricted(scope)) return;
    if (scope.signed.therapistId == null) {
        throw new Refused(403, 'наставник нема свој распоред во кабинет', { notATherapist: true });
    }
    if (scope.signed.therapistId !== therapistId) {
        throw new Refused(403, 'може да се менува само сопствениот распоред', { notYours: true });
    }
}

/**
 * The same question asked by name, because a therapist has no stable id in the
 * roster endpoints -- `roster-write.ts` explains why the name IS the key there.
 * Resolved through the database rather than by comparing strings, so the two
 * spellings of one person that `lower(btrim(...))` already unifies stay unified.
 */
export async function assertOwnTherapistName(scope: Scope, name: string): Promise<void> {
    if (!restricted(scope)) return;
    const { rows } = await pool.query(
        'SELECT id FROM therapists WHERE lower(btrim(name)) = $1', [norm(name)]
    );
    if (!rows.length) throw new Refused(404, `unknown therapist "${name}"`);
    assertOwnTherapistId(scope, rows[0].id);
}

/**
 * Is this child in the signer's own pupil set this year?
 *
 * A therapist's set is `therapist_students`, which migration 019 made
 * year-scoped. A teacher's set is derived from their annual `teacher_classes`
 * and the pupils' annual enrolment grades; there is deliberately no second
 * teacher↔student list.
 */
export async function assertOwnStudent(
    scope: Scope, studentId: number, schoolYearId: number, db: Queryable = pool
): Promise<void> {
    if (!restricted(scope)) return;
    const mine = await ownStudentIds(scope, schoolYearId, db);
    if (!mine?.includes(studentId)) {
        throw new Refused(403, 'тој ученик не е во вашиот список за оваа учебна година', { notYours: true });
    }
}

/** Pupil ids owned through annual caseload or assigned class; null means unfiltered. */
export async function ownStudentIds(
    scope: Scope, schoolYearId: number, db: Queryable = pool
): Promise<number[] | null> {
    if (!restricted(scope)) return null; // null means "no filter"
    if (scope.signed.kind === 'therapist') {
        const { rows } = await db.query(
            `SELECT ts.student_id FROM therapist_students ts
             JOIN therapist_years ty
               ON ty.school_year_id = ts.school_year_id AND ty.therapist_id = ts.therapist_id
             WHERE ts.school_year_id = $1 AND ts.therapist_id = $2 AND ty.active`,
            [schoolYearId, scope.signed.personId]
        );
        return rows.map((r) => r.student_id as number);
    }

    // A teacher's pupils are owned by the existing annual class assignment,
    // not by inventing a second teacher↔student list.  Class labels have several
    // spellings in imported workbooks, so compare with the same normalizer used
    // by the teaching and action-plan derivation code.
    // Keep these sequential: `db` may be one transaction's PoolClient, where
    // parallel queries would share a single connection and obscure which one
    // failed.  Empty labels confer no ownership.
    const classes = await db.query(
        `SELECT sc.label FROM teacher_classes tc
         JOIN teacher_years ty
           ON ty.school_year_id = tc.school_year_id AND ty.teacher_id = tc.teacher_id
         JOIN school_classes sc ON sc.id = tc.class_id
         WHERE tc.school_year_id = $1 AND tc.teacher_id = $2 AND ty.active`,
        [schoolYearId, scope.signed.personId]
    );
    const pupils = await db.query(
        `SELECT student_id, grade FROM student_enrollments
         WHERE school_year_id = $1 AND active`, [schoolYearId]);
    const classKeys = new Set(classes.rows
        .map((r) => normalizeClassLabel(r.label || ''))
        .filter(Boolean));
    return pupils.rows
        .filter((r) => {
            const key = normalizeClassLabel(r.grade || '');
            return Boolean(key) && classKeys.has(key);
        })
        .map((r) => r.student_id as number);
}

/** Resolve a sheet to its pupil and year, then apply the same ownership rule. */
export async function assertOwnSheet(
    scope: Scope, sheetId: number, db: Queryable = pool
): Promise<{ studentId: number; schoolYearId: number }> {
    const { rows } = await db.query(
        `SELECT student_id, school_year_id FROM evidence_sheets WHERE id = $1`, [sheetId]);
    if (!rows.length) throw new Refused(404, `no evidence sheet with id ${sheetId}`);
    const target = {
        studentId: rows[0].student_id as number,
        schoolYearId: rows[0].school_year_id as number
    };
    await assertOwnStudent(scope, target.studentId, target.schoolYearId, db);
    return target;
}

/** The name a write should be attributed to, when one is signed in. */
export function signerName(scope: Scope): string | null {
    return scope.signed?.name ?? null;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_WRITES = new Set([
    'POST /api/evidence/login',
    'POST /api/evidence/logout',
    // The route itself applies the stricter first-PIN/admin rule because it
    // needs to know whether a login row already exists.
    'POST /api/evidence/pin'
]);
const DELEGATED_WRITES = new Set([
    'PUT /api/therapists/:name/students/:publicId',
    'DELETE /api/therapists/:name/students/:publicId',
    'PUT /api/schedule/block',
    'PUT /api/schedule/session',
    'POST /api/evidence/sheet',
    'PATCH /api/evidence/sheet/:id',
    'DELETE /api/evidence/sheet/:id',
    'PUT /api/evidence/score',
    'PUT /api/evidence/panel',
    'PUT /api/evidence/examiner',
    'PUT /api/evidence/contacts',
    'PUT /api/evidence/sheet-section',
    'POST /api/evidence/item',
    'PATCH /api/evidence/item/:id',
    'DELETE /api/evidence/item/:id',
    'POST /api/evidence/section',
    'PATCH /api/evidence/section/:id',
    'DELETE /api/evidence/section/:id',
    'POST /api/evidence/group',
    'DELETE /api/evidence/group/:id'
]);

/**
 * Default-deny perimeter for every mutating API route.
 *
 * A route omitted from the small delegated list is owner-only automatically.
 * That is what closes future endpoints as well as today's state/category/
 * teaching/purge bypasses.  Delegated handlers still apply their finer own-row
 * or category guard; this hook first proves that the caller is signed in.
 */
export function installColleagueBoundary(server: FastifyInstance): void {
    server.addHook('onRequest', async (req, reply) => {
        if (!enforcing() || !WRITE_METHODS.has(req.method)) return;
        const route = req.routeOptions.url;
        const key = `${req.method} ${route}`;
        if (PUBLIC_WRITES.has(key)) return;
        try {
            const scope = await scopeOf(req);
            if (DELEGATED_WRITES.has(key)) return;
            assertOwner(scope, 'оваа системска поставка');
        } catch (err) {
            return refuseScope(reply, err);
        }
    });
}

/**
 * Turn a Refused into its own status code.
 *
 * The same three lines `evidence-auth.ts` already carries, exported once so a
 * guard added to a route file that had no error handling does not grow a
 * fourth copy that answers 500 where the others answer 403.
 */
export function refuseScope(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message, ...err.payload });
    throw err;
}
