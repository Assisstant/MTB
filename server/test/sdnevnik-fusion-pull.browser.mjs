/**
 * „⬇ Земи од базата" in S-Dnevnik: one click brings the diary in line with the
 * database it belongs to, and never guesses who a pupil is.
 *
 * Self-contained: the page and its scripts are read from disk and served on a
 * fake localhost origin (so the diary treats that origin as its server), and
 * every API call is answered here. Nothing reaches a real server or database.
 * All names are invented. CHROME can select an installed browser.
 *
 *   node test/sdnevnik-fusion-pull.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3999';
const ME = 'Терапевт Пример';
const SERVED = {
    'S-Dnevnik.html': 'text/html; charset=utf-8',
    'mtb-runtime.js': 'application/javascript',
    'home-button.js': 'application/javascript',
    'app-navigation.js': 'application/javascript',
    'mtb-theme.js': 'application/javascript'
};

const emptyWeek = () => ({
    monday: [[], [], [], [], []], tuesday: [[], [], [], [], []], wednesday: [[], [], [], [], []],
    thursday: [[], [], [], [], []], friday: [[], [], [], [], []]
});

// The diary as it stands before the click.
const diary = () => ({
    students: [
        { id: 101, name: 'V - Ана Тестова', grade: 'V', kind: 'internal', rasporediStudentId: 'RS-A' },
        { id: 102, name: 'Бојана Пробена', grade: 'VI', kind: 'internal' },
        { id: 103, name: 'VI - Вера Измислена', grade: 'VI', kind: 'internal' },
        { id: 104, name: 'II-а - Гоце Пробни', grade: 'II', kind: 'internal' },
        { id: 105, name: 'Дана Двојна', grade: 'III', kind: 'internal' },
        { id: 106, name: 'Дана Двојна', grade: 'VII', kind: 'internal' },
        { id: 109, name: 'Зора Петрова - Јованова', grade: 'VIII', kind: 'internal' },
        // One diary pupil, but TWO children of that name in the database.
        { id: 110, name: 'Ива Близнак', grade: 'III', kind: 'internal' },
        // The same child entered twice in the database: the diary still points
        // at the OLD record, the database gives the diary number to the NEW one.
        { id: 111, name: 'Хана Преместена', grade: 'VII', kind: 'internal', rasporediStudentId: 'RS-OLD' },
        // Same, but the old record is ALSO booked in this plan: no guessing.
        { id: 112, name: 'Тина Двоен', grade: 'VI', kind: 'internal', rasporediStudentId: 'RS-P2OLD' },
        // Same child twice, and the new record has NO diary number (WORK's
        // local shape): must not be added as a second diary pupil.
        { id: 113, name: 'Лука Двапати', grade: 'VIII', kind: 'internal', rasporediStudentId: 'RS-STALE' }
    ],
    archivedStudents: [{ id: 107, name: 'Ѓорѓи Архивски', grade: 'VII', kind: 'internal' }],
    formerCaseloadStudents: [{ id: 108, name: 'Елена Поранешна', grade: 'IV', kind: 'internal', rasporediStudentId: 'RS-G' }],
    schedule: (() => { const w = emptyWeek(); w.friday[4] = [105]; return w; })(),
    scheduleHistory: {}, attendance: {}, plans: [], links: [], studentProgress: {},
    trijazenTestovi: [], student_records: [], audiograms: [], assessments: [], scaleTemplates: []
});

// The annual list in the database. RS-J is booked in Fusion but absent here.
const roster = {
    year: '2026/2027',
    students: [
        { public_id: 'RS-A', sdnevnik_id: '101', name: 'V-а - Ана Тестова', grade: 'V-а', kind: 'internal' },
        { public_id: 'RS-B', sdnevnik_id: '102', name: 'VI-а - Бојана Пробена', grade: 'VI-а', kind: 'internal' },
        { public_id: 'RS-C', sdnevnik_id: null, name: 'VI-а - Вера Измислена', grade: 'VI-а', kind: 'internal' },
        { public_id: 'RS-D', sdnevnik_id: null, name: 'Комбинирана II, III, IV - Гоце Пробни', grade: 'К-2', kind: 'internal' },
        { public_id: 'RS-E', sdnevnik_id: null, name: 'Дана Двојна', grade: 'III', kind: 'internal' },
        { public_id: 'RS-F', sdnevnik_id: null, name: 'VII - Ѓорѓи Архивски', grade: 'VII', kind: 'internal' },
        { public_id: 'RS-G', sdnevnik_id: '108', name: 'Елена Поранешна', grade: 'IV', kind: 'internal' },
        { public_id: 'RS-H', sdnevnik_id: null, name: 'IX-а - Жана Нова', grade: 'IX-а', kind: 'external' },
        { public_id: 'RS-I', sdnevnik_id: null, name: 'Зора Петрова - Јованова', grade: 'VIII', kind: 'internal' },
        { public_id: 'RS-K', sdnevnik_id: null, name: 'III-а - Ива Близнак', grade: 'III-а', kind: 'internal' },
        { public_id: 'RS-L', sdnevnik_id: null, name: 'V-а - Ива Близнак', grade: 'V-а', kind: 'internal' },
        { public_id: 'RS-NEW', sdnevnik_id: '111', name: 'VII - Хана Преместена', grade: 'VII', kind: 'internal' },
        { public_id: 'RS-P2NEW', sdnevnik_id: '112', name: 'VI-а - Тина Двоен', grade: 'VI-а', kind: 'internal' },
        { public_id: 'RS-P2OLD', sdnevnik_id: null, name: 'Тина Двоен', grade: 'VI', kind: 'internal' },
        { public_id: 'RS-FRESH', sdnevnik_id: null, name: 'VIII - Лука Двапати', grade: 'VIII', kind: 'internal' },
        // A SECOND new pupil with no diary number: both must arrive as two children.
        { public_id: 'RS-H2', sdnevnik_id: null, name: 'IX-а - Мила Нова', grade: 'IX-а', kind: 'internal' }
    ]
};

const s = (day, time, pid, name, therapist = ME) =>
    ({ day, time, therapist_id: 1, therapist_name: therapist, student_public_id: pid, student_name: name });
const sessions = {
    year: '2026/2027',
    sessions: [
        s('понеделник', '08:00-08:20', 'RS-B', 'VI-а - Бојана Пробена'),
        s('понеделник', '08:20-08:40', 'RS-C', 'VI-а - Вера Измислена'),
        s('вторник', '08:45-09:25', 'RS-A', 'V-а - Ана Тестова'),
        s('среда', '09:40-10:00', 'RS-D', 'Комбинирана II, III, IV - Гоце Пробни'),
        s('среда', '10:00-10:20', 'RS-D', 'Комбинирана II, III, IV - Гоце Пробни'),
        s('четврток', '10:25-11:05', 'RS-E', 'Дана Двојна'),
        s('четврток', '11:10-11:50', 'RS-F', 'VII - Ѓорѓи Архивски'),
        s('петок', '08:00-08:40', 'RS-G', 'Елена Поранешна'),
        s('петок', '08:45-09:25', 'RS-H', 'IX-а - Жана Нова'),
        s('петок', '09:40-10:20', 'RS-I', 'Зора Петрова - Јованова'),
        s('петок', '10:25-11:05', 'RS-J', 'Непознат Пробен'),
        s('четврток', '08:00-08:40', 'RS-K', 'III-а - Ива Близнак'),
        s('среда', '08:00-08:40', 'RS-NEW', 'VII - Хана Преместена'),
        s('среда', '08:45-09:25', 'RS-P2NEW', 'VI-а - Тина Двоен'),
        s('среда', '11:10-11:50', 'RS-P2OLD', 'Тина Двоен'),
        s('вторник', '08:00-08:40', 'RS-FRESH', 'VIII - Лука Двапати'),
        s('вторник', '09:40-10:20', 'RS-H2', 'IX-а - Мила Нова'),
        s('понеделник', '11:55-12:35', 'RS-A', 'V-а - Ана Тестова'),
        s('понеделник', '08:45-09:25', 'RS-A', 'V-а - Ана Тестова', 'Друг Терапевт'),
        s('вторник', '10:25-11:05', null, null)
    ]
};

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

/** Opens the diary with `payload` applied. `answer` decides each confirm. */
async function open({ rosterStatus = 200, answer = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    const server = { doc: null, version: 0, puts: [], reads: [] };
    const dialogs = [];
    await context.addInitScript((me) => {
        localStorage.setItem('my_therapist_v1', me);
        localStorage.setItem('sdn_local_server_autosync_v1', '0');
    }, ME);
    await context.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
        const file = url.pathname.replace(/^\//, '');
        if (SERVED[file]) {
            return route.fulfill({ status: 200, contentType: SERVED[file], body: await readFile(join(ROOT, file)) });
        }
        if (url.pathname === '/api/state/sdnevnik') {
            if (req.method() === 'PUT') {
                const body = JSON.parse(req.postData() || '{}');
                server.version += 1;
                server.doc = body.payload;
                server.puts.push(body.payload);
                return json(200, { version: server.version, projection: { ok: true } });
            }
            if (!server.doc) return json(404, { error: 'no state' });
            return json(200, { payload: server.doc, version: server.version, updated_at: new Date().toISOString() });
        }
        server.reads.push(url.pathname);
        if (url.pathname === '/api/schedule/sessions') return json(200, sessions);
        if (url.pathname === '/api/roster') return rosterStatus === 200 ? json(200, roster) : json(rosterStatus, { error: 'roster down' });
        if (url.pathname === '/api/health') return json(200, { ok: true });
        return json(404, { error: 'not in fixture' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', async (d) => {
        dialogs.push({ type: d.type(), message: d.message() });
        if (d.type() === 'confirm' && !answer) await d.dismiss(); else await d.accept();
    });
    await page.goto(`${ORIGIN}/S-Dnevnik.html`);
    await page.waitForFunction(() => window.SdnV3 && window.SdnLocalSrv && typeof window.seedScheduleFromDatabase === 'function');
    await page.evaluate((p) => { window.SdnV3.applyPayload(p); window.renderAll(); }, diary());
    return { context, page, server, dialogs, errors };
}

const snapshot = (page) => page.evaluate(() => JSON.stringify({
    students: window.students, former: window.formerCaseloadStudents,
    archived: window.archivedStudents, schedule: window.schedule
}));

const click = async (page, dialogs, expectConfirm = true) => {
    const before = dialogs.length;
    await page.evaluate(() => window.seedScheduleFromDatabase());
    if (expectConfirm) {
        await page.waitForFunction(() => true);
        const start = Date.now();
        while (!dialogs.slice(before).some((d) => d.type === 'confirm') && Date.now() - start < 8000) {
            await page.waitForTimeout(50);
        }
    }
    await page.waitForTimeout(600);
    return dialogs.slice(before);
};

// ── the pure name rule ─────────────────────────────────────────────────────
{
    const { context, page } = await open();
    const keys = await page.evaluate(() => ({
        roman: window.pupilNameKey('VI-а - Вера Измислена'),
        combined: window.pupilNameKey('Комбинирана II, III, IV - Гоце Пробни'),
        preparatory: window.pupilNameKey('подготвителна - Жана Нова (над.)'),
        doubleSurname: window.pupilNameKey('Зора Петрова - Јованова'),
        cyrillicH: window.pupilNameKey('Христина - Пробна'),
        arabic: window.pupilNameKey('4-а - Ана Тестова')
    }));
    console.log('\nname key');
    check('a Roman class prefix is removed', keys.roman === 'вера измислена', keys.roman);
    check('a combined class prefix longer than ten characters is removed', keys.combined === 'гоце пробни', keys.combined);
    check('a preparatory prefix and the (над.) marker are removed', keys.preparatory === 'жана нова', keys.preparatory);
    check('a double surname is NOT mistaken for a class', keys.doubleSurname === 'зора петрова - јованова', keys.doubleSurname);
    check('a first name starting with Х is NOT mistaken for Roman X', keys.cyrillicH === 'христина - пробна', keys.cyrillicH);
    check('an Arabic class prefix is removed', keys.arabic === 'ана тестова', keys.arabic);
    await context.close();
}

// ── the full click, accepted ───────────────────────────────────────────────
{
    const { context, page, server, dialogs, errors } = await open();
    const seen = await click(page, dialogs);
    const confirmText = (seen.find((d) => d.type === 'confirm') || {}).message || '';
    const r = await page.evaluate(() => {
        const byId = (id) => window.students.find((x) => x.id === id);
        // Counted by the raw name, NOT by pupilNameKey: the function under
        // test must not be what decides whether it worked.
        const nameCount = (text) => window.students.filter((x) => String(x.name).includes(text)).length;
        return {
            mon0: window.schedule.monday[0], tue1: window.schedule.tuesday[1], wed2: window.schedule.wednesday[2],
            thu3: window.schedule.thursday[3], thu4: window.schedule.thursday[4],
            fri: window.schedule.friday, mon4: window.schedule.monday[4],
            bridges: { 102: byId(102)?.rasporediStudentId, 103: byId(103)?.rasporediStudentId,
                104: byId(104)?.rasporediStudentId, 105: byId(105)?.rasporediStudentId,
                106: byId(106)?.rasporediStudentId, 109: byId(109)?.rasporediStudentId,
                110: byId(110)?.rasporediStudentId, 111: byId(111)?.rasporediStudentId,
                112: byId(112)?.rasporediStudentId, 113: byId(113)?.rasporediStudentId },
            wed0: window.schedule.wednesday[0], wed1: window.schedule.wednesday[1],
            wed4: window.schedule.wednesday[4], tue0: window.schedule.tuesday[0],
            lukaCopies: nameCount('Лука Двапати'),
            added2: window.students.find((x) => x.rasporediStudentId === 'RS-H2') || null,
            tue2: window.schedule.tuesday[2],
            ids: window.students.map((x) => x.id),
            added: window.students.find((x) => x.rasporediStudentId === 'RS-H') || null,
            restored: !!window.students.find((x) => x.id === 108),
            stillFormer: (window.formerCaseloadStudents || []).some((x) => x.id === 108),
            archivedBack: window.students.some((x) => x.id === 107),
            goceCopies: nameCount('Гоце Пробни'),
            thu0: window.schedule.thursday[0],
            total: window.students.length
        };
    });
    const pushed = server.puts[server.puts.length - 1];

    console.log('\nconfirmation');
    check('one confirmation is shown', seen.filter((d) => d.type === 'confirm').length === 1, JSON.stringify(seen.map((d) => d.type)));
    check('it names how many terms will be placed', /• 10 термин\(и\) ќе бидат поставени/.test(confirmText), confirmText);
    check('a link by name is shown for the person to check', confirmText.includes('дневник „VI - Вера Измислена" = база „VI-а - Вера Измислена"'));
    check('the combined-class pupil is linked by name, and shown', confirmText.includes('дневник „II-а - Гоце Пробни" = база „Комбинирана II, III, IV - Гоце Пробни"'));
    check('a link by the diary number is NOT listed as a name guess', !confirmText.includes('Бојана Пробена" = база'));
    check('the new pupil is listed as added', /Ќе се додадат[\s\S]*IX-а - Жана Нова/.test(confirmText));
    check('the former pupil is listed as restored', /Ќе се вратат[\s\S]*Елена Поранешна/.test(confirmText));
    check('same-name pupils are refused and said so', confirmText.includes('Дана Двојна — повеќе деца со тоа име'));
    check('an archived pupil is refused and said so', confirmText.includes('VII - Ѓорѓи Архивски — е во архивата'));
    check('a pupil off the annual list is refused and said so', confirmText.includes('Непознат Пробен — не е на годишниот список'));
    check('one diary pupil is NOT guessed between two same-name children in the database',
        confirmText.includes('III-а - Ива Близнак — повеќе деца со тоа име'));
    check('a link the database moved is followed, and said so',
        /1 врска\(и\) преместени според базата[\s\S]*Хана Преместена/.test(confirmText), confirmText);
    check('a moved link is not dressed up as a name guess', !confirmText.includes('Хана Преместена" = база'));
    check('when the old record is also booked, the link is NOT moved',
        confirmText.includes('VI-а - Тина Двоен — во дневникот е поврзан со друг ученик од базата'));
    check('a same-name child on another record is reported, not added',
        confirmText.includes('VIII - Лука Двапати — во дневникот веќе има дете со тоа име'));
    check('the refused terms are counted', /НЕ се ставени \(6 термин\(и\)\)/.test(confirmText), confirmText);
    check('the VI hour the diary does not have is named', /1 термин\(и\) во час што дневникот го нема \(11:55-12:35\)/.test(confirmText));

    console.log('\nwhat landed in the diary');
    check('two halves with two pupils share Monday I', JSON.stringify(r.mon0) === '[102,103]', JSON.stringify(r.mon0));
    check('the bridged pupil is on Tuesday II', JSON.stringify(r.tue1) === '[101]', JSON.stringify(r.tue1));
    check('both halves of one pupil are one entry', JSON.stringify(r.wed2) === '[104]', JSON.stringify(r.wed2));
    check('the combined-class pupil was NOT added a second time', r.goceCopies === 1, String(r.goceCopies));
    check('the ambiguous pupil is not placed', r.thu3.length === 0, JSON.stringify(r.thu3));
    check('the archived pupil is not placed', r.thu4.length === 0, JSON.stringify(r.thu4));
    check('the archived pupil is not brought back', r.archivedBack === false);
    check('the former pupil is restored and placed', r.restored && !r.stillFormer && JSON.stringify(r.fri[0]) === '[108]', JSON.stringify(r.fri[0]));
    check('the new pupil is added with the database identity', !!r.added && r.added.kind === 'external' && JSON.stringify(r.fri[1]) === JSON.stringify([r.added.id]));
    check('the exact double-surname name is linked', JSON.stringify(r.fri[2]) === '[109]', JSON.stringify(r.fri[2]));
    check('the refused pupil off the list is not placed', r.fri[3].length === 0);
    check('a Fusion hour the diary lacks is not forced into another hour', r.mon4.length === 0);
    check('the old Friday plan was replaced', !r.fri[4].includes(105));
    check('bridges are set for number, name and combined links',
        r.bridges[102] === 'RS-B' && r.bridges[103] === 'RS-C' && r.bridges[104] === 'RS-D' && r.bridges[109] === 'RS-I',
        JSON.stringify(r.bridges));
    check('neither of the two same-name pupils got a bridge', !r.bridges[105] && !r.bridges[106]);
    check('the diary pupil with two database namesakes got no bridge and no term',
        !r.bridges[110] && r.thu0.length === 0, JSON.stringify(r.thu0));
    check('the database-moved link is placed on the new record', JSON.stringify(r.wed0) === '[111]' && r.bridges[111] === 'RS-NEW',
        JSON.stringify(r.wed0) + ' ' + r.bridges[111]);
    check('with both records booked, the diary keeps its own link and only that term',
        r.bridges[112] === 'RS-P2OLD' && r.wed1.length === 0 && JSON.stringify(r.wed4) === '[112]',
        JSON.stringify({ b: r.bridges[112], wed1: r.wed1, wed4: r.wed4 }));
    check('a child stored twice is NOT copied into the diary a second time', r.lukaCopies === 1, String(r.lukaCopies));
    check('that child keeps its link and gets no term by guess', r.bridges[113] === 'RS-STALE' && r.tue0.length === 0,
        JSON.stringify({ b: r.bridges[113], tue0: r.tue0 }));
    check('two new pupils without a diary number arrive as TWO children',
        !!r.added && !!r.added2 && r.added.id !== r.added2.id, JSON.stringify([r.added?.id, r.added2?.id]));
    check('no pupil gets diary id 0 from a missing number', !r.ids.includes(0), JSON.stringify(r.ids));
    check('every diary id is unique', new Set(r.ids).size === r.ids.length, JSON.stringify(r.ids));
    check('the second new pupil holds its own term', !!r.added2 && JSON.stringify(r.tue2) === JSON.stringify([r.added2.id]),
        JSON.stringify(r.tue2));
    check('exactly three pupils were added or restored', r.total === 14, String(r.total));

    console.log('\nthe server');
    check('the diary synced with its server BEFORE reading the plan', server.puts.length >= 2, String(server.puts.length));
    check('the plan and the list were read from the same server', server.reads.includes('/api/schedule/sessions') && server.reads.includes('/api/roster'));
    check('the new week actually reached the server', !!pushed && JSON.stringify(pushed.schedule.monday[0]) === '[102,103]',
        pushed ? JSON.stringify(pushed.schedule.monday[0]) : 'no PUT');
    check('the bridges actually reached the server', !!pushed && pushed.students.some((x) => x.id === 104 && x.rasporediStudentId === 'RS-D'));
    check('no page errors', errors.length === 0, errors.join('\n'));
    await context.close();
}

// ── Cancel changes nothing ─────────────────────────────────────────────────
{
    const { context, page, server, dialogs, errors } = await open({ answer: false });
    const before = await snapshot(page);
    await click(page, dialogs);
    const putsAfterPreSync = server.puts.length;
    await page.waitForTimeout(300);
    const after = await snapshot(page);
    console.log('\ncancel');
    check('Cancel leaves pupils, bridges and week exactly as they were', before === after);
    check('Cancel sends nothing after the first sync', server.puts.length === putsAfterPreSync && putsAfterPreSync <= 1, String(server.puts.length));
    check('no page errors', errors.length === 0, errors.join('\n'));
    await context.close();
}

// ── a divergence stops everything ──────────────────────────────────────────
{
    const { context, page, server, dialogs } = await open();
    await page.evaluate(() => { window.SdnLocalSrv.sync = () => Promise.resolve('conflict'); });
    const before = await snapshot(page);
    const seen = await click(page, dialogs, false);
    console.log('\ndivergence');
    check('a divergence shows no plan', !seen.some((d) => d.type === 'confirm'));
    check('a divergence does not even read the plan', !server.reads.includes('/api/schedule/sessions'));
    check('a divergence changes nothing', before === await snapshot(page));
    await context.close();
}

// ── an unreadable list stops everything ────────────────────────────────────
{
    const { context, page, dialogs } = await open({ rosterStatus: 500 });
    const before = await snapshot(page);
    const seen = await click(page, dialogs, false);
    console.log('\nannual list unavailable');
    check('no plan is shown without the annual list', !seen.some((d) => d.type === 'confirm'));
    check('the reason is said', seen.some((d) => d.type === 'alert' && d.message.includes('roster down')), JSON.stringify(seen));
    check('nothing changes without the annual list', before === await snapshot(page));
    await context.close();
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
