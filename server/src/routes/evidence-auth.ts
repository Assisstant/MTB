import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import { hashPin, pinMatches, Refused, SESSION_HOURS, sweepSessions, whoIsSigned } from '../lib/evidence.js';
import { enforcing, isAdmin, scopeOf } from '../lib/colleague.js';

/**
 * Signing in to Евидентен лист.
 *
 * WHAT THIS IS, PLAINLY. It is always an authorship stamp and a shared-room
 * lock. With MTB_REQUIRE_SIGNIN unset it grants no API rights. With the flag at
 * 1, `lib/colleague.ts` also uses the resulting session as an operational write
 * boundary and scopes evidence sheets to an annual caseload/assigned class.
 * Shared schedule, conflict, roster and login-directory reads stay open.
 *
 * It is still not a confidentiality claim: a four-digit PIN is low-entropy,
 * some reads deliberately remain open, and Tailscale remains the reachability
 * boundary. Claiming more would invite data this deployment cannot protect.
 *
 * The identities are the people the database already has -- therapists AND
 * teachers, since migration 024 let either hold a profile and the ownership
 * rule says the section for a profile is written by whoever holds it.
 * Inventing a second directory would be the two-owners failure this project
 * keeps undoing, so both come from their own tables and neither is copied.
 *
 * A caller may still say `therapistId`; it means kind 'therapist'. The old
 * apps and the older suites keep working, which is rule 4 applied to an
 * endpoint instead of a file.
 */

const PersonRef = {
    kind: z.enum(['therapist', 'teacher']).optional(),
    personId: z.number().int().positive().optional(),
    therapistId: z.number().int().positive().optional()
};

const FourDigitPin = z.string().regex(/^\d{4}$/);
const LoginBody = z.object({ ...PersonRef, pin: FourDigitPin });

/** One shape out of either spelling, so no handler has to know about both. */
function whichPerson(body: { kind?: string; personId?: number; therapistId?: number }) {
    if (body.personId && body.kind) {
        return { kind: body.kind as 'therapist' | 'teacher', id: body.personId };
    }
    if (body.therapistId) return { kind: 'therapist' as const, id: body.therapistId };
    if (body.personId) return { kind: 'therapist' as const, id: body.personId };
    return null;
}

const PERSON_TABLE = { therapist: 'therapists', teacher: 'teachers' } as const;
const PERSON_COLUMN = { therapist: 'therapist_id', teacher: 'teacher_id' } as const;

async function findPerson(kind: 'therapist' | 'teacher', id: number) {
    const { rows } = await pool.query(
        `SELECT id, name FROM ${PERSON_TABLE[kind]} WHERE id = $1`, [id]);
    return rows.length ? { kind, id: rows[0].id as number, name: rows[0].name as string } : null;
}

const PinBody = z.object({
    ...PersonRef,
    pin: FourDigitPin,
    currentPin: FourDigitPin.optional()
});

// Four digits are convenient in a shared staff room but only 10,000 possible
// values.  Limit online guesses per person; the Tailscale/LAN boundary remains
// the primary network control.  This intentionally lives in process memory:
// it stores no extra identity data and a server restart is already an owner
// action.  Five failures in one five-minute window are enough to stop scripts
// from walking the whole PIN space.
const PIN_FAILURE_LIMIT = 5;
const PIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const pinFailures = new Map<string, { failures: number; resetAt: number }>();

function pinFailureKey(ref: { kind: 'therapist' | 'teacher'; id: number }): string {
    return `${ref.kind}:${ref.id}`;
}

function pinRetryAfter(ref: { kind: 'therapist' | 'teacher'; id: number }): number {
    const key = pinFailureKey(ref);
    const entry = pinFailures.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.resetAt <= now) {
        pinFailures.delete(key);
        return 0;
    }
    return entry.failures >= PIN_FAILURE_LIMIT
        ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
        : 0;
}

function recordPinFailure(ref: { kind: 'therapist' | 'teacher'; id: number }): number {
    const key = pinFailureKey(ref);
    const now = Date.now();
    const previous = pinFailures.get(key);
    const entry = !previous || previous.resetAt <= now
        ? { failures: 1, resetAt: now + PIN_FAILURE_WINDOW_MS }
        : { failures: previous.failures + 1, resetAt: previous.resetAt };
    pinFailures.set(key, entry);
    return entry.failures >= PIN_FAILURE_LIMIT
        ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
        : 0;
}

function clearPinFailures(ref: { kind: 'therapist' | 'teacher'; id: number }): void {
    pinFailures.delete(pinFailureKey(ref));
}

function invalidPin(reply: FastifyReply) {
    return reply.code(400).send({
        error: 'PIN мора да има точно 4 цифри',
        invalidPin: true
    });
}

function tooManyPins(reply: FastifyReply, retryAfter: number) {
    return reply.header('Retry-After', String(retryAfter)).code(429).send({
        error: 'Премногу погрешни обиди. Почекајте и обидете се повторно.',
        retryAfterSeconds: retryAfter
    });
}

function refuse(reply: FastifyReply, err: unknown) {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message, ...err.payload });
    throw err;
}

export async function evidenceAuthRoutes(server: FastifyInstance) {

    /**
     * Who can sign in.
     *
     * `hasPin` is deliberately public: the login box has to know whether to ask
     * for a PIN or to offer setting one, and the alternative -- discovering it
     * by failing to log in -- tells a stranger exactly the same thing while
     * telling the staff nothing.
     */
    server.get('/api/evidence/therapists', async () => {
        const { rows } = await pool.query(
            `SELECT t.id, t.name, (l.therapist_id IS NOT NULL) AS has_pin
             FROM therapists t
             LEFT JOIN evidence_logins l ON l.therapist_id = t.id
             ORDER BY t.name`
        );
        return { therapists: rows };
    });

    /**
     * Everyone who can sign in — therapists and teachers alike.
     *
     * `/api/evidence/therapists` above is left exactly as it was rather than
     * widened: the old apps and `evidence.e2e.ts` read it, and a response that
     * quietly grew a second kind of person would be a change of shape, not an
     * addition. New callers use this one.
     */
    server.get('/api/evidence/people', async () => {
        const { rows } = await pool.query(
            `SELECT 'therapist' AS kind, t.id, t.name, (l.therapist_id IS NOT NULL) AS has_pin
               FROM therapists t LEFT JOIN evidence_logins l ON l.therapist_id = t.id
             UNION ALL
             SELECT 'teacher', t.id, t.name, (l.teacher_id IS NOT NULL)
               FROM teachers t LEFT JOIN evidence_logins l ON l.teacher_id = t.id
             ORDER BY kind, name`);
        return { people: rows };
    });

    /**
     * Set or change a PIN.
     *
     * Compatibility-open mode keeps the original bootstrap path: the first PIN
     * can be set locally and an existing PIN can be changed by proving the old
     * one or by using a live session.  Once enforcement is enabled, an initial
     * PIN needs the configured administrator/service scope and a person changes
     * their own PIN only from a live session.  That avoids leaving a second PIN
     * guessing endpoint beside login.
     */
    server.post('/api/evidence/pin', async (req, reply) => {
        const parsed = PinBody.safeParse(req.body);
        if (!parsed.success) return invalidPin(reply);
        const body = parsed.data;
        const ref = whichPerson(body);
        if (!ref) return reply.code(400).send({ error: 'name the person: kind + personId' });
        const person = await findPerson(ref.kind, ref.id);
        if (!person) return reply.code(404).send({ error: `no ${ref.kind} with id ${ref.id}` });
        const col = PERSON_COLUMN[ref.kind];

        const { rows: existing } = await pool.query(
            `SELECT pin_salt, pin_hash FROM evidence_logins WHERE ${col} = $1`, [ref.id]
        );
        if (existing.length) {
            let allowed = false;
            try {
                const scope = await scopeOf(req);
                allowed = (!scope.open && scope.admin) || Boolean(scope.signed &&
                    scope.signed.kind === ref.kind && scope.signed.personId === ref.id);
            } catch { /* no valid session */ }

            // Compatibility mode still permits proving the old PIN directly.
            // Once the server is shared, sign in with that PIN first and use
            // the resulting session; otherwise this endpoint is a second,
            // easily overlooked brute-force surface.
            if (!allowed && body.currentPin && !enforcing()) {
                const blocked = pinRetryAfter(ref);
                if (blocked) return tooManyPins(reply, blocked);
                allowed = await pinMatches(body.currentPin, existing[0].pin_salt, existing[0].pin_hash);
                if (!allowed) {
                    const retryAfter = recordPinFailure(ref);
                    if (retryAfter) return tooManyPins(reply, retryAfter);
                } else {
                    clearPinFailures(ref);
                }
            }
            if (!allowed) {
                return reply.code(403).send({
                    error: enforcing()
                        ? 'that name already has a PIN -- sign in first, or ask the administrator'
                        : 'that name already has a PIN -- give the current one, or sign in first',
                    needsCurrentPin: true
                });
            }
        } else if (enforcing()) {
            // Once colleagues can reach the server, "first caller wins" is no
            // longer an identity check.  Initial PINs are provisioned by the
            // configured owner; afterwards the person signs in and changes
            // their own PIN from that live session. Bootstrap the owner's PIN
            // before turning MTB_REQUIRE_SIGNIN on.
            try {
                const scope = await scopeOf(req);
                if (scope.open || !scope.admin) {
                    throw new Refused(403, 'само администраторот поставува прв PIN', { needsAdmin: true });
                }
            } catch (err) {
                return refuse(reply, err instanceof Refused
                    ? err
                    : new Refused(403, 'само администраторот поставува прв PIN', { needsAdmin: true }));
            }
        }

        const { salt, hash } = await hashPin(body.pin);
        // UPDATE then INSERT rather than ON CONFLICT: the uniqueness is now two
        // partial indexes, one per kind, and spelling that out is clearer than
        // inferring a partial index in an upsert.
        const updated = await pool.query(
            `UPDATE evidence_logins SET pin_salt = $2, pin_hash = $3, updated_at = now()
              WHERE ${col} = $1`, [ref.id, salt, hash]);
        if (!updated.rowCount) {
            await pool.query(
                `INSERT INTO evidence_logins (${col}, pin_salt, pin_hash) VALUES ($1, $2, $3)`,
                [ref.id, salt, hash]);
        }
        // Changing a PIN ends the sessions opened with the old one; otherwise
        // "I changed it because somebody knew it" would change nothing.
        await pool.query(`DELETE FROM evidence_sessions WHERE ${col} = $1`, [ref.id]);
        clearPinFailures(ref);
        return {
            ok: true,
            person: { kind: person.kind, id: person.id, name: person.name },
            // Kept so the old apps and suites still read a therapist back.
            therapist: { id: person.id, name: person.name },
            created: !existing.length
        };
    });

    server.post('/api/evidence/login', async (req, reply) => {
        const parsed = LoginBody.safeParse(req.body);
        if (!parsed.success) return invalidPin(reply);
        const body = parsed.data;
        const ref = whichPerson(body);
        if (!ref) return reply.code(400).send({ error: 'name the person: kind + personId' });
        const blocked = pinRetryAfter(ref);
        if (blocked) return tooManyPins(reply, blocked);
        const col = PERSON_COLUMN[ref.kind];
        const { rows } = await pool.query(
            `SELECT p.id, p.name, l.pin_salt, l.pin_hash
             FROM ${PERSON_TABLE[ref.kind]} p
             LEFT JOIN evidence_logins l ON l.${col} = p.id
             WHERE p.id = $1`,
            [ref.id]
        );
        if (!rows.length) return reply.code(404).send({ error: `no ${ref.kind} with id ${ref.id}` });
        if (!rows[0].pin_hash) {
            return reply.code(409).send({
                error: 'that name has no PIN yet -- set one first',
                needsPin: true,
                person: { kind: ref.kind, id: rows[0].id, name: rows[0].name },
                therapist: { id: rows[0].id, name: rows[0].name }
            });
        }
        if (!(await pinMatches(body.pin, rows[0].pin_salt, rows[0].pin_hash))) {
            const retryAfter = recordPinFailure(ref);
            if (retryAfter) return tooManyPins(reply, retryAfter);
            return reply.code(401).send({ error: 'wrong PIN' });
        }

        clearPinFailures(ref);

        await sweepSessions();
        const token = randomBytes(32).toString('hex');
        const { rows: session } = await pool.query(
            `INSERT INTO evidence_sessions (token, ${col}, expires_at)
             VALUES ($1, $2, now() + ($3 || ' hours')::interval)
             RETURNING expires_at`,
            [token, rows[0].id, String(SESSION_HOURS)]
        );
        return {
            token,
            expiresAt: session[0].expires_at,
            person: { kind: ref.kind, id: rows[0].id, name: rows[0].name },
            therapist: { id: rows[0].id, name: rows[0].name }
        };
    });

    server.post('/api/evidence/logout', async (req) => {
        const token = req.headers['x-mtb-evidence-token'];
        if (typeof token === 'string' && token) {
            await pool.query('DELETE FROM evidence_sessions WHERE token = $1', [token]);
        }
        return { ok: true };
    });

    server.get('/api/evidence/me', async (req, reply) => {
        try {
            const signed = await whoIsSigned(req.headers['x-mtb-evidence-token']);
            return {
                person: { kind: signed.kind, id: signed.personId, name: signed.name },
                therapist: { id: signed.personId, name: signed.name },
                permissions: {
                    enforced: enforcing(),
                    admin: !enforcing() || isAdmin(signed)
                }
            };
        } catch (err) {
            return refuse(reply, err);
        }
    });
}
