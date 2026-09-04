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
 *   read   — everything. A conflict is by definition two therapists holding the
 *            same child in the same term, so a colleague who cannot see the
 *            other cabinet cannot resolve the conflict the screen is showing
 *            them. Hiding the other half would make the red cell unactionable.
 *   write  — only rows that are theirs: their own caseload (therapist_students),
 *            their own terms (schedule_slots), their own sheets.
 *   never  — the roster itself (who exists at this school) and the catalogue
 *            (what the printed form asks). One colleague editing an indicator
 *            reshapes the form for all ten, and that is the owner's decision.
 *
 * WHO IS THE OWNER. MTB_ADMIN names them, comma separated, matched the way
 * every other name in this server is matched: lower(btrim(name)). It lives in
 * `.env` rather than a column because it is a fact about this deployment, not
 * about the person — the same database restored on a colleague's machine for a
 * test should not carry someone else's rights into it.
 */

import type { FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { Refused, whoIsSigned, type Signed } from './evidence.js';

export type Scope =
    /** Enforcement off: the server behaves as it always has. */
    | { open: true; signed: Signed | null }
    /** Enforcement on: somebody is signed in and these are their rights. */
    | { open: false; signed: Signed; admin: boolean };

export function enforcing(): boolean {
    return process.env.MTB_REQUIRE_SIGNIN === '1';
}

const norm = (value: string) => value.trim().toLowerCase();

function admins(): Set<string> {
    return new Set(
        (process.env.MTB_ADMIN || '').split(',').map(norm).filter(Boolean)
    );
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
    const signed = await whoIsSigned(token);
    return { open: false, signed, admin: admins().has(norm(signed.name)) };
}

/**
 * The scope that actually has to be checked: enforcement on, and not the owner.
 *
 * Written as a type predicate rather than the more obvious `unrestricted()`
 * so that every guard below reads `scope.signed` without a non-null assertion.
 * The compiler then holds the invariant instead of a comment promising it.
 */
function restricted(scope: Scope): scope is { open: false; signed: Signed; admin: boolean } {
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
 * Is this child on the signer's own caseload this year?
 *
 * The caseload is `therapist_students`, which migration 019 made year-scoped --
 * so a colleague who dropped a child in September cannot still write last
 * year's sheet for them, and one who never held them cannot start.
 */
export async function assertOwnStudent(
    scope: Scope, studentId: number, schoolYearId: number
): Promise<void> {
    if (!restricted(scope)) return;
    if (scope.signed.therapistId == null) {
        throw new Refused(403, 'наставник нема свој список на ученици', { notATherapist: true });
    }
    const { rows } = await pool.query(
        `SELECT 1 FROM therapist_students
         WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
        [schoolYearId, scope.signed.therapistId, studentId]
    );
    if (!rows.length) {
        throw new Refused(403, 'тој ученик не е во вашиот список за оваа учебна година', { notYours: true });
    }
}

/** Only the sheets of children on the signer's caseload, for list endpoints. */
export async function ownStudentIds(
    scope: Scope, schoolYearId: number
): Promise<number[] | null> {
    if (!restricted(scope)) return null; // null means "no filter"
    if (scope.signed.therapistId == null) return [];
    const { rows } = await pool.query(
        `SELECT student_id FROM therapist_students
         WHERE school_year_id = $1 AND therapist_id = $2`,
        [schoolYearId, scope.signed.therapistId]
    );
    return rows.map((r) => r.student_id as number);
}

/** The name a write should be attributed to, when one is signed in. */
export function signerName(scope: Scope): string | null {
    return scope.signed?.name ?? null;
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
