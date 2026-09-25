/**
 * A colleague's account: the username is their own name, the password starts
 * shared (docs/PLAN-kolegi-online.md; owner, 25 Sep 2026).
 *
 * THE USERNAME IS NOT STORED. It is read from `employees.name` every time, in
 * the two scripts people type it in: `БлагојНасев` and `BlagojNasev` reach the
 * same account, as does `blagojnasev`. Storing it would be a second copy of
 * the name, and the copy would be the one that is wrong after a rename.
 *
 * NEVER A GUESS BETWEEN TWO PEOPLE (rule 2). A username that fits two
 * employees signs nobody in; the administrator sees why. The looser Latin
 * spellings (`Cavdarovski` for Чавдаровски) are accepted only when they fit
 * exactly one person and nothing fits more precisely.
 *
 * THE INITIAL PASSWORD is `ResursenCentar`, or `РесурсенЦентар`, in any letter
 * case. It applies while the account has no password of its own. The owner
 * decided that changing it is offered and not required, knowing that the
 * username is only a name and that the app is on the internet.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashPin, pinMatches } from './evidence.js';

type Queryable = Pick<PoolClient, 'query'>;

/** How long a sign-in lasts: a colleague on a phone should not sign in daily. */
export const PORTAL_SESSION_DAYS = 30;
export const PORTAL_TOKEN_HEADER = 'x-mtb-portal-token';
export const MIN_PASSWORD = 4;

const CYR_TO_LAT: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'zh', з: 'z', ѕ: 'dz',
    и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', џ: 'dzh', ш: 'sh',
    // Serbian and Russian letters that turn up in names written elsewhere.
    ђ: 'gj', ћ: 'kj', й: 'j', ы: 'i', э: 'e', ю: 'ju', я: 'ja', ё: 'e', щ: 'sh', ъ: '', ь: ''
};

/** Latin letters with marks, as a phone keyboard or a Croatian habit types them. */
const MARKED: Record<string, string> = {
    č: 'ch', ć: 'kj', š: 'sh', ž: 'zh', đ: 'gj', ǵ: 'gj', ḱ: 'kj', ǆ: 'dzh'
};

const letters = (value: string) => String(value || '').toLocaleLowerCase('mk-MK').replace(/[^\p{L}]/gu, '');

/** The name as it is typed with no spaces, in Cyrillic: `благојнасев`. */
export function cyrillicKey(name: string): string {
    return letters(name);
}

/** The same in Latin: `blagojnasev`. Latin input passes through, marks spelled out. */
export function latinKey(name: string): string {
    return Array.from(letters(name).replace(/dž/g, 'dzh'))
        .map((ch) => CYR_TO_LAT[ch] ?? MARKED[ch] ?? ch).join('');
}

/**
 * The spelling people actually use when they leave the digraphs out:
 * `cavdarovski`, `gjorgjievska` → `gorgievska`. Only ever a second chance.
 */
export function looseKey(name: string): string {
    return latinKey(name)
        .replace(/dzh/g, 'dz').replace(/ch|kj/g, 'c').replace(/sh/g, 's').replace(/zh/g, 'z')
        .replace(/gj/g, 'g').replace(/lj/g, 'l').replace(/nj/g, 'n').replace(/ts/g, 'c')
        .replace(/y/g, 'j').replace(/w/g, 'v').replace(/x/g, 'ks')
        .replace(/(.)\1+/g, '$1');
}

/** Every way this person's name may be typed as a username, strict first. */
export function nameKeys(name: string): { strict: string[]; loose: string[] } {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const orders = [words.join(' ')];
    // „Насев Благој" is how a list sorted by surname writes it.
    if (words.length > 1) orders.push([...words.slice(1), words[0]].join(' '));
    const strict = new Set<string>();
    const loose = new Set<string>();
    for (const order of orders) {
        strict.add(cyrillicKey(order));
        strict.add(latinKey(order));
        loose.add(looseKey(order));
    }
    strict.delete('');
    loose.delete('');
    return { strict: [...strict], loose: [...loose] };
}

/** What was typed, in the same keys. */
export function typedKeys(username: string): { strict: string[]; loose: string } {
    const cyr = cyrillicKey(username);
    return { strict: [...new Set([cyr, latinKey(username)])].filter(Boolean), loose: looseKey(username) };
}

const INITIAL = new Set(['resursencentar', 'ресурсенцентар']);

/** The shared initial password, in either script and any letter case. */
export function isInitialPassword(password: string): boolean {
    return INITIAL.has(String(password || '').toLocaleLowerCase('mk-MK').replace(/\s+/g, ''));
}

export type Staff = {
    employeeId: number;
    name: string;
    teacherId: number | null;
    therapistId: number | null;
};

/**
 * The employees who can sign in this year: somebody on this year's teacher or
 * therapist list. One who is on no list has no week to fill in.
 */
export async function staffOfYear(db: Queryable, schoolYearId: number): Promise<Staff[]> {
    const { rows } = await db.query(
        `SELECT e.id AS employee_id, e.name,
                (SELECT t.id FROM teachers t JOIN teacher_years ty ON ty.teacher_id = t.id
                  WHERE t.employee_id = e.id AND ty.school_year_id = $1 AND ty.active) AS teacher_id,
                (SELECT t.id FROM therapists t JOIN therapist_years ty ON ty.therapist_id = t.id
                  WHERE t.employee_id = e.id AND ty.school_year_id = $1 AND ty.active) AS therapist_id
           FROM employees e
          WHERE e.superseded_by IS NULL
          ORDER BY e.name`, [schoolYearId]);
    return rows
        .filter((r: any) => r.teacher_id != null || r.therapist_id != null)
        .map((r: any) => ({ employeeId: r.employee_id, name: r.name, teacherId: r.teacher_id, therapistId: r.therapist_id }));
}

export type Resolved =
    | { ok: true; staff: Staff }
    | { ok: false; reason: 'unknown' | 'ambiguous'; names?: string[] };

/** Which colleague a typed username means — one, or nobody. */
export function resolveUsername(staff: Staff[], username: string): Resolved {
    const typed = typedKeys(username);
    if (!typed.strict.length) return { ok: false, reason: 'unknown' };
    const strict = staff.filter((s) => nameKeys(s.name).strict.some((k) => typed.strict.includes(k)));
    if (strict.length === 1) return { ok: true, staff: strict[0] };
    if (strict.length > 1) return { ok: false, reason: 'ambiguous', names: strict.map((s) => s.name) };
    const loose = staff.filter((s) => nameKeys(s.name).loose.includes(typed.loose));
    if (loose.length === 1) return { ok: true, staff: loose[0] };
    if (loose.length > 1) return { ok: false, reason: 'ambiguous', names: loose.map((s) => s.name) };
    return { ok: false, reason: 'unknown' };
}

/** The username to hand out: the name with no spaces, in both scripts. */
export function usernamesOf(name: string): { latin: string; cyrillic: string } {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const cap = (w: string) => w.charAt(0).toLocaleUpperCase('mk-MK') + w.slice(1).toLocaleLowerCase('mk-MK');
    const cyrillic = words.map((w) => cap(w.replace(/[^\p{L}]/gu, ''))).join('');
    const latin = words.map((w) => {
        const lat = latinKey(w);
        return lat.charAt(0).toUpperCase() + lat.slice(1);
    }).join('');
    return { latin, cyrillic };
}

// ── passwords and sessions ─────────────────────────────────────────────────

export async function passwordMatches(db: Queryable, employeeId: number, password: string): Promise<{ ok: boolean; initial: boolean }> {
    const { rows } = await db.query(
        'SELECT password_salt, password_hash FROM staff_accounts WHERE employee_id = $1', [employeeId]);
    const own = rows[0] && rows[0].password_hash;
    if (!own) return { ok: isInitialPassword(password), initial: true };
    return { ok: await pinMatches(String(password || ''), rows[0].password_salt, rows[0].password_hash), initial: false };
}

export async function setPassword(db: Queryable, employeeId: number, password: string): Promise<void> {
    const { salt, hash } = await hashPin(password);
    await db.query(
        `INSERT INTO staff_accounts (employee_id, password_salt, password_hash, changed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (employee_id) DO UPDATE
            SET password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash, changed_at = now()`,
        [employeeId, salt, hash]);
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export async function openSession(db: Queryable, employeeId: number): Promise<{ token: string; expiresAt: string }> {
    await db.query('DELETE FROM staff_sessions WHERE expires_at < now()');
    const token = randomBytes(32).toString('hex');
    const { rows } = await db.query(
        `INSERT INTO staff_sessions (token_hash, employee_id, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3::int)) RETURNING expires_at`,
        [tokenHash(token), employeeId, PORTAL_SESSION_DAYS]);
    await db.query(
        `INSERT INTO staff_accounts (employee_id, last_login_at) VALUES ($1, now())
         ON CONFLICT (employee_id) DO UPDATE SET last_login_at = now()`, [employeeId]);
    return { token, expiresAt: rows[0].expires_at };
}

/** The employee a portal token belongs to, or null. */
export async function sessionEmployee(db: Queryable, token: unknown): Promise<number | null> {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!/^[0-9a-f]{64}$/.test(value)) return null;
    const { rows } = await db.query(
        'SELECT employee_id FROM staff_sessions WHERE token_hash = $1 AND expires_at > now()', [tokenHash(value)]);
    return rows.length ? rows[0].employee_id : null;
}

export async function closeSession(db: Queryable, token: unknown): Promise<void> {
    const value = typeof token === 'string' ? token.trim() : '';
    if (value) await db.query('DELETE FROM staff_sessions WHERE token_hash = $1', [tokenHash(value)]);
}

/** Every other sign-in of this person ends: a new password means the old one is out. */
export async function closeOtherSessions(db: Queryable, employeeId: number, keepToken: unknown): Promise<void> {
    const keep = typeof keepToken === 'string' ? tokenHash(keepToken.trim()) : '';
    await db.query('DELETE FROM staff_sessions WHERE employee_id = $1 AND token_hash <> $2', [employeeId, keep]);
}

/** The administrator puts an account back on the initial password. */
export async function resetAccount(db: Queryable, employeeId: number): Promise<void> {
    await db.query(
        `INSERT INTO staff_accounts (employee_id, reset_at) VALUES ($1, now())
         ON CONFLICT (employee_id) DO UPDATE
            SET password_salt = NULL, password_hash = NULL, changed_at = NULL, reset_at = now()`, [employeeId]);
    await db.query('DELETE FROM staff_sessions WHERE employee_id = $1', [employeeId]);
}

