/**
 * The record of what colleagues change in their own cabinets (060; owner,
 * 13 Oct 2026). One row per block that actually changed, written in the same
 * transaction as the block, so the log cannot say something the timetable
 * does not hold — and a failed write leaves no row.
 */
type Queryable = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };

export const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export type TermChange = {
    yearId: number;
    therapistId: number;
    authorEmployeeId: number | null;
    authorName: string;
    day: string;
    slot: string;
    before: string[];
    after: string[];
    /** The minutes each pupil held, in the order of the ids: a lone legacy half is not the whole bell. */
    beforeTimes: string[];
    afterTimes: string[];
    forced?: boolean;
    undoOf?: number | null;
};

/**
 * Inside the caller's transaction. A database that has not had 060 yet keeps
 * saving terms exactly as before: the missing table is stepped over behind a
 * savepoint instead of failing the colleague's write.
 */
export async function logTermChange(client: Queryable, change: TermChange): Promise<number | null> {
    // The same pupil for other minutes IS a change: a lone half rewritten as the whole bell.
    if (sameIds(change.before, change.after) && sameIds(change.beforeTimes, change.afterTimes)) return null;
    await client.query('SAVEPOINT portal_change');
    try {
        const { rows } = await client.query(
            `INSERT INTO portal_changes (school_year_id, therapist_id, author_employee_id, author_name, day, slot,
                                         before_ids, after_ids, before_times, after_times, forced, undo_of)
             VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::text[], $10::text[], $11, $12) RETURNING id`,
            [change.yearId, change.therapistId, change.authorEmployeeId, change.authorName, change.day, change.slot,
                change.before, change.after, change.beforeTimes, change.afterTimes, Boolean(change.forced), change.undoOf ?? null]);
        await client.query('RELEASE SAVEPOINT portal_change');
        return Number(rows[0].id);
    } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT portal_change');
        if (err && err.code === '42P01') return null;
        throw err;
    }
}
