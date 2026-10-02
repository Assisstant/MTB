/**
 * A pupil whose diary id is 0 (S-Dnevnik.html, `repairUnusableStudentIds`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing real can be read or written. The people are invented.
 *
 * Where the 0 came from: `Number(null)` is 0, so a pupil admitted from the
 * annual list while the database held no `sdnevnik_id` for them got diary id 0.
 * The term drew normally and the attendance square refused the click with
 * "Missing data for this slot", because 0 is falsy.
 *
 * What it holds the repair to:
 *   - one pupil with id 0 gets a real number, and the term, the past weeks,
 *     the marks, the progress and the records under 0 all follow;
 *   - the new number is saved, so the next load does not make another;
 *   - the attendance square then works, and one click is ONE step even when
 *     the week was drawn twice in the same tick;
 *   - two pupils with id 0 are left exactly as they were -- whose records
 *     those are cannot be known, and it is not guessed (rule 2);
 *   - a database row whose `sdnevnik_id` is 0 does not hand out 0 again.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// localhost, so the diary treats the page as served by its own server.
const SERVED = 'http://localhost:4611';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
// A Wednesday in a plain working week: the Tuesday before it takes attendance.
const NOW = new Date('2026-09-30T10:00:00');
const TUESDAY = '2026-09-29';
const LAST_WEEK = '2026-09-21';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const build = () => {
    const payload = {
        students: [
            { id: 1001, name: 'Пробен Алфа', grade: 'V', kind: 'internal', disabilityType: '', planId: 9001 },
            { id: 0, name: 'Пробен Нула', grade: 'V-a', kind: 'internal', rasporediStudentId: 'p-zero', disabilityType: '', planId: 9001 }
        ],
        archivedStudents: [], formerCaseloadStudents: [], schedule: emptyWeek(),
        scheduleHistory: { [LAST_WEEK]: emptyWeek() },
        attendance: { '2026-09-22': { 0: { 'tuesday-2': { status: 'present', date: '2026-09-22', time: '09:40-10:20' } } } },
        plans: [{ id: 9001, name: 'Пробна програма', activities: ['Активност'] }],
        links: [], studentProgress: { 0: { 9001: [{ date: '2026-09-22', time: '09:40-10:20' }] } },
        trijazenTestovi: [{ id: 5001, studentId: 0, studentName: 'Пробен Нула', grade: 'V-a', date: '2026-09-15', assessor: '', timestamp: '2026-09-15T08:00:00.000Z', assessments: {} }],
        student_records: [], audiograms: [],
        assessments: [
            { id: 6001, studentId: 0, studentName: 'Пробен Нула', grade: 'V', scaleType: 'x', templateName: 'Пробна скала', date: '2026-09-15', period: 'T1', scores: {}, comment: '', average: '—' },
            { id: 6002, studentId: 1001, studentName: 'Пробен Алфа', grade: 'V', scaleType: 'x', templateName: 'Пробна скала', date: '2026-09-15', period: 'T1', scores: {}, comment: '', average: '—' }
        ],
        scaleTemplates: []
    };
    payload.schedule.monday[0] = [1001];
    payload.schedule.tuesday[2] = [0];
    payload.schedule.thursday[1] = [1001, 0];
    payload.scheduleHistory[LAST_WEEK].tuesday[2] = [0];
    return payload;
};

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const dialogs = [];
const errors = [];

await context.addInitScript(() => {
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
});
await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== SERVED) return route.abort();
    if (url.pathname.startsWith('/api/')) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
    if (name === 'mtb-runtime.js') return route.fulfill({ status: 200, contentType: TYPES['.js'], body: 'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;' });
    try {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body: await readFile(path.join(ROOT, name)) });
    } catch { return route.fulfill({ status: 404, body: '' }); }
});

const page = await context.newPage();
await page.clock.setFixedTime(NOW);
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

const open = async () => {
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SDiary);
};
// Drawn twice in one tick on purpose, as a pull from the server does: the
// handlers of the first draw must not be attached beside those of the second,
// or one click counts as two and an unmarked square goes straight to absent.
const load = (payload) => page.evaluate((p) => {
    window.SdnV3.applyPayload(p);
    window.renderAll();
}, payload);
const state = () => page.evaluate(() => JSON.parse(JSON.stringify({
    ids: window.students.map((s) => s.id),
    schedule: window.schedule,
    history: window.scheduleHistory,
    attendance: window.attendance,
    progress: window.studentProgress,
    assessments: window.assessments.map((a) => a.studentId),
    triage: window.trijazenTestovi.map((t) => t.studentId)
})));

try {
    console.log('\nДневнички id 0');
    await open();

    // ── the control: without the repair, this is the click that is refused ────
    await load(build());
    const after = await state();
    const id = after.ids[1];
    check('the pupil has a real number now', typeof id === 'number' && id > 0, `got ${JSON.stringify(id)}`);
    checkEq('the other pupil keeps theirs', after.ids[0], 1001);
    checkEq('the term follows', after.schedule.tuesday[2], [id]);
    checkEq('a shared term keeps its order', after.schedule.thursday[1], [1001, id]);
    checkEq('a past week follows', after.history[LAST_WEEK].tuesday[2], [id]);
    checkEq('the marks follow', Object.keys(after.attendance['2026-09-22']), [String(id)]);
    check('the progress follows', Array.isArray(after.progress[id]?.['9001']) && after.progress[id]['9001'].length === 1 && !('0' in after.progress));
    checkEq('the assessments follow, and only that pupil\'s', after.assessments, [id, 1001]);
    checkEq('the triage tests follow', after.triage, [id]);

    // ── the square that used to answer "Missing data for this slot" ───────────
    await page.waitForSelector(`.attendance-indicator[data-sid="${id}"][data-day="tuesday"][data-time="2"]`);
    await page.waitForTimeout(50);       // the handlers are attached on the next tick
    await page.click(`.attendance-indicator[data-sid="${id}"][data-day="tuesday"][data-time="2"]`);
    checkEq('one click on the square marks the pupil present, not absent', await page.evaluate(([d, s]) => window.attendance[d]?.[s]?.['tuesday-2']?.status, [TUESDAY, id]), 'present');
    check('and nothing was refused', !dialogs.some((d) => /Missing data/.test(d)), dialogs.join(' | '));

    // ── a second load must not move the number again ──────────────────────────
    // The diary keeps its state in IndexedDB and reads it back after the page is up.
    await open();
    await page.waitForFunction(() => Array.isArray(window.students) && window.students.length === 2, null, { timeout: 10000 }).catch(() => {});
    const reloaded = await state();
    checkEq('the new number was saved: a reload brings the same one', reloaded.ids, [1001, id]);
    checkEq('and the mark made under it', reloaded.attendance[TUESDAY]?.[id]?.['tuesday-2']?.status, 'present');

    // ── two with id 0: whose records are under 0 is not known ─────────────────
    const two = build();
    two.students.push({ id: 0, name: 'Пробен Втор', grade: 'VI', kind: 'internal', disabilityType: '', planId: 9001 });
    await load(two);
    const left = await state();
    checkEq('two pupils with id 0 are left as they were', left.ids, [1001, 0, 0]);
    checkEq('and so is their term', left.schedule.tuesday[2], [0]);

    // ── the database must not hand out 0 again ────────────────────────────────
    checkEq('a row whose sdnevnik_id is 0 has no diary number',
        await page.evaluate(() => [0, '0', null, '', '1001'].map((v) => window.annualRosterStudentId({ sdnevnik_id: v }))),
        [null, null, null, null, 1001]);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
