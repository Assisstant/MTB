/**
 * „＋ Нов ученик (набљудување)…" in a RasporediFusion cell: a child the
 * database does not know yet becomes a PUPIL (external, no class,
 * placement = observation), goes on that therapist's list and into the cell —
 * never a free-text label, and never a second copy of a child already listed.
 *
 * Self-contained: the page is read from disk on a fake localhost origin and a
 * stateful fake API answers here. Invented names only; nothing reaches a real
 * server. CHROME can select an installed browser.
 *
 *   node test/fusion-new-pupil.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3996';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const NEW = '__new-observation-pupil__';
const year = '2026/2027';
const bells = [{ label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 }];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

/** A fresh page with its own fake database. `answers` feeds prompt/confirm in order. */
async function open() {
    const db = {
        students: [
            { public_id: 'p-listed', name: 'Пробно Дете', grade: 'III', kind: 'internal', active: true },
            { public_id: 'p-other', name: 'Друго Дете', grade: 'IV', kind: 'internal', active: true }
        ],
        therapists: [{ id: 1, name: 'Терапевт Пример', students: ['p-listed'] }],
        // In the database but NOT on this year's list: the server refuses the name.
        hiddenNames: ['скриено дете'],
        sessions: [],
        writes: [],
        nextId: 1
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = [];
    const answers = [];
    const dialogs = [];
    await context.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
        const p = decodeURIComponent(url.pathname);
        if (p.startsWith('/api/')) {
            const m = req.method();
            if (m === 'GET') {
                if (p === '/api/health') return json(200, { ok: true, server: { label: 'Пробна база' } });
                if (p === '/api/years') return json(200, [{ id: 1, label: year, is_current: true }]);
                if (p === '/api/roster') return json(200, { year, students: db.students, therapists: db.therapists, teachers: [] });
                if (p === '/api/schedule/sessions') return json(200, { year, sessions: db.sessions });
                if (p === '/api/teaching/timetable') return json(200, { bells: { kabinet: bells } });
                if (p === '/api/teaching/crossing') return json(200, { cells: [] });
                return json(401, {});
            }
            const body = JSON.parse(req.postData() || '{}');
            db.writes.push({ method: m, path: p, body });
            if (m === 'POST' && p === '/api/workspace/pupils') {
                const key = String(body.name).trim().toLocaleLowerCase('mk-MK');
                if (db.hiddenNames.includes(key) || db.students.some((s) => s.name.toLocaleLowerCase('mk-MK') === key)) {
                    return json(409, { error: 'Веќе има ученик со ова име. Проверете го постојниот запис во Податоци пред додавање истоимен ученик.' });
                }
                const pupil = { public_id: 'pupil-new-' + db.nextId++, name: body.name, grade: null, kind: 'external', active: true };
                db.students.push(pupil);
                return json(200, { ok: true, pupil: { ...pupil, placement: body.placement } });
            }
            const caseload = /^\/api\/therapists\/(.+)\/students\/(.+)$/.exec(p);
            if (m === 'PUT' && caseload) {
                const t = db.therapists.find((x) => x.name === caseload[1]);
                if (!t.students.includes(caseload[2])) t.students.push(caseload[2]);
                return json(200, { ok: true });
            }
            if (m === 'PUT' && p === '/api/schedule/block') {
                db.sessions = db.sessions.filter((s) => !(s.day === body.day && s.therapist_id === body.therapistId));
                const rows = body.studentPublicIds.map((id) => ({
                    day: body.day, time: body.time, therapist_id: body.therapistId, therapist_name: 'Терапевт Пример',
                    student_public_id: id, student_name: (db.students.find((s) => s.public_id === id) || {}).name
                }));
                db.sessions.push(...rows);
                return json(200, { sessions: rows });
            }
            return json(405, { error: 'not in fixture' });
        }
        const file = p.replace(/^\//, '');
        const path = join(ROOT, file);
        if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => {
        dialogs.push({ type: d.type(), message: d.message() });
        const next = answers.shift();
        if (next === undefined || next === false) await d.dismiss();
        else if (d.type() === 'prompt') await d.accept(String(next));
        else await d.accept();
    });
    await page.goto(ORIGIN + '/RasporediFusion.html');
    await page.locator('#scheduleGrid .schedule-grid').waitFor();
    return { context, page, db, errors, answers, dialogs };
}

const firstCell = 'select[data-block-time]';
const notice = (page) => page.locator('#notice').textContent();
const settle = (page) => page.waitForTimeout(700);

try {
    console.log('\nthe option');
    {
        const { context, page, errors } = await open();
        const options = await page.locator(firstCell).first().locator('option').evaluateAll((o) => o.map((x) => [x.value, x.textContent]));
        check('an empty cell offers „＋ Нов ученик (набљудување)…" as its LAST entry',
            options.length > 0 && options[options.length - 1][0] === NEW && options[options.length - 1][1].includes('Нов ученик (набљудување)'),
            JSON.stringify(options));
        check('it is offered once per cell', options.filter((o) => o[0] === NEW).length === 1);
        check('no page errors on load', errors.length === 0, errors.join('\n'));
        await context.close();
    }

    console.log('\na child nobody knows yet');
    {
        const { context, page, db, errors, answers } = await open();
        answers.push('Лана');
        await page.locator(firstCell).first().selectOption(NEW);
        await settle(page);
        const created = db.writes.find((w) => w.path === '/api/workspace/pupils');
        check('a PUPIL is created, not a label', !!created, JSON.stringify(db.writes.map((w) => w.path)));
        check('…under observation, external, with no class, active this year',
            created && created.body.placement === 'observation' && created.body.enrollmentType === 'external' &&
            created.body.grade === null && created.body.active === true && created.body.year === year,
            JSON.stringify(created && created.body));
        const order = db.writes.map((w) => w.method + ' ' + (w.path.startsWith('/api/therapists/') ? 'caseload' : w.path));
        check('create → therapist list → cell, in that order',
            JSON.stringify(order) === JSON.stringify(['POST /api/workspace/pupils', 'PUT caseload', 'PUT /api/schedule/block']),
            JSON.stringify(order));
        const block = db.writes.find((w) => w.path === '/api/schedule/block');
        check('the cell is booked with the NEW pupil id', block && JSON.stringify(block.body.studentPublicIds) === '["pupil-new-1"]',
            JSON.stringify(block && block.body));
        check('she is now on the therapist\'s list', db.therapists[0].students.includes('pupil-new-1'));
        check('the cell shows her name', (await page.locator('#scheduleGrid').textContent()).includes('Лана'));
        check('the person is told what happened', (await notice(page)).includes('додаден како ученик под набљудување'), await notice(page));
        check('no page errors', errors.length === 0, errors.join('\n'));
        await context.close();
    }

    console.log('\na name already on the year\'s list');
    {
        const { context, page, db, errors, answers, dialogs } = await open();
        answers.push('  друго   ДЕТЕ ', true);             // different spacing and case, then OK
        await page.locator(firstCell).first().selectOption(NEW);
        await settle(page);
        check('the existing child is OFFERED', dialogs.some((d) => d.type === 'confirm' && d.message.includes('Друго Дете')),
            JSON.stringify(dialogs));
        check('no second child is created', !db.writes.some((w) => w.path === '/api/workspace/pupils'));
        check('the existing child goes on the therapist\'s list', db.therapists[0].students.includes('p-other'));
        const block = db.writes.find((w) => w.path === '/api/schedule/block');
        check('the cell is booked with the EXISTING id', block && JSON.stringify(block.body.studentPublicIds) === '["p-other"]');
        check('no page errors', errors.length === 0, errors.join('\n'));
        await context.close();
    }

    console.log('\ncancelling');
    {
        const { context, page, db, answers } = await open();
        answers.push(false);                                // Cancel on the name prompt
        await page.locator(firstCell).first().selectOption(NEW);
        await settle(page);
        check('Cancel on the name writes nothing', db.writes.length === 0, JSON.stringify(db.writes));
        check('the cell goes back to empty', await page.locator(firstCell).first().inputValue() === '');

        answers.push('Пробно Дете', false);                 // listed name, then Cancel on the offer
        await page.locator(firstCell).first().selectOption(NEW);
        await settle(page);
        check('declining the offered child writes nothing', db.writes.length === 0, JSON.stringify(db.writes));
        await context.close();
    }

    console.log('\nthe server refuses a name');
    {
        const { context, page, db, errors, answers } = await open();
        answers.push('Скриено Дете');
        await page.locator(firstCell).first().selectOption(NEW);
        await settle(page);
        check('the refusal is shown in words', (await notice(page)).includes('Веќе има ученик со ова име'), await notice(page));
        check('nothing else is written after a refusal',
            db.writes.length === 1 && db.writes[0].path === '/api/workspace/pupils', JSON.stringify(db.writes.map((w) => w.path)));
        check('the cell stays empty', await page.locator(firstCell).first().inputValue() === '');
        check('no page errors', errors.length === 0, errors.join('\n'));
        await context.close();
    }
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
