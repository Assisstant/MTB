/**
 * Group terms (063; owner, 14 Oct 2026) through the one block writer and the
 * older routes, against a database of its own: several pupils the whole bell
 * together, two pupils kept as they were when nothing says otherwise, a group
 * never split by a route that knows one pupil per cell, and the old export's
 * first pupil plus the additive `groups`. Invented people throughout.
 *
 *     node test/with-scratch.mjs test/schedule-groups.e2e.ts     (npm run test:groups)
 */
import pg from 'pg';
import 'dotenv/config';

if (process.env.MTB_SCRATCH_DB !== '1') {
    console.error('Run through the scratch runner: npm run test:groups');
    process.exit(2);
}
const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const YEAR = '1912/1913-groups';
const TAG = 'groups-test';
const DAY = 'понеделник', BELL = '08:00-08:40', NEXT = '08:45-09:25';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
};

async function main() {
    const [year] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current) VALUES ($1, '1912-09-01', '1913-08-31', false) RETURNING id`, [YEAR]);
    const [therapist] = await q(`INSERT INTO therapists (name) VALUES ('Пробна Терапевтка Групи') RETURNING id, name`);
    const [other] = await q(`INSERT INTO therapists (name) VALUES ('Пробен Терапевт Друг') RETURNING id, name`);
    for (const t of [therapist, other]) await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [year.id, t.id]);
    const ids: string[] = [];
    const names = ['Ана', 'Бојан', 'Вера', 'Горан', 'Дена', 'Ѓорѓи', 'Ема', 'Жана', 'Зоран'];
    for (const [n, first] of names.entries()) {
        const publicId = `${TAG}-${n + 1}`;
        const [s] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, $2, 'II-а') RETURNING id`, [publicId, `${first} Пробна Група`]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, active) VALUES ($1, $2, 'II-а', true)`, [s.id, year.id]);
        for (const t of [therapist, other]) await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)`, [year.id, t.id, s.id]);
        ids.push(publicId);
    }
    const block = (studentPublicIds: string[], more: Record<string, unknown> = {}) => api('PUT', '/api/schedule/block',
        { year: YEAR, day: DAY, time: BELL, therapistId: therapist.id, studentPublicIds, ...more });
    const rows = (time = BELL) => q(`SELECT sl.time_slot, s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
                                      WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 AND sl.day = $3
                                        AND sl.time_slot IN ($4, $5, $6) ORDER BY sl.id`,
        [year.id, therapist.id, DAY, time, time.slice(0, 5) + '-' + (time === BELL ? '08:20' : '09:05'), (time === BELL ? '08:20' : '09:05') + '-' + time.slice(6)]);

    try {
        console.log('a group');
        const three = await block(ids.slice(0, 3), { expectedStudentPublicIds: [] });
        let now = await rows();
        check('three pupils are one term, each the whole bell', three.status === 200 && three.body.together === true
            && now.length === 3 && now.every((r: any) => r.time_slot === BELL), JSON.stringify({ three: three.body, now }));
        const reordered = await block(ids.slice(0, 4), { expectedStudentPublicIds: [ids[2], ids[0], ids[1]] });
        now = await rows();
        check('a group is compared as who is in it, not in which order', reordered.status === 200 && now.length === 4, JSON.stringify(reordered.body));
        const stale = await block(ids.slice(0, 2), { expectedStudentPublicIds: ids.slice(0, 3) });
        check('somebody else\'s change in between is still refused', stale.status === 409 && (await rows()).length === 4, JSON.stringify(stale.body));
        check('three cannot be „по 20"', (await block(ids.slice(0, 3), { mode: 'halves' })).status === 400);
        check('nine is more than a group takes', (await block(ids.slice(0, 9))).status === 400);

        console.log('\ntwo pupils');
        const together = await block(ids.slice(0, 2), { mode: 'together', expectedStudentPublicIds: ids.slice(0, 4) });
        now = await rows();
        check('two „together" are a group of two', together.status === 200 && now.length === 2 && now.every((r: any) => r.time_slot === BELL), JSON.stringify(now));
        const kept = await block(ids.slice(0, 2), { expectedStudentPublicIds: ids.slice(0, 2) });
        check('the same two written by a caller that knows nothing of groups stay together', kept.status === 200 && kept.body.together === true
            && (await rows()).every((r: any) => r.time_slot === BELL));
        const halves = await api('PUT', '/api/schedule/block', { year: YEAR, day: DAY, time: NEXT, therapistId: therapist.id, studentPublicIds: ids.slice(0, 2) });
        const next = await rows(NEXT);
        check('two new pupils, nothing said, are halves as before', halves.status === 200 && halves.body.together === false
            && JSON.stringify(next.map((r: any) => r.time_slot)) === JSON.stringify(['08:45-09:05', '09:05-09:25']), JSON.stringify(next));

        console.log('\nthe routes that know one pupil per cell');
        const session = await api('PUT', '/api/schedule/session', { year: YEAR, day: DAY, time: BELL, therapistId: therapist.id, studentPublicId: ids[5] });
        check('the session route does not split a group', session.status === 409 && session.body.group === true && (await rows()).length === 2, JSON.stringify(session.body));
        const slot = await api('PUT', '/api/schedule/slot', { year: YEAR, day: DAY, time: BELL, therapist: therapist.name, student: `${names[5]} Пробна Група` });
        check('nor does the slot by name', slot.status === 409 && slot.body.group === true && (await rows()).length === 2, JSON.stringify(slot.body));

        console.log('\na child in two places at once');
        await api('PUT', '/api/schedule/block', { year: YEAR, day: DAY, time: '09:30-10:10', therapistId: other.id, studentPublicIds: [ids[6]] });
        const clash = await api('PUT', '/api/schedule/block', { year: YEAR, day: DAY, time: '09:30-10:10', therapistId: therapist.id,
            studentPublicIds: [ids[5], ids[6], ids[7]] });
        check('a group member with another therapist then is refused, as one pupil would be', clash.status === 409 && clash.body.doubleBooked === true, JSON.stringify(clash.body));

        console.log('\nthe old export');
        await block([ids[0], ids[1], ids[2]], { expectedStudentPublicIds: ids.slice(0, 2) });
        const exported = (await api('GET', '/api/schedule?year=' + encodeURIComponent(YEAR))).body;
        const term = exported.find((t: any) => t.day === DAY && t.time === BELL);
        check('the old apps get the first pupil, the new system the whole group beside it', term
            && term.assignments[therapist.name] === `${names[0]} Пробна Група`
            && JSON.stringify(term.groups[therapist.name]) === JSON.stringify(names.slice(0, 3).map((n) => `${n} Пробна Група`)), JSON.stringify(term));
        const halvesTerm = exported.find((t: any) => t.day === DAY && t.time === '08:45-09:05');
        check('halves keep their old shape, with no groups field', halvesTerm && !halvesTerm.groups, JSON.stringify(halvesTerm));

        console.log('\nemptied');
        const cleared = await block([], { expectedStudentPublicIds: ids.slice(0, 3) });
        check('an empty term takes the whole group off', cleared.status === 200 && (await rows()).length === 0);
    } finally {
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
