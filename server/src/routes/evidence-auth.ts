import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import { hashPin, pinMatches, Refused, SESSION_HOURS, sweepSessions, whoIsSigned } from '../lib/evidence.js';

/**
 * Signing in to Евидентен лист.
 *
 * WHAT THIS IS, PLAINLY. It is a staff-room lock and an authorship stamp, not
 * security. Every other endpoint on this server is unauthenticated, the server
 * listens on localhost and the tailnet, and anyone who can reach the port can
 * read the same tables directly. What a PIN buys is the thing the paper form
 * asks for and localStorage could never give: each section of a child's record
 * says which specialist wrote it, and a shared browser in a shared room does
 * not hand the psychologist's screen to whoever sits down next.
 *
 * Claiming otherwise would be worse than having nothing, because somebody would
 * then put something here they would not have put in an open table.
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

const LoginBody = z.object({ ...PersonRef, pin: z.string().min(4).max(64) });

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
    pin: z.string().min(4).max(64),
    currentPin: z.string().max(64).optional()
});

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
     * First one wins, and that is stated rather than hidden: on a centre's own
     * network the first person to claim a name is the person whose name it is.
     * Changing it afterwards needs either the old PIN or a live session, so a
     * colleague cannot lock somebody out of their own record.
     */
    server.post('/api/evidence/pin', async (req, reply) => {
        const body = PinBody.parse(req.body);
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
            if (body.currentPin) {
                allowed = await pinMatches(body.currentPin, existing[0].pin_salt, existing[0].pin_hash);
            }
            if (!allowed) {
                try {
                    const signed = await whoIsSigned(req.headers['x-mtb-evidence-token']);
                    allowed = signed.kind === ref.kind && signed.personId === ref.id;
                } catch { /* no session; the old PIN was the only other way */ }
            }
            if (!allowed) {
                return reply.code(403).send({
                    error: 'that name already has a PIN -- give the current one, or sign in first',
                    needsCurrentPin: true
                });
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
        return {
            ok: true,
            person: { kind: person.kind, id: person.id, name: person.name },
            // Kept so the old apps and suites still read a therapist back.
            therapist: { id: person.id, name: person.name },
            created: !existing.length
        };
    });

    server.post('/api/evidence/login', async (req, reply) => {
        const body = LoginBody.parse(req.body);
        const ref = whichPerson(body);
        if (!ref) return reply.code(400).send({ error: 'name the person: kind + personId' });
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
            return reply.code(401).send({ error: 'wrong PIN' });
        }

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
                therapist: { id: signed.personId, name: signed.name }
            };
        } catch (err) {
            return refuse(reply, err);
        }
    });
}
