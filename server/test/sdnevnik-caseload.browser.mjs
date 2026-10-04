/**
 * „Мои ученици" in S-Dnevnik is the therapist's list in the database
 * (`SdnCaseload`), in a real browser.
 *
 * Self-contained: the repository files are served from disk by the test and
 * every /api call is invented, so no server and no database is needed and
 * nothing real can be read or written. The people are invented.
 *
 * The owner, 4 Oct 2026: the diary had 20 pupils and Кабинети 15 for the same
 * therapist — a stale duplicate, children no longer on the list, a child only
 * Кабинети had. „Списокот да се чита од едно место и да се менува на едно
 * место." What it holds the diary to:
 *   - nothing changes before the diary and its server agree (a conflict, or a
 *     sync that has not happened, leaves the list alone);
 *   - a pupil is found by the bridge or by the diary number the database
 *     keeps, by name only when the name is unique on both sides — two
 *     children with one name are reported, never guessed;
 *   - name, class and kind come from the database; the list's order is kept;
 *   - a child on the list the diary lacks is added, or restored from former;
 *   - a child not on the list goes to former with its records, unless it is
 *     booked with this therapist in Кабинети — then it stays and is reported,
 *     with „Стави го на списокот";
 *   - „Додади", „Тргни" and the arrows write the database's list through the
 *     same routes as Кабинети, and a refusal (a booked child) is shown and
 *     changes nothing;
 *   - an empty list, or a list with none of the diary's children (the wrong
 *     therapist?), is not applied by itself;
 *   - with no server the diary works as before.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVED = 'http://localhost:4611';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const ME = 'Измислена Терапевтка Списокова';
const OTHER = 'Друг Измислен Терапевт';

const emptyWeek = () => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [[], [], [], [], []]]));
const pupil = (id, name, grade, extra = {}) => ({ id, name, grade, kind: 'internal', disabilityType: '', planId: 9001, ...extra });
const payload = {
    students: [
        pupil(2001, 'Пробна Ана', 'V', { rasporediStudentId: 'c-a' }),                 // bridge; the class changes in the base
        pupil(2002, 'Пробен Бојан', 'II-а', { rasporediStudentId: 'c-b-old' }),         // last year's duplicate
        pupil(2003, 'Пробен Бојан', 'VI-а', { rasporediStudentId: 'c-b' }),             // this year's record
        pupil(2004, 'Пробна Вера', 'VI'),                                                // the base keeps her diary number
        pupil(2005, 'Пробен Горан', 'VII'),                                              // unique name on both sides
        pupil(2006, 'Пробна Дана', 'VI'),                                                // not in the base at all
        pupil(2007, 'Пробен Ѓоко', 'IX-а', { rasporediStudentId: 'c-gj' }),             // booked in Кабинети, not on the list
        pupil(2008, 'Пробен Жарко', 'V'),                                                // two in the diary with one name
        pupil(2009, 'Пробен Жарко', 'VII'),
        pupil(2012, 'Измислен Петкоски', 'VI')                                           // the base spells it Петковски
    ],
    formerCaseloadStudents: [pupil(2010, 'Пробна Поранешна', 'IV', { rasporediStudentId: 'c-f' })],
    schedule: emptyWeek(), scheduleHistory: {},
    attendance: { '2026-09-28': {
        2002: { 'monday-1': { status: 'present', date: '2026-09-28', time: '08:45-09:25' } },
        2006: { 'thursday-3': { status: 'present', date: '2026-10-01', time: '10:25-11:05' } },
        2012: { 'tuesday-0': { status: 'present', date: '2026-09-29', time: '08:00-08:40' } }
    } },
    plans: [{ id: 9001, name: 'Пробна програма', activities: ['Активност'] }],
    links: [], studentProgress: {}, trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
};
payload.schedule.monday[1] = [2002];
payload.schedule.thursday[3] = [2006];

const rows = [
    { public_id: 'c-n', sdnevnik_id: null, name: 'Пробен Нов', grade: 'III-а', kind: 'internal' },
    { public_id: 'c-a', sdnevnik_id: null, name: 'Пробна Ана', grade: 'V-а', kind: 'internal' },
    { public_id: 'c-b', sdnevnik_id: '2003', name: 'Пробен Бојан', grade: 'VI-а', kind: 'internal' },
    { public_id: 'c-v', sdnevnik_id: '2004', name: 'Пробна Вера', grade: 'VI-а', kind: 'internal' },
    { public_id: 'c-g', sdnevnik_id: null, name: 'Пробен Горан', grade: null, kind: 'external' },
    { public_id: 'c-z', sdnevnik_id: null, name: 'Пробен Жарко', grade: 'VII', kind: 'internal' },
    { public_id: 'c-f', sdnevnik_id: '2010', name: 'Пробна Поранешна', grade: 'V-а', kind: 'internal' },
    { public_id: 'c-gj', sdnevnik_id: null, name: 'Пробен Ѓоко', grade: 'IX-а', kind: 'internal' },
    { public_id: 'c-q', sdnevnik_id: null, name: 'Пробна Квета', grade: 'VIII', kind: 'internal' },
    { public_id: 'c-x', sdnevnik_id: null, name: 'Пробен Туѓ', grade: 'II', kind: 'internal' },
    { public_id: 'c-p', sdnevnik_id: null, name: 'Измислен Петковски', grade: 'VI-а', kind: 'internal' }
];
const lists = { [ME]: ['c-n', 'c-a', 'c-b', 'c-v', 'c-g', 'c-z', 'c-f', 'c-p'], [OTHER]: ['c-x'] };
// After the diary's bells: counted for „booked", never drawn into the diary's week.
const sessions = [
    { day: 'петок', time: '13:00-13:40', therapist_id: 7, therapist_name: ME, student_public_id: 'c-gj', student_name: 'Пробен Ѓоко' },
    { day: 'петок', time: '13:45-14:25', therapist_id: 7, therapist_name: ME, student_public_id: 'c-a', student_name: 'Пробна Ана' }
];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const writes = [];
let rosterReads = 0;
let refuseDelete = null;
let down = false;
let stored = null;                 // what /api/state/sdnevnik holds
const dialogs = [];
const errors = [];

await context.addInitScript((me) => {
    localStorage.setItem('sdn_local_server_autosync_v1', '0');
    localStorage.setItem('my_therapist_v1', me);
}, ME);
await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== SERVED) return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/')) {
        if (down) return route.abort('connectionrefused');
        const method = req.method();
        if (method !== 'GET') writes.push(`${method} ${decodeURIComponent(url.pathname)}`);
        if (url.pathname === '/api/roster') {
            rosterReads++;
            return json({ year: '1901/1902-list', students: rows,
                therapists: [{ id: 7, name: ME, students: lists[ME].slice() }, { id: 8, name: OTHER, students: lists[OTHER].slice() }] });
        }
        if (url.pathname === '/api/schedule/sessions') return json({ sessions });
        if (url.pathname === '/api/state/sdnevnik') {
            if (method === 'GET') return stored ? json(stored) : json({ error: 'none' }, 404);
            const body = req.postDataJSON();
            stored = { version: (stored ? stored.version : 0) + 1, payload: body.payload, updated_at: new Date().toISOString() };
            return json({ version: stored.version, projection: { ok: true } });
        }
        const one = /^\/api\/therapists\/([^/]+)\/students\/([^/]+)$/.exec(url.pathname);
        if (one) {
            const name = decodeURIComponent(one[1]);
            const pid = decodeURIComponent(one[2]);
            if (method === 'PUT') { if (!lists[name].includes(pid)) lists[name].push(pid); return json({ ok: true, linked: true }); }
            if (method === 'DELETE') {
                if (refuseDelete) { const answer = refuseDelete; refuseDelete = null; return json(answer, 409); }
                lists[name] = lists[name].filter((x) => x !== pid);
                return json({ ok: true, linked: false });
            }
        }
        const order = /^\/api\/therapists\/([^/]+)\/students-order$/.exec(url.pathname);
        if (order && method === 'PUT') {
            const name = decodeURIComponent(order[1]);
            const wanted = req.postDataJSON().order;
            lists[name] = wanted.filter((pid) => lists[name].includes(pid)).concat(lists[name].filter((pid) => !wanted.includes(pid)));
            return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'index.html');
    if (name === 'mtb-runtime.js') return route.fulfill({ status: 200, contentType: TYPES['.js'], body: 'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;' });
    try {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(name)] || 'application/octet-stream', body: await readFile(path.join(ROOT, name)) });
    } catch { return route.fulfill({ status: 404, body: '' }); }
});

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

const diary = () => page.evaluate(() => window.students.map((s) => `${s.id}|${s.name}|${s.grade}|${s.kind}|${s.rasporediStudentId || ''}`));
const ids = () => page.evaluate(() => window.students.map((s) => s.id));
const formerIds = () => page.evaluate(() => (window.formerCaseloadStudents || []).map((s) => s.id).sort());
const noteText = () => page.textContent('#sdnCaseloadNote');
const synced = (result) => page.evaluate((r) => window.dispatchEvent(new CustomEvent('sdn:synced', { detail: { result: r, auto: true } })), result);

try {
    console.log('\n„Мои ученици" = the list in the database');
    await page.goto(`${SERVED}/S-Dnevnik.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SdnV3 && window.SdnCaseload && window.SdnRun);
    await page.evaluate((p) => {
        localStorage.removeItem('sdnevnik_row_writes_v1');
        window.SdnV3.applyPayload(p);
        if (typeof window.renderAll === 'function') window.renderAll();
        window.switchTab('students');
    }, payload);
    const before = await diary();

    // ── nothing before the diary and its server agree ────────────────────────
    console.log('\nonly after the diary agrees with its server');
    const readsBefore = rosterReads;
    await synced('conflict');
    await page.waitForTimeout(300);
    checkEq('a conflict with the server does not even read the list', rosterReads, readsBefore);
    checkEq('and changes nothing', await diary(), before);
    const stub = await page.evaluate(() => {
        const real = window.SdnLocalSrv.sync;
        window.SdnLocalSrv.sync = () => Promise.resolve('conflict');
        return window.SdnCaseload.follow({ force: true }).then((a) => { window.SdnLocalSrv.sync = real; return a; });
    });
    check('asked by hand while the diary and the server disagree, it says so and waits', /разидени/.test(stub.error || ''), JSON.stringify(stub));
    checkEq('still nothing changed', await diary(), before);

    await synced('insync');
    await page.waitForFunction(() => window.students[0] && window.students[0].name === 'Пробен Нов');

    // ── what the list made of the diary ──────────────────────────────────────
    console.log('\nthe diary follows the list');
    checkEq('the list\'s order, the checks kept at the end, names and classes from the base', (await diary()).slice(1), [
        '2001|Пробна Ана|V-а|internal|c-a',
        '2003|Пробен Бојан|VI-а|internal|c-b',
        '2004|Пробна Вера|VI-а|internal|c-v',
        '2005|Пробен Горан|екстерен|external|c-g',
        '2010|Пробна Поранешна|V-а|internal|c-f',
        // The base's spelling is not found by name (one letter differs), so it
        // comes in as a record of its own — and the pair is put to the person below.
        ...(await diary()).filter((r) => r.endsWith('|c-p')),
        '2007|Пробен Ѓоко|IX-а|internal|c-gj',
        '2008|Пробен Жарко|V|internal|',
        '2009|Пробен Жарко|VII|internal|'
    ]);
    const first = (await diary())[0].split('|');
    check('a child only the base had is added, with a diary number of its own', first[1] === 'Пробен Нов' && first[4] === 'c-n' && Number(first[0]) > 0, first.join('|'));
    checkEq('last year\'s duplicate and children not on the list are former now — the former child is back', await formerIds(), [2002, 2006, 2012]);
    checkEq('their records stay', await page.evaluate(() => Object.keys(window.attendance['2026-09-28']).sort()), ['2002', '2006', '2012']);
    checkEq('and they are out of the live week', await page.evaluate(() => [window.schedule.monday[1], window.schedule.thursday[3]]), [[], []]);
    check('a child booked with this therapist stays, with a way to put it on the list',
        /Пробен Ѓоко.*има термин кај вас во Кабинети/.test(await noteText())
        && await page.$('#sdnCaseloadNote [data-caseload="add"][data-pid="c-gj"]') !== null);
    check('two children with one name are reported, not guessed', /Пробен Жарко.*повеќе записи со тоа име/.test(await noteText()));
    check('what moved is said in words', /додадени од базата — Пробен Нов/.test(await noteText()) && /тргнати меѓу поранешните.*Пробен Бојан, Пробна Дана/.test(await noteText()));
    check('a pupil without its record of its own never shares one', !(await diary()).some((r) => r.startsWith('0|')));
    checkEq('reading the list wrote nothing to the base\'s list', writes.filter((w) => !w.startsWith('PUT /api/state/')), []);

    const again = await diary();
    await page.evaluate(() => window.SdnCaseload.follow({ afterSync: true, force: true }));
    checkEq('reading it again changes nothing', await diary(), again);
    const both = await page.evaluate(() => Promise.all([
        window.SdnCaseload.follow({ afterSync: true, force: true }), window.SdnCaseload.follow({ afterSync: true, force: true })]));
    check('a read asked for while one is running gets that answer, not „не е прочитан"',
        !both[1].skipped && both[1].listed === both[0].listed, JSON.stringify(both));

    // Readable in both themes: the note carries text over its own background.
    const contrast = () => page.$eval('#sdnCaseloadNote', (el) => {
        const rgb = (v) => v.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const s = getComputedStyle(el);
        const a = lum(rgb(s.color)), b = lum(rgb(s.backgroundColor));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    const light = await contrast();
    await page.evaluate(() => { document.body.classList.add('dark-mode'); });
    const dark = await contrast();
    if (process.env.CASELOAD_SHOTS) await page.screenshot({ path: path.join(process.env.CASELOAD_SHOTS, 'caseload-dark.png'), fullPage: false });
    await page.evaluate(() => { document.body.classList.remove('dark-mode'); });
    if (process.env.CASELOAD_SHOTS) await page.screenshot({ path: path.join(process.env.CASELOAD_SHOTS, 'caseload-light.png'), fullPage: false });
    check('the note reads at 4.5:1 or better in both themes', light >= 4.5 && dark >= 4.5, `light ${light.toFixed(2)}, dark ${dark.toFixed(2)}`);

    // ── one child, two records: asked, never guessed ──────────────────────────
    console.log('\nduplicates');
    checkEq('names one letter apart, or in the other order, look alike; short or different names do not', await page.evaluate(() => [
        window.namesLookAlike('Измислен Петкоски', 'Измислен Петковски'),
        window.namesLookAlike('Петковски Измислен', 'Измислен Петкоски'),
        window.namesLookAlike('IV-а - Пробен Бојан', 'Пробен Бојан'),
        window.namesLookAlike('Пробна Ана', 'Пробна Ања'),
        window.namesLookAlike('Пробен Нов', 'Пробна Квета'),
        window.namesLookAlike('Измислен Петкоски', 'Измислена Петковска')
    ]), [true, true, true, false, false, false]);
    const pairs = () => page.$$eval('#sdnDuplicatesNote [data-duplicate]', (rows) => rows.map((r) => r.getAttribute('data-duplicate')));
    const newP = await page.evaluate(() => window.students.find((s) => s.rasporediStudentId === 'c-p').id);
    checkEq('three pairs are put to the person: the one on the base\'s list stays', (await pairs()).sort(),
        ['2003|2002', '2008|2009', `${newP}|2012`].sort());
    checkEq('and nothing was merged by itself', (await formerIds()).includes(2012), true);

    await page.click(`#sdnDuplicatesNote [data-caseload="merge"][data-gone="2012"]`);
    await page.waitForFunction(() => !(window.formerCaseloadStudents || []).some((s) => s.id === 2012));
    check('„Спои ги" asks first, naming which record stays',
        dialogs.some((d) => /Да се спојат во еден запис\?[\s\S]*Останува:\s+Измислен Петковски[\s\S]*Се влева во него:\s+Измислен Петкоски/.test(d)));
    checkEq('the old record\'s marks are on the one that stays', await page.evaluate((id) => Object.keys(window.attendance['2026-09-28'][id] || {}), newP), ['tuesday-0']);
    check('and the old record is gone from every list', await page.evaluate(() =>
        !window.students.concat(window.formerCaseloadStudents, window.archivedStudents || []).some((s) => s.id === 2012)
        && !window.attendance['2026-09-28'][2012]));
    checkEq('the record that stays keeps the base\'s name and link', (await diary()).find((r) => r.startsWith(`${newP}|`)).split('|').slice(1),
        ['Измислен Петковски', 'VI-а', 'internal', 'c-p']);

    await page.click(`#sdnDuplicatesNote [data-caseload="merge"][data-gone="2002"]`);
    await page.waitForFunction(() => !(window.formerCaseloadStudents || []).some((s) => s.id === 2002));
    checkEq('last year\'s duplicate merges into this year\'s record', await page.evaluate(() => Object.keys(window.attendance['2026-09-28'][2003] || {})), ['monday-1']);

    await page.click(`#sdnDuplicatesNote [data-caseload="not-same"][data-gone="2009"]`);
    await page.waitForFunction(() => !document.getElementById('sdnDuplicatesNote'));
    check('„Не се исти" is remembered and not asked again', await page.evaluate(() => window.likelyDuplicates({}).length === 0)
        && (await ids()).includes(2008) && (await ids()).includes(2009));

    // A pair the names do not give away is merged by hand, from „Измени".
    await page.evaluate(() => window.editStudent(window.students.findIndex((s) => s.id === 2008)));
    await page.selectOption('#studentMergeWith', '2009');
    await page.evaluate(() => window.saveStudent());
    await page.waitForFunction(() => window.students.filter((s) => s.name === 'Пробен Жарко').length === 1);
    check('„Истото дете е запишано уште еднаш како…" merges, after the same question',
        dialogs.filter((d) => /Да се спојат во еден запис\?/.test(d)).length === 3);

    // ── putting a booked child on the list ───────────────────────────────────
    console.log('\nwriting the list from the diary');
    await page.click('#sdnCaseloadNote [data-caseload="add"][data-pid="c-gj"]');
    await page.waitForFunction(() => !document.querySelector('#sdnCaseloadNote [data-caseload-issue="booked"]'));
    check('„Стави го на списокот" writes the base\'s list through the caseload route', writes.includes(`PUT /api/therapists/${ME}/students/c-gj`));
    check('and the child is simply on the list now', lists[ME].includes('c-gj'));

    // „Тргни" on a booked child: the base refuses, the diary says why and keeps the child.
    const ana = (await ids()).indexOf(2001);
    refuseDelete = { error: 'Ученикот има термин кај овој терапевт (петок 13:45-14:25). Прво ослободете го терминот во „Термини“, па тргнете го од листата.', booked: ['петок 13:45-14:25'] };
    const dialogsBefore = dialogs.length;
    await page.evaluate((i) => window.deleteStudent(i), ana);
    await page.waitForTimeout(400);
    check('it asks first', /Да се тргне „Пробна Ана“ од вашиот список/.test(dialogs[dialogsBefore] || ''));
    check('„Тргни" on a booked child is refused in the base\'s words', dialogs.some((d) => /Не е тргнат: Ученикот има термин/.test(d)));
    check('and the child is still on both lists', lists[ME].includes('c-a') && (await ids()).includes(2001));

    // The term is emptied in Кабинети; now the base lets the child go.
    sessions.splice(sessions.findIndex((s) => s.student_public_id === 'c-a'), 1);
    await page.evaluate((i) => window.deleteStudent(i), (await ids()).indexOf(2001));
    await page.waitForFunction(() => !window.students.some((s) => s.id === 2001));
    check('„Тргни" otherwise takes the child off the base\'s list', !lists[ME].includes('c-a') && writes.includes(`DELETE /api/therapists/${ME}/students/c-a`));
    check('and the diary follows: former, records kept', (await formerIds()).includes(2001));

    // The arrows: the order of the base's list.
    const order0 = await ids();
    await page.evaluate(() => window.moveStudent(0, 1));
    await page.waitForFunction((o) => window.students[0].id === o[1], order0);
    checkEq('an arrow swaps the two in the diary', (await ids()).slice(0, 2), [order0[1], order0[0]]);
    checkEq('and in the base\'s list, in the same order', lists[ME].slice(0, 2), ['c-b', 'c-n']);

    // „Додади" from the annual list: into the base's list first.
    await page.evaluate(() => window.showAddStudentModal());
    check('no hand-typed pupil while the diary follows the base', await page.$eval('#studentAddManualMode', (b) => getComputedStyle(b).display === 'none'));
    check('and the picker says where „Додади" writes', await page.isVisible('#annualRosterFromBase'));
    await page.evaluate(() => window.closeModal('addStudentModal'));
    await page.evaluate((row) => window.addStudentFromAnnualRoster(row), rows.find((r) => r.public_id === 'c-q'));
    await page.waitForFunction(() => window.students.some((s) => s.rasporediStudentId === 'c-q'));
    check('„Додади" puts the child on the base\'s list, and the diary takes it from there', lists[ME].includes('c-q'));

    // The name and class of a pupil from the base are changed there.
    await page.evaluate(() => window.editStudent(0));
    check('the edit form shows the name and class read-only, and says where they change',
        await page.$eval('#studentName', (i) => i.readOnly) && await page.$eval('#studentGrade', (i) => i.readOnly)
        && await page.isVisible('#studentNameFromBase'));
    await page.evaluate(() => window.closeModal('addStudentModal'));

    // A change made in Кабинети reaches the diary on the next read.
    lists[ME] = lists[ME].filter((pid) => pid !== 'c-v');
    await page.click('#sdnCaseloadNote [data-caseload="refresh"]');
    await page.waitForFunction(() => !window.students.some((s) => s.id === 2004));
    check('a child taken off in Кабинети leaves „Мои ученици" at the next read', (await formerIds()).includes(2004));

    // ── what is never applied by itself ──────────────────────────────────────
    console.log('\nguards');
    const held = await diary();
    const saved = lists[ME];
    lists[ME] = [];
    await page.click('#sdnCaseloadNote [data-caseload="refresh"]');
    await page.waitForFunction(() => /список во базата е празен/.test(document.getElementById('sdnCaseloadNote').textContent));
    checkEq('an empty list in the base empties nothing', await diary(), held);
    lists[ME] = saved;

    await page.evaluate((o) => localStorage.setItem('my_therapist_v1', o), OTHER);
    await page.click('#sdnCaseloadNote [data-caseload="refresh"]');
    await page.waitForFunction(() => /нема ниту едно дете од овој дневник/.test(document.getElementById('sdnCaseloadNote').textContent));
    checkEq('a list with none of the diary\'s children (the wrong therapist?) is not applied', await diary(), held);
    await page.evaluate((m) => localStorage.setItem('my_therapist_v1', m), ME);

    down = true;
    await page.click('#sdnCaseloadNote [data-caseload="refresh"]');
    await page.waitForFunction(() => /Не е прочитан сега/.test(document.getElementById('sdnCaseloadNote').textContent));
    checkEq('with the server down the diary keeps the last list', await diary(), held);
    down = false;

    // ── no server: the diary as it always was ────────────────────────────────
    console.log('\nno server');
    const writesBefore = writes.length;
    await page.evaluate(() => { window.SdnLocalSrv.getUrl = () => ''; window.renderStudentListSimple(); });
    check('no note about the base', await page.$('#sdnCaseloadNote') === null);
    const local = await ids();
    await page.evaluate(() => window.moveStudent(0, 1));
    checkEq('the arrows work in the diary alone', (await ids()).slice(0, 2), [local[1], local[0]]);
    checkEq('and send nothing', writes.length, writesBefore);

    checkEq('no page errors', errors, []);
} finally {
    await browser.close();
}

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
