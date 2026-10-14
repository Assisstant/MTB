/**
 * Акциски план through the colleagues' door, and the administrator's record of
 * it (061; owner, 14 Oct 2026), against a database of its own: everybody signed
 * in writes every pupil's plan, each accepted change leaves one row, a stale
 * write is refused, „потврда" works for one part and for many pupils at once,
 * a quarter can be taken from the one before, and „Врати" / „Премести кај друго
 * дете" are guarded new writes. Invented people throughout.
 *
 *     node test/with-scratch.mjs test/portal-plan.e2e.ts     (npm run test:portal-plan)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';

// It writes and deletes rows, and needs 061: only ever in the scratch schema.
if (process.env.MTB_SCRATCH_DB !== '1') {
    console.error('Run through the scratch runner: npm run test:portal-plan');
    process.exit(2);
}
const { portalRoutes } = await import('../src/routes/portal.js');
const { planChangesRoutes } = await import('../src/routes/portal-plan.js');
const { canon } = await import('../src/lib/pupil-plan.js');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1918/1919-plan';
const R1 = 'Пробна Терапевтка План Еден';
const T1 = 'Пробен Наставник План Два';
const PUPILS = [
    { id: 'plan-pupil-1', name: 'Пробен Ученик План Прв' },
    { id: 'plan-pupil-2', name: 'Пробна Ученичка План Втора' },
    { id: 'plan-pupil-3', name: 'Пробен Ученик План Трет' }
];
const CLASS = 'ПП-1';
const CODE = 'logoped';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
// jsonb hands an object back with its keys rearranged (trap 21), so content is compared with the keys in one order.
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
/** An area as the server keeps it: every field present, in this order. */
const area = (label: string, level: number | null, more: { baseline?: number | null; stage?: number | null; note?: string } = {}) =>
    ({ label, level, baseline: more.baseline ?? null, stage: more.stage ?? null, note: more.note ?? '' });

async function main() {
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1918-09-01', '1919-08-31', false) RETURNING id`, [YEAR]);
    const [cls] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, 'zz-plan') RETURNING id`, [CLASS]);
    await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [y.id, cls.id]);
    const [category] = await q(`SELECT id FROM specialist_categories WHERE code = $1`, [CODE]);
    const [r] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [R1]);
    await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active, category_id) VALUES ($1, $2, true, $3)`, [y.id, r.id, category.id]);
    const [t] = await q(`INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [T1]);
    await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role) VALUES ($1, $2, $3, 'homeroom')`, [y.id, t.id, cls.id]);
    const sid: Record<string, number> = {};
    for (const p of PUPILS) {
        const [s] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`, [p.id, p.name, CLASS]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`, [s.id, y.id, CLASS]);
        sid[p.id] = s.id;
    }
    // Only the first two are on the therapist's own list.
    for (const p of PUPILS.slice(0, 2)) await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)`, [y.id, r.id, sid[p.id]]);

    const app = Fastify();
    await app.register(portalRoutes, { year: YEAR });
    await app.register(planChangesRoutes, { year: YEAR });
    const call = async (method: string, url: string, token = '', body?: unknown) => {
        const res = await app.inject({ method: method as any, url, payload: body as any, headers: token ? { 'x-mtb-portal-token': token } : {} });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const login = async (username: string) => (await app.inject({ method: 'POST', url: '/api/portal/login', payload: { username, password: 'ResursenCentar' } })).json().token as string;
    const therapist = await login(R1), teacher = await login(T1);
    const put = (token: string, publicId: string, part: string, data: unknown, version: number) => call('PUT', '/api/portal/plan/part', token, { publicId, part, data, version });
    const confirm = (token: string, items: unknown[], on = true) => call('POST', '/api/portal/plan/confirm', token, { on, items });
    const pupil = async (publicId: string, token = therapist) => (await call('GET', '/api/portal/plan/pupil?publicId=' + publicId, token)).body;
    const log = () => q(`SELECT id::int, part, kind, author_name, before, after, undo_of::int, undone_at, student_id FROM pupil_plan_changes
                          WHERE school_year_id = $1 ORDER BY id`, [y.id]);
    const admin = async (query = '') => (await call('GET', '/api/plan-changes' + query)).body;
    const [P1, P2, P3] = PUPILS.map((p) => p.id);
    const MARKS = `marks:${CODE}:1`, NEXT = `marks:${CODE}:2`;

    try {
        console.log('the door');
        check('nothing is answered without a sign-in', (await call('GET', '/api/portal/plan')).status === 401
            && (await call('GET', '/api/portal/plan/pupil?publicId=' + P1)).status === 401
            && (await put('', P1, 'iop', { goals: 'x' }, 0)).status === 401);
        const first = (await call('GET', '/api/portal/plan', therapist)).body;
        check('everybody signed in sees every pupil of the year — on the initial password too', first.pupils?.length === 3
            && first.pupils.every((p: any) => p.cabinets.length === 0 && same(p.parts, {})), JSON.stringify(first.pupils));
        check('with the profiles to choose from, and what is one\'s own', first.categories.some((c: any) => c.code === CODE)
            && same(first.mine.codes, [CODE]) && first.mine.caseload === 2, JSON.stringify(first.mine));
        const mineTeacher = (await call('GET', '/api/portal/plan', teacher)).body.mine;
        check('a teacher\'s own is the class they lead', same(mineTeacher.classes, [CLASS]) && same(mineTeacher.codes, []), JSON.stringify(mineTeacher));

        console.log('\nthe cabinets in a plan are chosen, and stay');
        const whole = await call('POST', '/api/portal/plan/from-caseload', therapist);
        check('a therapist\'s list is taken in one press', whole.status === 200 && whole.body.added === 2, JSON.stringify(whole.body));
        check('and a second press adds nothing', (await call('POST', '/api/portal/plan/from-caseload', therapist)).body.added === 0);
        await q(`DELETE FROM therapist_students WHERE school_year_id = $1`, [y.id]);
        const after = (await call('GET', '/api/portal/plan', therapist)).body.pupils;
        check('the pupil stays in the plan after leaving the therapist\'s list', same(after.find((p: any) => p.publicId === P1).cabinets, [CODE])
            && same(after.find((p: any) => p.publicId === P3).cabinets, []));
        check('a teacher has no list to take', (await call('POST', '/api/portal/plan/from-caseload', teacher)).status === 403);
        check('an unknown profile is refused', (await put(teacher, P3, 'cabinets', { codes: ['nema_takov'] }, 0)).status === 400);
        check('a teacher may put a cabinet in a pupil\'s plan', (await put(teacher, P3, 'cabinets', { codes: [CODE] }, 0)).status === 200);

        console.log('\none part, written whole');
        const TEXT = '  Цел со празно место на почеток\nи нов ред.  ';
        const iop = await put(teacher, P1, 'iop', { goals: TEXT, strategies: 'Стратегија' }, 0);
        check('a teacher writes the ИОП', iop.status === 200 && iop.body.part.version === 1 && iop.body.changeId > 0, JSON.stringify(iop.body));
        check('free text is kept exactly as typed', (await pupil(P1)).parts.iop.data.goals === TEXT);
        check('a therapist reads it and may write it too', (await put(therapist, P1, 'iop', { goals: TEXT, strategies: 'Друга' }, 1)).status === 200);
        let rows = await log();
        const mine = rows.filter((c: any) => c.part === 'iop');
        check('each write is one row: who, before and after', mine.length === 2 && mine[0].author_name === T1 && mine[0].before === null
            && mine[1].author_name === R1 && mine[1].before.data.strategies === 'Стратегија' && mine[1].after.data.strategies === 'Друга', JSON.stringify(mine));
        const again = await put(therapist, P1, 'iop', { strategies: 'Друга', goals: TEXT }, 2);
        check('the same content again is not a change', again.status === 200 && again.body.changeId === null && (await log()).length === rows.length);
        const stale = await put(teacher, P1, 'iop', { goals: 'од стар екран' }, 1);
        check('a write from a stale screen is refused, with what stands now', stale.status === 409 && stale.body.stale === true
            && stale.body.current.data.strategies === 'Друга' && (await log()).length === rows.length, JSON.stringify(stale.body));
        check('a field the part does not have is refused', (await put(teacher, P1, 'iop', { goals: 'x', other: 'y' }, 2)).status === 400);
        check('a level outside the scale is refused', (await put(therapist, P1, MARKS, { rows: [{ label: 'Артикулација', level: 5 }] }, 0)).status === 400);
        check('a pupil who is not on the year\'s list is refused', (await put(therapist, 'nema-takov', 'iop', { goals: 'x' }, 0)).status === 404);

        console.log('\n„потврда"');
        const ROWS = [area('Артикулација', 2, { baseline: 1, stage: 1, note: 'Белешка за областа' }), area('Јазично разбирање', null)];
        await put(therapist, P1, MARKS, { rows: ROWS, note: 'Белешка' }, 0);
        check('an area keeps its starting mark, developmental level and own note', same((await pupil(P1)).parts[MARKS].data.rows, ROWS));
        check('a developmental level outside its four steps is refused', (await put(therapist, P3, MARKS, { rows: [{ label: 'Област', level: 1, stage: 4 }] }, 0)).status === 400);
        await put(therapist, P2, MARKS, { rows: [{ label: 'Артикулација', level: 1, baseline: 0, stage: 0, note: 'Само за првиот квартал' }] }, 0);
        check('the areas a cabinet has named are offered to pick from', same((await pupil(P3)).labels[CODE], ['Артикулација', 'Јазично разбирање']));
        const both = await confirm(therapist, [{ publicId: P1, part: MARKS, version: 1 }, { publicId: P2, part: MARKS, version: 1 }, { publicId: P3, part: MARKS, version: 0 }]);
        check('many pupils are confirmed at once, each with its own answer', both.status === 200 && both.body.done === 2 && both.body.ok === false
            && both.body.results[2].ok === false && /Празно/.test(both.body.results[2].error), JSON.stringify(both.body));
        let p1 = await pupil(P1);
        check('with the name of who confirmed', p1.parts[MARKS].confirmedBy === R1 && Boolean(p1.parts[MARKS].confirmedAt));
        const overview = (await call('GET', '/api/portal/plan', teacher)).body.pupils.find((p: any) => p.publicId === P1);
        check('the overview says started or confirmed, and carries no text', overview.parts[MARKS].confirmedBy === R1
            && overview.parts.iop.confirmedBy === null && !overview.parts.iop.empty && !JSON.stringify(overview).includes('Белешка'), JSON.stringify(overview));
        check('the list of cabinets is not something to confirm', (await confirm(therapist, [{ publicId: P1, part: 'cabinets', version: 1 }])).status === 400);
        const reopened = await put(teacher, P1, MARKS, { rows: [{ label: 'Артикулација', level: 3 }], note: 'Белешка' }, p1.parts[MARKS].version);
        p1 = await pupil(P1);
        check('a change after the confirmation opens it again, and says so', reopened.status === 200 && reopened.body.reopened === true && p1.parts[MARKS].confirmedBy === null);
        const stalePick = await confirm(therapist, [{ publicId: P1, part: MARKS, version: 1 }]);
        check('a confirmation from a stale list is refused', stalePick.body.done === 0 && stalePick.body.results[0].stale === true);

        console.log('\na quarter starts from the one before');
        const carried = await confirm(therapist, [{ publicId: P2, part: NEXT, version: 0, carry: true }]);
        const p2 = await pupil(P2);
        check('„без промена": the earlier quarter is taken and confirmed in one press', carried.body.done === 1
            && p2.parts[NEXT].confirmedBy === R1, JSON.stringify(carried.body));
        check('the marks come along, the quarter\'s own note does not', same(p2.parts[NEXT].data.rows, [area('Артикулација', 1, { baseline: 0, stage: 0 })]), JSON.stringify(p2.parts[NEXT].data));
        check('where there is no earlier quarter there is nothing to take', (await confirm(therapist, [{ publicId: P3, part: NEXT, version: 0, carry: true }])).body.done === 0);

        console.log('\nthe colleague\'s own „Врати"');
        const slip = await put(therapist, P2, 'review:1', { report: 'Запишано кај погрешно дете' }, 0);
        check('somebody else\'s change cannot be put back', (await call('POST', '/api/portal/plan/undo', teacher, { id: slip.body.changeId })).status === 403);
        const back = await call('POST', '/api/portal/plan/undo', therapist, { id: slip.body.changeId });
        check('one\'s own last save is put back', back.status === 200 && (await pupil(P2)).parts['review:1'].data.report === '', JSON.stringify(back.body));
        check('and not a second time', (await call('POST', '/api/portal/plan/undo', therapist, { id: slip.body.changeId })).status === 409);
        const emptied = (await call('GET', '/api/portal/plan', therapist)).body.pupils.find((p: any) => p.publicId === P2).parts['review:1'];
        check('an emptied part reads as empty and keeps its version', emptied.empty === true && emptied.version === 2, JSON.stringify(emptied));

        console.log('\nthe administrator\'s record');
        const all = await admin();
        check('newest first, with the pupil\'s name and who wrote it', all.changes?.length === (await log()).length && all.changes[0].kind === 'undo'
            && all.changes[0].pupil.name === PUPILS[1].name && all.authors.some((a: any) => a.name === T1), JSON.stringify(all.changes?.[0]));
        check('one pupil or one colleague can be asked for alone', (await admin('?publicId=' + P3)).changes.every((c: any) => c.pupil.publicId === P3)
            && (await admin('?employeeId=' + all.authors.find((a: any) => a.name === T1).employeeId)).changes.every((c: any) => c.author === T1));
        check('only the last word on a part can be put back', all.changes.find((c: any) => c.part === 'iop' && c.author === R1 && c.kind === 'write').canUndo === true
            && all.changes.find((c: any) => c.part === 'iop' && c.author === T1).canUndo === false);
        check('a colleague\'s sign-in does not open the record', (await call('GET', '/api/plan-changes', therapist)).status === 403);

        console.log('\n„Врати" by the administrator');
        const lastIop = all.changes.find((c: any) => c.part === 'iop' && c.canUndo);
        const undone = await call('POST', '/api/plan-changes/undo', '', { id: lastIop.id });
        check('the part is as it was before that change', undone.status === 200 && (await pupil(P1)).parts.iop.data.strategies === 'Стратегија', JSON.stringify(undone.body));
        rows = await log();
        check('as a new row signed by the administrator', rows.at(-1).kind === 'undo' && rows.at(-1).author_name === 'Администраторот' && rows.at(-1).undo_of === lastIop.id);
        check('and the step before it can now be put back in turn', (await admin()).changes.find((c: any) => c.part === 'iop' && c.author === T1).canUndo === true);
        const p1marks = (await admin()).changes.find((c: any) => c.part === MARKS && c.pupil.publicId === P1 && c.kind === 'write' && c.canUndo);
        const reconfirmed = await call('POST', '/api/plan-changes/undo', '', { id: p1marks.id });
        p1 = await pupil(P1);
        check('putting back a change that opened a confirmation gives the confirmation back', reconfirmed.status === 200
            && p1.parts[MARKS].confirmedBy === R1 && same(p1.parts[MARKS].data.rows, ROWS), JSON.stringify(p1.parts[MARKS]));

        console.log('\n„Премести кај друго дете"');
        const wrong = await put(therapist, P1, 'review:2', { report: 'Ова е за третиот ученик' }, 0);
        await put(teacher, P2, 'review:2', { report: 'Веќе пополнето' }, 0);
        const taken = await call('POST', '/api/plan-changes/move', '', { id: wrong.body.changeId, toPublicId: P2 });
        check('a pupil whose part is already written is not written over', taken.status === 409 && taken.body.occupied === true
            && (await pupil(P1)).parts['review:2'].data.report === 'Ова е за третиот ученик' && (await pupil(P2)).parts['review:2'].data.report === 'Веќе пополнето', JSON.stringify(taken.body));
        const moved = await call('POST', '/api/plan-changes/move', '', { id: wrong.body.changeId, toPublicId: P3 });
        const p3 = await pupil(P3);
        check('the words go to the right pupil and leave the wrong one', moved.status === 200 && moved.body.movedTo === PUPILS[2].name
            && p3.parts['review:2'].data.report === 'Ова е за третиот ученик' && (await pupil(P1)).parts['review:2'].data.report === '', JSON.stringify(moved.body));
        check('still under the name of the colleague who wrote them', p3.parts['review:2'].by === R1 && p3.parts['review:2'].confirmedBy === null);
        rows = await log();
        check('with both halves in the record', rows.at(-2).kind === 'move' && rows.at(-2).student_id === sid[P3] && rows.at(-1).kind === 'undo' && rows.at(-1).student_id === sid[P1]);
        check('the list of cabinets is not something to move', (await call('POST', '/api/plan-changes/move', '', {
            id: rows.find((c: any) => c.part === 'cabinets').id, toPublicId: P2 })).status === 409);
        check('an unknown change is refused', (await call('POST', '/api/plan-changes/undo', '', { id: 99999999 })).status === 404);

        console.log('\nthe switch left for later');
        process.env.MTB_PLAN_OWN_PASSWORD = '1';
        const closed = await call('GET', '/api/portal/plan', therapist);
        check('with it the plan asks for one\'s own password', closed.status === 403 && closed.body.needsPassword === true);
        delete process.env.MTB_PLAN_OWN_PASSWORD;
    } finally {
        await app.close();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
