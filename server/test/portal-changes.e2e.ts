/**
 * The administrator's record of what colleagues change in their cabinets, and
 * „Врати" (060; owner, 13 Oct 2026), against a database of its own: every
 * accepted change of a block leaves one row, a refused or empty write leaves
 * none, an undo is a guarded new write that tells the colleague, and the
 * baseline says where a colleague started from. Invented people throughout.
 *
 *     node test/with-scratch.mjs test/portal-changes.e2e.ts     (npm run test:portal-changes)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';

// It writes and deletes rows, and needs 060: only ever in the scratch schema.
if (process.env.MTB_SCRATCH_DB !== '1') {
    console.error('Run through the scratch runner: npm run test:portal-changes');
    process.exit(2);
}
const { portalRoutes } = await import('../src/routes/portal.js');
const { portalChangesRoutes } = await import('../src/routes/portal-changes.js');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1919/1920-changes';
const R1 = 'Пробна Терапевтка Запис Еден';
const R2 = 'Пробен Терапевт Запис Два';
const PUPILS = [
    { id: 'portal-chg-1', name: 'Пробен Ученик Запис Прв' },
    { id: 'portal-chg-2', name: 'Пробна Ученичка Запис Втора' }
];
const CLASS = 'ПЗ-1';
const DAY = 'понеделник';
const A = '08:00-08:40', B = '08:45-09:25';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function main() {
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1919-09-01', '1920-08-31', false) RETURNING id`, [YEAR]);
    const [cls] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, 'zz-portal-chg') RETURNING id`, [CLASS]);
    await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [y.id, cls.id]);
    const rid: Record<string, number> = {};
    for (const name of [R1, R2]) {
        const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]);
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
        rid[name] = t.id;
    }
    const sid: Record<string, number> = {};
    for (const p of PUPILS) {
        const [s] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`, [p.id, p.name, CLASS]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`, [s.id, y.id, CLASS]);
        sid[p.id] = s.id;
        for (const r of [R1, R2]) await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)`, [y.id, rid[r], s.id]);
    }
    // R2 already sees pupil 1 on Monday at 08:00.
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
             VALUES ($1, $2, 1, $3, $4, $5, 'api')`, [y.id, DAY, A, rid[R2], sid[PUPILS[0].id]]);

    const app = Fastify();
    await app.register(portalRoutes, { year: YEAR });
    await app.register(portalChangesRoutes, { year: YEAR });
    const call = async (method: string, url: string, token = '', body?: unknown) => {
        const res = await app.inject({ method: method as any, url, payload: body as any, headers: token ? { 'x-mtb-portal-token': token } : {} });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const t1 = (await app.inject({ method: 'POST', url: '/api/portal/login', payload: { username: R1, password: 'ResursenCentar' } })).json().token as string;
    const term = (body: unknown) => call('PUT', '/api/portal/term', t1, body);
    const block = async (therapist: string, time: string) => (await q(
        `SELECT s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 AND sl.day = $3 AND sl.time_slot = ANY($4::text[]) ORDER BY sl.time_slot`,
        [y.id, rid[therapist], DAY, [time, time.slice(0, 6) + '09:05', '09:05' + time.slice(5)]])).map((r: any) => r.public_id);
    const log = () => q(`SELECT id::int, author_name, slot, before_ids, after_ids, before_times, after_times, forced, undo_of::int, undone_at FROM portal_changes
                          WHERE school_year_id = $1 ORDER BY id`, [y.id]);
    const list = async (query = '') => (await call('GET', '/api/portal-changes' + query)).body;

    try {
        console.log('a change leaves one row');
        const first = await term({ day: DAY, time: B, pupils: [PUPILS[1].id], expected: [] });
        let rows = await log();
        check('a term written through the door is recorded', first.status === 200 && rows.length === 1, JSON.stringify(rows));
        check('with who wrote it, and what stood before and after', rows[0]?.author_name === R1 && rows[0].slot === B
            && rows[0].before_ids.length === 0 && JSON.stringify(rows[0].after_ids) === JSON.stringify([PUPILS[1].id]));
        await term({ day: DAY, time: B, pupils: [PUPILS[1].id], expected: [PUPILS[1].id] });
        check('writing the same thing again is not a change', (await log()).length === 1);
        const stale = await term({ day: DAY, time: B, pupils: [], expected: [] });
        check('a refused write leaves no row', stale.status === 409 && (await log()).length === 1);
        const forced = await term({ day: DAY, time: A, pupils: [PUPILS[0].id], expected: [], force: true });
        rows = await log();
        check('„сепак запиши" is recorded as forced', forced.status === 200 && rows.length === 2 && rows[1].forced === true, JSON.stringify(rows));

        console.log('\nthe administrator reads it');
        const all = await list();
        check('newest first, with names instead of ids', all.changes?.length === 2 && all.changes[0].slot === A
            && all.changes[1].after[0].name === PUPILS[1].name && all.changes[1].before.length === 0, JSON.stringify(all));
        check('and the year\'s cabinets to choose from', (all.therapists || []).some((t: any) => t.name === R1) && (all.therapists || []).some((t: any) => t.name === R2));
        check('a change the block still holds can be put back', all.changes.every((c: any) => c.canUndo === true));
        check('one cabinet can be asked for alone', (await list('?therapistId=' + rid[R2])).changes.length === 0);

        console.log('\n„Врати"');
        const undone = await call('POST', '/api/portal-changes/undo', '', { id: rows[1].id });
        check('the block is as it was before that change', undone.status === 200 && (await block(R1, A)).length === 0, JSON.stringify(undone.body));
        check('the other therapist\'s term is untouched', JSON.stringify(await block(R2, A)) === JSON.stringify([PUPILS[0].id]));
        rows = await log();
        check('the undo is its own row, signed by the administrator', rows.length === 3 && rows[2].undo_of === rows[1].id
            && rows[2].author_name === 'Администраторот' && rows[1].undone_at != null && rows[0].undone_at == null, JSON.stringify(rows));
        const notices = (await call('GET', '/api/portal/week', t1)).body?.notices || [];
        check('and the colleague is told', undone.body?.notified === 1 && notices.some((n: any) => /го врати вашиот термин/.test(n.sentence) && n.sentence.includes(A)), JSON.stringify(notices));
        check('a change already put back offers nothing more', (await list()).changes.find((c: any) => c.id === rows[1].id).canUndo === false);
        // Review, 13 Oct 2026: the same pupil is booked there again, and an old screen presses „Врати" a second time.
        await term({ day: DAY, time: A, pupils: [PUPILS[0].id], expected: [], force: true });
        const again = await call('POST', '/api/portal-changes/undo', '', { id: rows[1].id });
        check('pressing it a second time is refused, and the term booked since stays', again.status === 409 && again.body?.stale === true
            && JSON.stringify(await block(R1, A)) === JSON.stringify([PUPILS[0].id]), JSON.stringify(again.body));
        await term({ day: DAY, time: A, pupils: [], expected: [PUPILS[0].id] });

        console.log('\na block changed since is not overwritten');
        await term({ day: DAY, time: B, pupils: [PUPILS[0].id], expected: [PUPILS[1].id] });
        const late = await call('POST', '/api/portal-changes/undo', '', { id: rows[0].id });
        check('the older change is refused, and says the term moved on', late.status === 409 && late.body?.stale === true, JSON.stringify(late.body));
        check('and nothing was written', JSON.stringify(await block(R1, B)) === JSON.stringify([PUPILS[0].id]));
        check('the list no longer offers it', (await list()).changes.find((c: any) => c.id === rows[0].id).canUndo === false);

        console.log('\nwhere the colleague started from');
        // Review, 13 Oct 2026: a Friday must not sort before a Tuesday. The first change is the earliest, by time.
        const ids = (await log()).map((r: any) => r.id);
        await q(`UPDATE portal_changes SET created_at = '2026-10-16T08:00:00Z' WHERE id = $1`, [ids[1]]);
        await q(`UPDATE portal_changes SET created_at = '2026-10-13T08:00:00Z' WHERE id = $1`, [ids[0]]);
        const base = (await call('GET', '/api/portal-changes/baseline?therapistId=' + rid[R1])).body;
        check('the first change is the earliest one, not the first in the alphabet', String(base.since).startsWith('2026-10-13'), String(base.since));
        check('only the blocks that differ from the start are listed', base.blocks?.length === 1 && base.blocks[0].slot === B
            && base.blocks[0].was.length === 0 && base.blocks[0].now[0].name === PUPILS[0].name && base.unchanged === 1, JSON.stringify(base));
        const back = await call('POST', '/api/portal-changes/undo', '', { id: base.blocks[0].changeId, baseline: { ids: [PUPILS[0].id], times: [B] } });
        check('a block is put back to its first state, from what stands now', back.status === 200 && (await block(R1, B)).length === 0, JSON.stringify(back.body));
        const after = (await call('GET', '/api/portal-changes/baseline?therapistId=' + rid[R1])).body;
        check('and then the cabinet is as it started', after.blocks.length === 0 && after.unchanged === 2, JSON.stringify(after));
        check('every earlier change of that block is closed', (await log()).filter((r: any) => r.slot === B && r.undo_of == null).every((r: any) => r.undone_at != null));

        console.log('\nwhat cannot be put back says why');
        // R1 books pupil 2 at 08:00 and clears it; meanwhile R2 takes pupil 2 at that time.
        await term({ day: DAY, time: A, pupils: [PUPILS[1].id], expected: [] });
        await term({ day: DAY, time: A, pupils: [], expected: [PUPILS[1].id] });
        await q(`DELETE FROM schedule_slots WHERE school_year_id = $1 AND therapist_id = $2`, [y.id, rid[R2]]);
        await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, 1, $3, $4, $5, 'api')`, [y.id, DAY, A, rid[R2], sid[PUPILS[1].id]]);
        const cleared = (await log()).at(-1);
        const clash = await call('POST', '/api/portal-changes/undo', '', { id: cleared.id });
        check('a pupil now with another therapist is not double-booked by an undo', clash.status === 409 && clash.body?.clash === true
            && clash.body.error.includes(R2) && (await block(R1, A)).length === 0, JSON.stringify(clash.body));
        check('an unknown change is refused', (await call('POST', '/api/portal-changes/undo', '', { id: 99999999 })).status === 404);

        console.log('\na term keeps its minutes');
        // Review, 13 Oct 2026: a legacy row is one lone half. The pupil alone reads as the whole bell.
        const TUE = 'вторник', HALF = '08:20-08:40';
        const tuesday = () => q(`SELECT sl.time_slot, s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
                                  WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 AND sl.day = $3 ORDER BY sl.time_slot`, [y.id, rid[R1], TUE]);
        await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
                 VALUES ($1, $2, 2, $3, $4, $5, 'api')`, [y.id, TUE, HALF, rid[R1], sid[PUPILS[1].id]]);
        const resaved = await term({ day: TUE, time: A, pupils: [PUPILS[1].id], expected: [PUPILS[1].id] });
        const widened = (await log()).at(-1);
        check('the same pupil saved again over a lone half is a change of minutes, and is recorded', resaved.status === 200
            && JSON.stringify(widened.before_times) === JSON.stringify([HALF]) && JSON.stringify(widened.after_times) === JSON.stringify([A]), JSON.stringify(widened));
        const shown = (await list()).changes.find((c: any) => c.id === widened.id);
        check('and the administrator sees which minutes', shown.before[0].time === HALF && shown.after[0].time === A && shown.canUndo === true, JSON.stringify(shown));
        const narrowed = await call('POST', '/api/portal-changes/undo', '', { id: widened.id });
        check('putting it back gives the half it was, not the whole bell', narrowed.status === 200
            && JSON.stringify(await tuesday()) === JSON.stringify([{ time_slot: HALF, public_id: PUPILS[1].id }]), JSON.stringify(await tuesday()));
        await term({ day: TUE, time: A, pupils: [PUPILS[0].id], expected: [PUPILS[1].id] });
        const start = (await call('GET', '/api/portal-changes/baseline?therapistId=' + rid[R1])).body.blocks.find((b: any) => b.day === TUE);
        check('the start of that block is the half, with its minutes', start?.was[0].time === HALF && start.now[0].time === A, JSON.stringify(start));
        const home = await call('POST', '/api/portal-changes/undo', '', { id: start.changeId, baseline: { ids: [PUPILS[0].id], times: [A] } });
        check('and „Врати на почетното" restores exactly that', home.status === 200
            && JSON.stringify(await tuesday()) === JSON.stringify([{ time_slot: HALF, public_id: PUPILS[1].id }]), JSON.stringify(home.body));
        const wrong = await call('POST', '/api/portal-changes/undo', '', { id: start.changeId, baseline: { ids: [PUPILS[1].id], times: [A] } });
        check('a screen that showed other minutes than the block has is refused', wrong.status === 409 && wrong.body?.stale === true, JSON.stringify(wrong.body));
    } finally {
        await app.close();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
