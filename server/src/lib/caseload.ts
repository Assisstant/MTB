/**
 * "This therapist works with this child this year" — one link, added or
 * taken away. Two doors write it: Кабинети (roster-write.ts, the owner) and a
 * therapist's own list on the colleagues' page (portal.ts). The rules live
 * here once so the two cannot drift.
 *
 * A child who still has a term with this therapist is NOT taken off the list
 * (4 Oct 2026). The pupil form and Администрация (workspace.ts) and Колега
 * already refused it; Кабинети and Податоци did not, and left a booking with
 * no caseload behind — the week went on naming a child who was no longer on
 * the list, and „my pupils" and „my timetable" disagreed. One answer now,
 * from every door: free the term in „Термини", then take the child off.
 */

export type LinkResult =
    | { ok: true }
    | { ok: false; status: number; error: string; archived?: boolean; booked?: string[] };

export async function setCaseloadLink(
    pool: any, yearId: number, therapistId: number, publicId: string, add: boolean
): Promise<LinkResult> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Cabinet block/session writers hold this year's row FOR SHARE until
        // their booking commits. Checking for terms and removing membership
        // must be one transaction, excluding bookings throughout the check.
        await client.query('SELECT id FROM school_years WHERE id = $1 FOR UPDATE', [yearId]);
        const result = await writeCaseloadLink(client, yearId, therapistId, publicId, add);
        await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function writeCaseloadLink(
    db: any, yearId: number, therapistId: number, publicId: string, add: boolean
): Promise<LinkResult> {
    const st = await db.query(
        `SELECT s.id, s.active FROM students s
         JOIN student_enrollments e ON e.student_id = s.id
         WHERE s.public_id = $1 AND e.school_year_id = $2 AND e.active`,
        [publicId, yearId]
    );
    if (!st.rows.length) {
        return { ok: false, status: 404, error: `no active student with id "${publicId}" for that school year` };
    }
    if (add) {
        // Linking an archived child would put them back on a caseload
        // without anyone deciding they had returned.
        if (!st.rows[0].active) {
            return { ok: false, status: 409, error: 'that student is archived in S-Dnevnik', archived: true };
        }
        await db.query(
            `INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [yearId, therapistId, st.rows[0].id]
        );
    } else {
        const booked = (await db.query(
            `SELECT day, time_slot FROM schedule_slots
              WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3
              ORDER BY day_order, time_slot`,
            [yearId, therapistId, st.rows[0].id]
        )).rows.map((r: any) => `${r.day} ${r.time_slot}`);
        if (booked.length) {
            return { ok: false, status: 409, booked,
                error: `Ученикот има термин кај овој терапевт (${booked.join(', ')}). Прво ослободете го терминот во „Термини“, па тргнете го од листата.` };
        }
        await db.query(
            `DELETE FROM therapist_students
             WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
            [yearId, therapistId, st.rows[0].id]
        );
    }
    return { ok: true };
}
