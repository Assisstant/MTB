/**
 * Podatoci.html, in a real browser, against a real server.
 *
 *     npm run start                    # in one terminal
 *     npm run test:podatoci
 *
 * Every write is read back from the DATABASE. The two that matter most:
 *
 *   1. A class belongs to a YEAR. Editing 1907/1908 must not touch what
 *      1908/1909 says about the same child — that mistake is invisible on
 *      screen and only shows up next June when an archived crossing names the
 *      wrong lesson.
 *   2. A teacher can hold SEVERAL classes (комбинирани паралелки, and every
 *      class a subject teacher enters). The column this replaced could hold
 *      one, which is why the school's real timetable never fitted in it.
 *
 * Its people are invented and prefixed and it works in school years of its
 * own, so it can share a database with a real school (rule 1). No screenshot:
 * this page lists real children (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const TAG = 'browser-podatoci';
const OLD_YEAR = '1907/1908-pod';
const NEW_YEAR = '1908/1909-pod';
const CLASS_A = 'ПОДАТ-А';
const CLASS_B = 'ПОДАТ-Б';
const CLASS_C = 'ПОДАТ-В';
const TEACHER = `${TAG} Наставник`;
const TEACHER_2 = `${TAG.toUpperCase()} ВТОР НАСТАВНИК`;
const THERAPIST = `${TAG} Терапевт`;
const PAGE_FILE = fileURLToPath(new URL('../../Podatoci.html', import.meta.url));
const NAV_FILE = fileURLToPath(new URL('../../app-navigation.js', import.meta.url));
const REMOTE_A = 'https://zenpc-1.tailc8965f.ts.net';
const REMOTE_B = 'https://zenpc.tailc8965f.ts.net';

const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};
const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q(`DELETE FROM school_years WHERE label IN ($1, $2)`, [OLD_YEAR, NEW_YEAR]);
    await q(`DELETE FROM therapist_students WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM therapists WHERE name LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM teachers WHERE name ILIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM school_classes WHERE label IN ($1, $2, $3)`, [CLASS_A, CLASS_B, CLASS_C]);
}

async function seed() {
    await cleanup();
    const [oldYear] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1907-09-01', '1908-08-31', false) RETURNING id, label`, [OLD_YEAR]);
    const [newYear] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1908-09-01', '1909-08-31', false) RETURNING id, label`, [NEW_YEAR]);
    const madeClasses = new Map();
    for (const [label, key] of [[CLASS_A, '97-а'], [CLASS_B, '97-б'], [CLASS_C, '97-в']]) {
        const [made] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id, label`, [label, key]);
        madeClasses.set(label, made);
    }
    await q(`INSERT INTO teachers (name, kind, subject) VALUES ($1, 'odd', NULL)`, [TEACHER]);
    const [firstTeacher] = await q(`SELECT id, name FROM teachers WHERE name = $1`, [TEACHER]);
    const [secondTeacher] = await q(
        `INSERT INTO teachers (name, kind, subject) VALUES ($1, 'odd', NULL) RETURNING id, name`,
        [TEACHER_2]
    );
    const [therapist] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [THERAPIST]);
    for (const year of [oldYear, newYear]) {
        for (const cls of madeClasses.values()) {
            await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [year.id, cls.id]);
        }
        for (const teacher of [firstTeacher, secondTeacher]) {
            await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [year.id, teacher.id]);
        }
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [year.id, therapist.id]);
    }

    // One child, enrolled in BOTH years, in different classes — which is the
    // ordinary case (they moved up) and the one a year-blind write ruins.
    const people = [
        [`${TAG}-a`, `${TAG} Прва Ученичка`, CLASS_A, CLASS_B, true],
        [`${TAG}-b`, `${TAG} Втор Ученик`,   CLASS_B, CLASS_C, true],
        [`${TAG}-c`, `${TAG} Трет Заминат`,  CLASS_A, CLASS_A, false]
    ];
    for (const [pid, name, oldGrade, newGrade, active] of people) {
        const [s] = await q(
            `INSERT INTO students (public_id, name, grade, active) VALUES ($1, $2, $3, $4) RETURNING id`,
            [pid, name, newGrade, active]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`,
            [s.id, oldYear.id, oldGrade]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`,
            [s.id, newYear.id, newGrade]);
    }
    return { oldYear, newYear, secondTeacher, classA: madeClasses.get(CLASS_A) };
}

const gradeIn = async (yearId, pid) => (await q(
    `SELECT e.grade FROM student_enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.school_year_id = $1 AND s.public_id = $2`, [yearId, pid]))[0]?.grade ?? null;

const run = async () => {
    const { oldYear, newYear, secondTeacher, classA } = await seed();
    console.log(`the lists in a browser — ${OLD_YEAR} and ${NEW_YEAR}\n`);

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 1100 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());

    await page.goto(`${BASE}/Podatoci.html?year=${encodeURIComponent(NEW_YEAR)}`);
    await page.waitForSelector('#students table.list', { timeout: 8000 });

    const rowOf = (pid) => `#students tr[data-student="${pid}"]`;

    console.log('student rows have visible consecutive numbers');
    const studentNumbers = await page.evaluate(() => Array.from(
        document.querySelectorAll('#students tbody td.row-number')
    ).map((cell) => cell.textContent.trim()));
    check('the first column is labelled R.Br.',
        await page.textContent('#students thead th.row-number') === 'Р.Бр.', 'missing student number heading');
    checkEq('numbers follow the visible rows', studentNumbers,
        studentNumbers.map((_, index) => `${index + 1}.`));
    check('numbers are shown by default', await page.isChecked('#showRowNumbers'), 'number toggle starts off');
    await page.uncheck('#showRowNumbers');
    check('one control hides number columns in every list', await page.evaluate(() =>
        getComputedStyle(document.querySelector('#students td.row-number')).display === 'none'), 'student number stayed visible');
    await page.check('#showRowNumbers');

    for (const section of ['teachers', 'therapists', 'classes']) {
        await page.click(`[data-tab="${section}"]`);
        await page.waitForSelector(`#${section} table.list`);
        const numbers = await page.evaluate((selector) => Array.from(
            document.querySelectorAll(`${selector} tbody td.row-number`)
        ).map((cell) => cell.textContent.trim()), `#${section}`);
        check(`${section} has the R.Br. heading`,
            await page.textContent(`#${section} thead th.row-number`) === 'Р.Бр.', section);
        checkEq(`${section} has consecutive numbers`, numbers,
            numbers.map((_, index) => `${index + 1}.`));
    }
    await page.click('[data-tab="students"]');

    // The label of the destructive button is not decoration. It is the one
    // place a person is told WHICH list they are taking somebody off — and
    // this whole screen exists next to an endpoint that really does delete.
    // „Тргни од годината" reads the same on every year and on both.
    console.log('the button says which year it takes somebody off');
    // Asserted against the page's own source rather than a rendered button:
    // the button only exists for the CURRENT year, and this suite works in
    // two years of its own precisely so that it can be run on the machine
    // holding the real school. Flipping `is_current` to make one render would
    // leave that machine pointing at the wrong year if the suite ever died
    // halfway — which is the trap the September notes already warn about.
    const source = await (await fetch(`${BASE}/Podatoci.html`)).text();
    check('no button says only „од годината" any more',
        !source.includes('Тргни од годината'), 'the year-less label is back');
    check('every removal names the year it is removing from',
        (source.match(/Тргни од \$\{esc\(data\.year\)\}/g) || []).length === 4,
        'all four lists — students, teachers, therapists, classes — must say it');
    // And any that do render must agree with the selected year.
    const labels = await page.evaluate(() => Array.from(
        document.querySelectorAll('[data-remove-student],[data-remove-teacher],[data-remove-therapist],[data-remove-class]')
    ).map((b) => b.textContent.trim()));
    check('and none of them contradicts it',
        labels.every((t) => t === `Тргни од ${NEW_YEAR}`), labels.join(' | '));
    // And the name it is next to has to be readable, which was the whole
    // complaint: the class prefix in the real roster makes these long and the
    // column was collapsing to a third of the text.
    const nameWidth = await page.evaluate((pid) =>
        document.querySelector(`#students tr[data-student="${pid}"] .s-name`).getBoundingClientRect().width,
        `${TAG}-a`);
    check('and the name field is wide enough to read a name in', nameWidth >= 240, String(nameWidth));

    console.log('\na class belongs to a year, not to the child');
    await page.fill(`${rowOf(`${TAG}-a`)} .s-name`, `${TAG} Прва Ученичка`);
    await page.selectOption(`${rowOf(`${TAG}-a`)} .s-grade`, CLASS_C);
    await page.click(`${rowOf(`${TAG}-a`)} [data-save-student]`);
    await page.waitForTimeout(800);
    checkEq('the chosen year now says the new class', await gradeIn(newYear.id, `${TAG}-a`), CLASS_C);
    // The one that would be invisible: last year rewritten by this year's screen.
    checkEq('and last year still says what it always said', await gradeIn(oldYear.id, `${TAG}-a`), CLASS_A);

    console.log('\nan archived year can be corrected without touching the live one');
    await page.selectOption('#year', OLD_YEAR);
    await page.waitForTimeout(900);
    const addDisabled = await page.evaluate(() => document.getElementById('addStudent').disabled);
    check('adding a student is refused for a year that is over', addDisabled === true, String(addDisabled));
    check('and the page says why', /архивска година/.test(
        await page.evaluate(() => document.getElementById('studentArchivedNote').textContent)), '');
    await page.selectOption(`${rowOf(`${TAG}-b`)} .s-grade`, CLASS_A);
    await page.click(`${rowOf(`${TAG}-b`)} [data-save-student]`);
    await page.waitForTimeout(800);
    checkEq('the archived year took the correction', await gradeIn(oldYear.id, `${TAG}-b`), CLASS_A);
    checkEq('and the newer year is untouched', await gradeIn(newYear.id, `${TAG}-b`), CLASS_C);

    console.log('\nthe kind is a fact about the year too');
    await page.selectOption('#year', NEW_YEAR);
    await page.waitForTimeout(900);
    await page.selectOption(`${rowOf(`${TAG}-a`)} .s-kind`, 'external');
    await page.click(`${rowOf(`${TAG}-a`)} [data-save-student]`);
    await page.waitForTimeout(800);
    const kindIn = async (yearId, pid) => (await q(
        `SELECT e.kind FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND s.public_id = $2`, [yearId, pid]))[0]?.kind ?? null;
    checkEq('this year says external', await kindIn(newYear.id, `${TAG}-a`), 'external');
    checkEq('and an external child has no hidden class', await gradeIn(newYear.id, `${TAG}-a`), null);
    checkEq('last year is untouched by it', await kindIn(oldYear.id, `${TAG}-a`), 'internal');
    // He thinks of them as „екстерни", so that is what the search box takes.
    await page.fill('#studentSearch', 'екстерен');
    await page.waitForTimeout(300);
    const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#students tr[data-student]')).map((r) => r.dataset.student));
    checkEq('searching by the word finds exactly them', found, [`${TAG}-a`]);
    checkEq('a filtered list is numbered from one', await page.evaluate(() => Array.from(
        document.querySelectorAll('#students tbody td.row-number')
    ).map((cell) => cell.textContent.trim())), ['1.']);
    await page.fill('#studentSearch', '');
    await page.waitForTimeout(300);
    // Put it back, so the assertions further down read what they expect.
    await page.selectOption(`${rowOf(`${TAG}-a`)} .s-kind`, 'internal');
    await page.click(`${rowOf(`${TAG}-a`)} [data-save-student]`);
    await page.waitForTimeout(800);
    await page.selectOption('#year', OLD_YEAR);
    await page.waitForTimeout(900);

    console.log('\na child S-Dnevnik archived remains visible only as history');
    const archived = await page.evaluate((sel) => {
        const row = document.querySelector(sel);
        return row ? { name: row.querySelector('.s-name')?.disabled, save: !!row.querySelector('[data-save-student]') } : null;
    }, rowOf(`${TAG}-c`));
    check('the archived year shows them read-only, without a save action',
        archived?.name === true && archived?.save === false, JSON.stringify(archived));
    check('and they are not offered as a candidate either',
        !(await page.$eval('#studentCandidates', (box) => box.textContent)).includes(`${TAG} Трет Заминат`));

    console.log('\na teacher holds several classes, and they are per year');
    await page.selectOption('#year', NEW_YEAR);
    await page.waitForTimeout(900);
    await page.click('[data-tab="teachers"]');
    await page.waitForTimeout(200);
    await page.click(`#teachers tr:has(input[value="${TEACHER}"]) [data-classes]`);
    await page.waitForSelector('#classPicker.open', { timeout: 4000 });
    await page.check(`#classPicker input[value="${CLASS_A}"]`);
    await page.selectOption(`#classPicker [data-role-for="${CLASS_A}"]`, 'homeroom');
    await page.check(`#classPicker input[value="${CLASS_B}"]`);
    await page.click('#classPicker [data-save-classes]');
    await page.waitForTimeout(900);

    const held = await q(
        `SELECT c.label, tc.role FROM teacher_classes tc
           JOIN school_classes c ON c.id = tc.class_id
           JOIN teachers t ON t.id = tc.teacher_id
          WHERE tc.school_year_id = $1 AND t.name = $2 ORDER BY c.label`,
        [newYear.id, TEACHER]);
    checkEq('both classes are in the database', held.map((r) => `${r.label}:${r.role}`),
        [`${CLASS_A}:homeroom`, `${CLASS_B}:subject`]);
    checkEq('and the other year got none of it',
        (await q(`SELECT count(*)::int AS n FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
                   WHERE tc.school_year_id = $1 AND t.name = $2`, [oldYear.id, TEACHER]))[0].n, 0);
    const chips = await page.evaluate((name) => {
        const row = Array.from(document.querySelectorAll('#teachers tr'))
            .find((r) => r.querySelector('.t-name')?.value === name);
        return Array.from(row.querySelectorAll('.chip')).map((c) => c.textContent + (c.classList.contains('home') ? '*' : ''));
    }, TEACHER);
    checkEq('the screen shows both, the homeroom marked and first', chips, [`${CLASS_A}*`, CLASS_B]);

    checkEq('a Caps Lock name is displayed like S-Dnevnik',
        await page.$eval(`#teachers tr[data-teacher="${secondTeacher.id}"] .t-name`, (input) => input.value),
        'Browser-Podatoci Втор Наставник');

    console.log('\nan existing class changes who holds it, for this year only');
    await page.click('[data-tab="classes"]');
    await page.click(`#classes tr[data-class="${classA.id}"] [data-edit-class-teachers]`);
    await page.waitForSelector('#classEditor.open', { timeout: 4000 });
    check('the form says what it edits instead of calling it rename',
        /Наставници за/.test(await page.$eval('#classEditor', (box) => box.textContent))
        && !(await page.$eval('#classes', (box) => box.textContent)).includes('Преименувај'));
    await page.selectOption('#classHomeroom', String(secondTeacher.id));
    await page.click('#classEditor [data-save-class-teachers]');
    await page.waitForTimeout(900);
    const classStaff = await q(
        `SELECT t.name, tc.role FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
          WHERE tc.school_year_id = $1 AND tc.class_id = $2
          ORDER BY (tc.role = 'homeroom') DESC, t.name`,
        [newYear.id, classA.id]
    );
    checkEq('the new homeroom is the only assignment for that class',
        classStaff.map((teacher) => `${teacher.name}:${teacher.role}`), [`${TEACHER_2}:homeroom`]);
    checkEq('last year still has its own answer',
        (await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND class_id = $2`,
            [oldYear.id, classA.id]))[0].n, 0);
    check('the class row shows the normally-cased new homeroom',
        /Browser-Podatoci Втор Наставник/.test(await page.$eval(
            `#classes tr[data-class="${classA.id}"]`, (row) => row.textContent)));

    console.log('\na caseload changes one tick at a time');
    await page.click('[data-tab="therapists"]');
    await page.waitForTimeout(200);
    await page.click(`#therapists tr:has(input[value="${THERAPIST}"]) [data-caseload]`);
    await page.waitForSelector('#studentPicker.open', { timeout: 4000 });
    await page.check(`#studentPicker input[value="${TAG}-a"]`);
    await page.check(`#studentPicker input[value="${TAG}-b"]`);
    await page.click('#studentPicker [data-save-caseload]');
    await page.waitForTimeout(1000);
    const caseload = async () => (await q(
        `SELECT s.public_id FROM therapist_students ts
           JOIN therapists t ON t.id = ts.therapist_id JOIN students s ON s.id = ts.student_id
          WHERE t.name = $1 AND ts.school_year_id = $2 ORDER BY s.public_id`,
        [THERAPIST, newYear.id])).map((r) => r.public_id);
    checkEq('both children are linked', await caseload(), [`${TAG}-a`, `${TAG}-b`]);

    await page.click(`#therapists tr:has(input[value="${THERAPIST}"]) [data-caseload]`);
    await page.waitForSelector('#studentPicker.open', { timeout: 4000 });
    await page.uncheck(`#studentPicker input[value="${TAG}-a"]`);
    await page.click('#studentPicker [data-save-caseload]');
    await page.waitForTimeout(1000);
    // Unticking must actually remove the link. A caseload that can only grow
    // is how a therapist ends up listed against children they stopped seeing.
    checkEq('unticking really removes one, and leaves the other', await caseload(), [`${TAG}-b`]);
    checkEq('the browser did not write the selected caseload into the old year',
        (await q(
            `SELECT count(*)::int AS n FROM therapist_students ts
             JOIN therapists t ON t.id = ts.therapist_id
             WHERE t.name = $1 AND ts.school_year_id = $2`,
            [THERAPIST, oldYear.id]
        ))[0].n, 0);
    // Scoped to the picker, not the page: the students tab lists the archived
    // child on purpose (locked), so asserting against the whole document would
    // pass or fail for the wrong reason.
    await page.click(`#therapists tr:has(input[value="${THERAPIST}"]) [data-caseload]`);
    await page.waitForSelector('#studentPicker.open', { timeout: 4000 });
    const offered = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#studentPicker input[type=checkbox]')).map((c) => c.value));
    check('an archived child is not even offered a caseload tick',
        !offered.includes(`${TAG}-c`), offered.join(', '));
    check('while the two enrolled ones are', offered.includes(`${TAG}-a`) && offered.includes(`${TAG}-b`), offered.join(', '));

    console.log('\nadding goes to the server, not to a list in the page');
    await page.click('[data-tab="classes"]');
    await page.waitForTimeout(200);
    await page.fill('#newClass', 'ПОДАТ-Г');
    await page.click('#addClass');
    await page.waitForTimeout(800);
    checkEq('the class is in the database',
        (await q(`SELECT count(*)::int AS n FROM school_classes WHERE label = $1`, ['ПОДАТ-Г']))[0].n, 1);
    await q(`DELETE FROM school_classes WHERE label = $1`, ['ПОДАТ-Г']);

    console.log('\nthe page keeps nothing of its own');
    // The rule this guards is that NO SCHOOL DATA lives in a browser -- the
    // database is the only place a child exists. It used to be spelled "storage
    // is empty", which is stricter than the rule and breaks the moment somebody
    // adds a legitimate display preference. Name what is allowed instead, so a
    // school-data key still fails loudly and a reader's font size does not.
    const ALLOWED = ['mtb.ui-size'];

    // Move it first, or the key is never written and the check below proves
    // nothing. This also checks the thing the slider exists for: `--ui` drives
    // `zoom` on <body>, so the layout grows with the letters instead of the
    // columns staying put while the text overflows them.
    const scaled = await page.evaluate(() => {
        const slider = document.getElementById('uiSize');
        if (!slider) return null;
        const before = getComputedStyle(document.documentElement).getPropertyValue('--ui').trim();
        slider.value = '130';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        return { before, after: getComputedStyle(document.documentElement).getPropertyValue('--ui').trim() };
    });
    checkEq('the display-size slider is on the page', scaled !== null, true);
    checkEq('and moving it changes the scale the whole page is drawn at',
        scaled && scaled.after, '1.30');

    const stored = await page.evaluate(() => {
        try {
            return {
                local: Object.keys(localStorage),
                session: Object.keys(sessionStorage)
            };
        } catch (e) { return { local: ['<unreadable>'], session: ['<unreadable>'] }; }
    });
    checkEq('no school data is written to browser storage',
        { local: stored.local.filter((k) => !ALLOWED.includes(k)), session: stored.session },
        { local: [], session: [] });
    checkEq('and the display size is the only thing remembered at all',
        stored.local.filter((k) => ALLOWED.includes(k)), ['mtb.ui-size']);

    console.log('\nthe published page chooses explicitly between the two authorized databases');
    const remoteCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const published = await remoteCtx.newPage();
    const publishedErrors = [];
    published.on('pageerror', (e) => publishedErrors.push(String(e)));
    await published.route('https://assisstant.github.io/MTB/Podatoci.html*', (route) =>
        route.fulfill({ path: PAGE_FILE, contentType: 'text/html; charset=utf-8' }));
    await published.route('https://assisstant.github.io/MTB/app-navigation.js', (route) =>
        route.fulfill({ path: NAV_FILE, contentType: 'text/javascript; charset=utf-8' }));
    const forwardApi = async (route) => {
        const requestUrl = new URL(route.request().url());
        const response = await fetch(BASE + requestUrl.pathname + requestUrl.search);
        await route.fulfill({
            status: response.status,
            headers: {
                'content-type': response.headers.get('content-type') || 'application/json',
                'access-control-allow-origin': 'https://assisstant.github.io'
            },
            body: Buffer.from(await response.arrayBuffer())
        });
    };
    await published.route(`${REMOTE_A}/api/**`, forwardApi);
    await published.route(`${REMOTE_B}/api/**`, forwardApi);
    await published.goto(`https://assisstant.github.io/MTB/Podatoci.html?year=${encodeURIComponent(NEW_YEAR)}`);
    await published.waitForSelector('#serverChoice:not([disabled])', { timeout: 10000 });

    const choices = await published.evaluate(() =>
        Array.from(document.querySelectorAll('#serverChoice option')).map((o) => ({
            value: o.value, text: o.textContent, disabled: o.disabled
        })));
    check('both authorized servers are offered and reachable',
        choices.filter((o) => o.value && !o.disabled).length === 2, JSON.stringify(choices));
    check('when both answer, no database is silently chosen',
        await published.$eval('#serverChoice', (s) => s.value) === '', JSON.stringify(choices));
    check('the page asks which database to use', /избери во која база/.test(
        await published.$eval('#status', (s) => s.textContent)), '');

    await published.selectOption('#serverChoice', REMOTE_A);
    await published.waitForSelector('#students table.list', { timeout: 10000 });
    check('choosing ZenPC-1 loads its database', /ZenPC-1/.test(
        await published.$eval('#status', (s) => s.textContent)), '');

    await published.selectOption('#serverChoice', REMOTE_B);
    await published.waitForFunction(() => document.getElementById('status').textContent.startsWith('ZenPC ·'));
    check('switching to ZenPC reloads through that database', /ZenPC ·/.test(
        await published.$eval('#status', (s) => s.textContent)), '');
    checkEq('only the server choice, never school data, is remembered',
        await published.evaluate(() => ({
            selected: localStorage.getItem('mtb_podatoci_server_v1'),
            session: sessionStorage.length
        })), { selected: REMOTE_B, session: 0 });
    check('navigation follows the selected database server',
        await published.$eval('#mtbAppNav a[title="Распоред на терапевтски кабинети"]',
            (link) => link.href === 'https://zenpc.tailc8965f.ts.net/RasporediFusion.html'), '');
    check('the published page has no errors', publishedErrors.length === 0, publishedErrors.join('\n       '));
    await remoteCtx.close();

    console.log('\nand it is honest when the server is gone');
    await ctx.route('**/api/**', (r) => r.abort());
    await page.click('#refresh');
    await page.waitForTimeout(1200);
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('it says the server is unreachable', /не одговара/.test(status), status);
    check('and explains rather than drawing empty lists',
        /Нема врска со серверот/.test(await page.evaluate(() => document.getElementById('students').innerHTML)), '');

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await cleanup();
    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
