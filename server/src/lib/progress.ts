/**
 * Plan progress, derived from attendance.
 *
 * WHY THERE IS NO PROGRESS ENDPOINT, and why this file exists instead.
 *
 * Progress looks like a collection: `studentProgress[studentId][planId]` is a
 * list of { index, date, time }, it is in the payload, it has its own table.
 * It is not one. In S-Dnevnik every progress checkbox is rendered `disabled` --
 * there is no way to tick an activity by hand, at all. The list is produced by
 * checkNextActivity() when a session is marked present, unpicked by
 * uncheckLastActivity() when that mark is taken back, and the app carries a
 * button (rebuildStudentProgress) whose whole job is to throw the list away and
 * recompute it from attendance. So attendance is the fact; progress is a view
 * of it. CLAUDE.md rule 5: one owner per fact.
 *
 * Giving progress its own write path would create the second owner the rule
 * forbids, and the failure is concrete rather than theoretical. Two machines,
 * neither having seen the other yet: each marks a session, each independently
 * computes "the next unfinished activity is #3", and each writes #3 with its
 * own date. Whichever lands second wins the row, and one session's progress is
 * gone -- with a plausible-looking number left behind, which is worse than an
 * obviously missing one. Deriving from attendance cannot fail that way: both
 * marks are separate rows, so both sessions are counted.
 *
 * DELIBERATE DIFFERENCES from the app's rebuildStudentProgress(), both of them
 * corrections rather than accidents:
 *
 *   1. Scoped to a school year. The app walks EVERY date it holds, which after
 *      the September reset would rebuild last year's progress out of last
 *      year's attendance -- the progress was archived into progressArchive[year]
 *      precisely so that it would not come back. school_year_of() already
 *      exists for this.
 *   2. It refuses rather than clearing when it cannot see enough (below).
 *
 * Everything else follows the app exactly, including the parts that look like
 * quirks, because the therapist's screen is what the numbers have to agree
 * with: only `present` counts, marks with no time are ignored (the old bare
 * "present" string shape, which the app's rebuild also skips because it reads
 * `.status` off a string and gets undefined), sessions are de-duplicated on
 * date + time so a merged term counts once, they are ordered by date then time
 * as strings, and the Nth session completes the Nth activity of the student's
 * CURRENT plan.
 */

export interface DeriveResult {
    /** Activities credited after the run. */
    completed: number;
    /** Sessions found. Equal to `completed` unless the plan ran out of activities. */
    sessions: number;
    /** Set when nothing was written and why. */
    refused?: string;
}

/**
 * Recompute one student's progress for their current plan.
 *
 * Call it inside the caller's transaction, after the attendance write, so a
 * mark and the progress that follows from it commit together or not at all.
 */
export async function deriveProgress(client: any, studentId: number): Promise<DeriveResult> {
    const st = await client.query('SELECT plan_id FROM students WHERE id = $1', [studentId]);
    const planId: number | null = st.rows[0]?.plan_id ?? null;
    if (planId == null) return { completed: 0, sessions: 0, refused: 'the student has no plan' };

    const acts = await client.query(
        'SELECT id, position FROM plan_activities WHERE plan_id = $1 ORDER BY position',
        [planId]
    );
    if (!acts.rows.length) return { completed: 0, sessions: 0, refused: 'the plan has no activities' };

    // The year the derivation covers. Falls back to every date only when no
    // year is marked current, which is a broken installation, not a state to
    // silently produce a different answer in.
    const yr = await client.query('SELECT starts_on, ends_on FROM school_years WHERE is_current');
    const from = yr.rows[0]?.starts_on ?? null;
    const to = yr.rows[0]?.ends_on ?? null;

    // One row per SESSION: a merged term writes the same time against two slot
    // keys, and that is one session, so the distinct pair is the unit.
    const sessions = await client.query(
        `SELECT DISTINCT date, time_slot
           FROM attendance
          WHERE student_id = $1
            AND status = 'present'
            AND time_slot IS NOT NULL
            AND ($2::date IS NULL OR date BETWEEN $2 AND $3)
          ORDER BY date, time_slot`,
        [studentId, from, to]
    );

    // Marks we can see but cannot place. Clearing progress because of them
    // would read as "this child had no sessions", which is a different and
    // much more expensive claim than "I do not know when these were".
    const blind = await client.query(
        `SELECT count(*)::int AS n
           FROM attendance
          WHERE student_id = $1
            AND status = 'present'
            AND time_slot IS NULL
            AND ($2::date IS NULL OR date BETWEEN $2 AND $3)`,
        [studentId, from, to]
    );

    const activityIds: number[] = acts.rows.map((r: any) => r.id);
    const credited = sessions.rows.slice(0, activityIds.length);

    if (blind.rows[0].n > 0) {
        const existing = await client.query(
            `SELECT count(*)::int AS n FROM student_plan_progress
              WHERE student_id = $1 AND activity_id = ANY($2::int[])`,
            [studentId, activityIds]
        );
        if (existing.rows[0].n > credited.length) {
            return {
                completed: existing.rows[0].n,
                sessions: credited.length,
                refused: `${blind.rows[0].n} attendance mark(s) for this student carry no time, so fewer sessions can be seen (${credited.length}) than progress already recorded (${existing.rows[0].n}) -- progress left untouched. Save the diary once so the times are stored.`
            };
        }
    }

    // Replace only this plan's rows. A student who changed plan keeps what the
    // old plan recorded; the app does the same, and losing it would take the
    // history of the work with it.
    await client.query(
        'DELETE FROM student_plan_progress WHERE student_id = $1 AND activity_id = ANY($2::int[])',
        [studentId, activityIds]
    );

    for (let i = 0; i < credited.length; i++) {
        await client.query(
            `INSERT INTO student_plan_progress (student_id, activity_id, completed_on, time_slot)
             VALUES ($1, $2, $3, $4)`,
            [studentId, activityIds[i], credited[i].date, credited[i].time_slot]
        );
    }

    return { completed: credited.length, sessions: sessions.rows.length };
}
