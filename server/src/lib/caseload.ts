/**
 * "This therapist works with this child this year" — one link, added or
 * taken away. Two doors write it: Кабинети (roster-write.ts, the owner) and a
 * therapist's own list on the colleagues' page (portal.ts). The rules live
 * here once so the two cannot drift.
 */

export type LinkResult =
    | { ok: true }
    | { ok: false; status: number; error: string; archived?: boolean };

export async function setCaseloadLink(
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
        await db.query(
            `DELETE FROM therapist_students
             WHERE school_year_id = $1 AND therapist_id = $2 AND student_id = $3`,
            [yearId, therapistId, st.rows[0].id]
        );
    }
    return { ok: true };
}
