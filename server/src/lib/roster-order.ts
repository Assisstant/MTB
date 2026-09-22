import type { Pool } from 'pg';

/**
 * The order a person arranged one year's four lists in (migration 038).
 *
 * ONE OWNER, SEVERAL READERS. `Podatoci.html` has the arrows; `/api/roster`
 * is the only place the arrangement is applied, so the workspace, Fusion's
 * therapist columns and S-Dnevnik all read the same list in the same order.
 * A second screen sorting the same rows its own way is the failure this
 * project keeps paying for.
 *
 * HOW EACH LIST NAMES ITS MEMBERS: a pupil by `students.public_id`, the other
 * three by their numeric id — which is what `/api/roster` already hands the
 * screen, so nothing here has to resolve a name.
 */
export const ORDER_LISTS = ['students', 'teachers', 'therapists', 'classes'] as const;
export type OrderList = typeof ORDER_LISTS[number];
export type Arrangement = Map<OrderList, Map<string, number>>;

/**
 * Is the arrangement storable on THIS installation?
 *
 * An installation deliberately lagging the code (see docs/WORKSPACE-RELEASE.md
 * — the local database is held at an older migration on purpose) has no such
 * table. The lists must still draw: "not arranged" is a state the reader
 * already handles, and failing the roster would take down the screen people
 * use daily for a feature nobody had used yet. `to_regclass` asks about the
 * object the query will actually resolve, not about the name anywhere in the
 * cluster.
 */
export async function arrangementAvailable(pool: Pool): Promise<boolean> {
    const { rows } = await pool.query("SELECT to_regclass('roster_order') AS present");
    return rows[0]?.present != null;
}

export async function readArrangement(pool: Pool, yearId: number): Promise<Arrangement> {
    const empty: Arrangement = new Map(ORDER_LISTS.map((list) => [list, new Map<string, number>()]));
    if (!await arrangementAvailable(pool)) return empty;
    const { rows } = await pool.query(
        'SELECT list, member_key, position FROM roster_order WHERE school_year_id = $1', [yearId]
    );
    for (const row of rows) empty.get(row.list as OrderList)?.set(String(row.member_key), Number(row.position));
    return empty;
}

/**
 * Apply it, without throwing away the reader's own order.
 *
 * The sort is STABLE (ES2019), and that is the whole trick: rows nobody has
 * placed keep the order the query gave them — by class then name for pupils,
 * by name for staff, by sort key for classes — and land after the placed ones,
 * because absent means "not arranged yet" rather than "first".
 */
export function arrange<T>(rows: T[], keyOf: (row: T) => string, positions?: Map<string, number>): T[] {
    if (!positions?.size) return rows;
    const at = (row: T) => positions.get(keyOf(row)) ?? Number.MAX_SAFE_INTEGER;
    return rows.slice().sort((a, b) => at(a) - at(b));
}
