/**
 * „По наставник · цела недела" in NastavaUredi.html — the grid a NEW timetable
 * is actually typed into: teachers down the page, the week across it, and the
 * class picked from a dropdown in the cell.
 *
 *     npm run start                        # in one terminal
 *     npm run test:nastava-week
 *
 * Every write is read back from the DATABASE, never from what the page thinks
 * it did. Three things here would each look fine on screen while being wrong:
 *
 *   1. A row per teacher ON THE STAFF LIST, not per teacher who happens to have
 *      a lesson. On the morning a fresh year is typed in, nobody has a lesson —
 *      a grid built from the lessons would open empty and stay empty, which is
 *      exactly the fault that was fixed for the read-only page on 9 September.
 *   2. A weekly cell key must carry the DAY. The same class and period exist
 *      five times a week, so a Friday cell that writes into Monday's lesson is
 *      entirely plausible on screen and wrong in the table.
 *   3. Moving a teacher to another class must FREE the first one. Asserting the
 *      new row exists proves nothing on its own; the old row is the bug.
 *
 * It works in a school year of its own, with invented names (rule 1), so it can
 * share a database with a real school. It writes NO screenshot: this page lists
 * real teacher names and a PNG of it has no business near a public repository
 * (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const TAG = 'browser-week';
const YEAR = '1907/1908-week';
const A = 'ПРОБНА-НЕД-А';
const B = 'ПРОБНА-НЕД-Б';
const T1 = `${TAG} Прва Пробна`;
const T2 = `${TAG} Втора Пробна`;
const T3 = `${TAG} Трета Пробна`;
const DESC_A = 'ученици со проба';

const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};
const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM school_classes WHERE label IN ($1, $2)', [A, B]);
    await q('DELETE FROM teachers WHERE name LIKE $1', [`${TAG}%`]);
    // Migration 035 keeps a staff identity when the profile goes, on purpose;
    // the fixture's must go too, or check:names learns these invented names.
    await q(`DELETE FROM employees e WHERE e.name ILIKE ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_roles x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_year_details x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_identity_links x WHERE x.source_id = e.id OR x.target_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.superseded_by = e.id)`, [[`${TAG}%`]]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1907-09-01', '1908-08-31', false) RETURNING id, label`, [YEAR]);
    const classes = {};
    for (const [label, sort] of [[A, '01-а'], [B, '01-б']]) {
        const [c] = await q(
            'INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id', [label, sort]);
        await q(
            `INSERT INTO class_years (school_year_id, class_id, active, description)
             VALUES ($1, $2, true, $3)`,
            [year.id, c.id, label === A ? DESC_A : null]);
        classes[label] = c.id;
    }
    const teachers = {};
    for (const name of [T1, T2]) {
        const [t] = await q(
            "INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id", [name]);
        await q(
            `INSERT INTO teacher_years (school_year_id, teacher_id, active)
             VALUES ($1, $2, true)`, [year.id, t.id]);
        teachers[name] = t.id;
    }
    return { year, classes, teachers };
}

/** Lessons in the suite's own year, as a person would read them. */
async function lessons(yearId) {
    return q(
        `SELECT l.day, l.ordinal, c.label AS class, t.name AS teacher, l.subject, l.day_order
         FROM lessons l
         JOIN school_classes c ON c.id = l.class_id
         LEFT JOIN teachers t ON t.id = l.teacher_id
         WHERE l.school_year_id = $1
         ORDER BY l.day_order, l.ordinal, c.label`, [yearId]);
}

/** The cell for one teacher row, one day, one period. */
function cellOf(page, teacher, day, ordinal) {
    return page.locator(`#grid td.wk[data-teacher="${teacher}"][data-day="${day}"][data-ordinal="${ordinal}"]`);
}

async function pickInCell(page, teacher, day, ordinal, value) {
    await cellOf(page, teacher, day, ordinal).click();
    await page.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
    await page.selectOption('#grid td.wk select.pick', value);
    await page.waitForTimeout(900);
}

async function run() {
    const { year, classes, teachers } = await seed();
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const page = await browser.newPage();
    // Only real JavaScript faults. A console listener would also catch the
    // browser's own "Failed to load resource: 409" line from the refusal this
    // suite deliberately provokes, and a test that fails on its own fixture
    // teaches people to ignore it.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    try {
        await page.goto(`${BASE}/NastavaUredi.html?year=${encodeURIComponent(YEAR)}`);
        await page.waitForSelector('#grid table', { timeout: 15000 });
        // The views became tabs on 24 Sep 2026; the dropdown is gone.
        await page.click('[data-view="teacher"]');
        await page.waitForSelector('#grid table.week', { timeout: 15000 });

        console.log('\nевери наставник добива ред, дури и без ниту еден час');
        const rowNames = await page.locator('#grid table.week tbody tr th.who').allTextContents();
        const trimmed = rowNames.map((s) => s.trim());
        checkEq('обата наставника се на списокот, иако распоредот е празен', trimmed.sort(), [T1, T2].sort());
        checkEq('и базата навистина нема ниту еден час', (await lessons(year.id)).length, 0);
        const dayHidden = await page.evaluate(() => document.getElementById('dayField').style.display === 'none');
        check('изборот на ден е скриен — за недела не се бира ден', dayHidden);

        console.log('\nпаѓачкото ги разликува одделенијата по опис');
        await cellOf(page, T1, 'понеделник', 1).click();
        await page.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
        const options = (await page.locator('#grid td.wk select.pick option').allTextContents()).map((s) => s.trim());
        check('празната можност е прва', options[0] === '— слободен —', options.join(' | '));
        check('одделението со опис го носи описот во ставката', options.includes(`${A} · ${DESC_A}`), options.join(' | '));
        check('одделението без опис е само ознаката', options.includes(B), options.join(' | '));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        console.log('\nизбирање одделение запишува во базата');
        await pickInCell(page, T1, 'понеделник', 1, A);
        let rows = await lessons(year.id);
        checkEq('точно еден час е запишан', rows.length, 1);
        checkEq('со точен ден, час, одделение и наставник',
            { day: rows[0].day, ordinal: rows[0].ordinal, class: rows[0].class, teacher: rows[0].teacher },
            { day: 'понеделник', ordinal: 1, class: A, teacher: T1 });
        check('day_order е пополнет, инаку часот никогаш не влегува во вкрстувањето', rows[0].day_order === 1,
            `day_order = ${rows[0].day_order}`);

        console.log('\nпетокот не е понеделник');
        await pickInCell(page, T1, 'петок', 1, B);
        rows = await lessons(year.id);
        checkEq('сега има два часа', rows.length, 2);
        const fri = rows.find((r) => r.day === 'петок');
        const mon = rows.find((r) => r.day === 'понеделник');
        checkEq('петочната ќелија запиша во петок', fri ? fri.class : null, B);
        checkEq('а понеделничката остана недопрена', mon ? mon.class : null, A);

        console.log('\nпреместување во друго одделение го ослободува претходното');
        await pickInCell(page, T1, 'понеделник', 1, B);
        rows = await lessons(year.id);
        const monday = rows.filter((r) => r.day === 'понеделник');
        checkEq('понеделник има само еден час, не два', monday.length, 1);
        checkEq('и тоа новото одделение', monday[0].class, B);
        check('стариот ред е избришан, не оставен покрај новиот',
            !rows.some((r) => r.day === 'понеделник' && r.class === A));

        console.log('\nзафатено одделение кај друг наставник се одбива');
        const before = await lessons(year.id);
        await pickInCell(page, T2, 'понеделник', 1, B);
        const after = await lessons(year.id);
        checkEq('ништо не е запишано', after.length, before.length);
        check('вториот наставник нема час тогаш',
            !after.some((r) => r.teacher === T2 && r.day === 'понеделник' && r.ordinal === 1));
        const said = (await page.locator('#status').textContent()).trim();
        check('и страницата кажува кој е веќе таму', /веќе има час/.test(said), said);

        console.log('\n„— слободен —" го брише часот');
        await pickInCell(page, T1, 'петок', 1, '');
        rows = await lessons(year.id);
        check('петокот е испразнет', !rows.some((r) => r.day === 'петок'), JSON.stringify(rows));

        console.log('\nописот на одделението се менува од екран и важи само за таа година');
        const descInput = page.locator(`#classes input[data-desc-id]`).first();
        await page.locator('#classSection summary').click();
        await page.waitForTimeout(300);
        await descInput.fill('сменет опис');
        await page.locator('#classes [data-savedesc]').first().click();
        await page.waitForTimeout(900);
        const [saved] = await q(
            `SELECT cy.description FROM class_years cy
             JOIN school_classes c ON c.id = cy.class_id
             WHERE cy.school_year_id = $1 AND c.label = $2`, [year.id, A]);
        checkEq('новиот опис е во базата', saved.description, 'сменет опис');

        console.log('\nимето за годината е истото што го пишува Податоци (class_years.alias)');
        await page.locator(`#classes input[data-alias-id]`).first().fill('Измислена паралелка');
        await page.locator('#classes [data-savedesc]').first().click();
        await page.waitForTimeout(900);
        const [named] = await q(
            `SELECT cy.alias, cy.description FROM class_years cy
             JOIN school_classes c ON c.id = cy.class_id
             WHERE cy.school_year_id = $1 AND c.label = $2`, [year.id, A]);
        checkEq('името е во истата колона', named.alias, 'Измислена паралелка');
        checkEq('а описот не е допрен', named.description, 'сменет опис');
        const shown = await page.locator('#classes tbody tr').first().textContent();
        check('ознаката останува, само се прикажува под името', shown.includes('ознака: ' + A), shown);

        console.log('\nстраницата не чува ништо свое');
        const stored = await page.evaluate(() => {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out[k] = (localStorage.getItem(k) || '').slice(0, 40);
            }
            return out;
        });
        // The author's credit is remembered on purpose (the watermark without a
        // server, 27 Sep 2026) — named, as in test:podatoci, not matched loosely.
        const CREDIT = ['mtb_author_v1', 'mtb_author_look_v1'];
        const schoolish = Object.keys(stored).filter((k) => !/theme|mtb_server|mtb_scale|display/i.test(k) && !CREDIT.includes(k));
        checkEq('ниту еден училишен податок во localStorage', schoolish, []);

        check('нема JavaScript грешки на страницата', errors.length === 0, errors.join(' ;; '));

        // Owner, 27 Sep 2026: „Личен распоред" in Настава ↔ терапии takes the
        // lesson in the cell, as Кабинети does — only while „✏️ Уреди" is on,
        // and through the same teacher-lesson route as the grid above.
        console.log('\n✏️ „Личен распоред": часот се избира во ќелијата');
        const own = await browser.newContext();
        await own.addInitScript(() => { try { localStorage.setItem('mtb_editing_v1', '1'); } catch (_) { /* test */ } });
        const np = await own.newPage();
        const npErrors = [];
        np.on('pageerror', (e) => npErrors.push(String(e)));
        np.on('dialog', (d) => d.dismiss());
        await np.goto(`${BASE}/Nastava.html?year=${encodeURIComponent(YEAR)}&view=personal`);
        await np.waitForSelector(`#who option[value="${T2}"]`, { state: 'attached', timeout: 15000 });
        await np.selectOption('#who', T2);
        const sheet = `.personal[data-teacher="${T2}"]`;
        await np.waitForSelector(`${sheet} td.p-cell`, { timeout: 15000 });
        checkEq('со вклучено уредување листот ги има сите пет дена, и празни',
            await np.locator(`${sheet} thead th`).count(), 6);
        const cell = (day, ordinal) => `${sheet} td.p-cell[data-day="${day}"][data-ordinal="${ordinal}"]`;
        const lessonAt = async (day, ordinal) => (await lessons(year.id))
            .filter((r) => r.teacher === T2 && r.day === day && r.ordinal === ordinal);
        const settle = async (test) => { for (let i = 0; i < 30 && !(await test()); i++) await np.waitForTimeout(200); };

        check('празен час е еден избор, без предмет', await np.locator(`${cell('петок', 6)} select`).count() === 1);
        await np.selectOption(`${cell('петок', 6)} select.p-class`, B);
        await settle(async () => (await lessonAt('петок', 6)).length === 1);
        checkEq('паралелката е запишана во базата — на тој наставник, тој ден, тој час',
            (await lessonAt('петок', 6)).map((r) => r.class), [B]);
        await np.waitForSelector(`${cell('петок', 6)} select.p-subj`, { timeout: 8000 });
        const subject = await np.$eval(`${cell('петок', 6)} select.p-subj`, (s) => [...s.options].map((o) => o.value).find(Boolean) || '');
        check('потоа се нуди предмет', Boolean(subject));
        await np.selectOption(`${cell('петок', 6)} select.p-subj`, subject);
        await settle(async () => ((await lessonAt('петок', 6))[0] || {}).subject === subject);
        checkEq('и предметот е во базата', (await lessonAt('петок', 6)).map((r) => r.subject), [subject]);
        check('во печатење останува текст, не избор', await np.evaluate(() => {
            const s = [...document.styleSheets].flatMap((x) => { try { return [...x.cssRules]; } catch (_) { return []; } });
            return s.some((r) => r.media && /print/.test(r.media.mediaText) && /\.p-edit/.test(r.cssText) && /display:\s*none/.test(r.cssText));
        }));

        // Behind the page's back: the cell it shows as empty is taken meanwhile.
        await np.waitForSelector(`${cell('четврток', 5)} select.p-class`, { timeout: 8000 });
        await q(`INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
                 VALUES ($1, 'четврток', 4, 5, $2, $3, 'од друг прозорец')`, [year.id, classes[B], teachers[T2]]);
        await np.selectOption(`${cell('четврток', 5)} select.p-class`, A);
        await np.waitForTimeout(1500);
        checkEq('сменет во меѓувреме: се одбива, не се презапишува',
            (await lessonAt('четврток', 5)).map((r) => `${r.class}:${r.subject}`), [`${B}:од друг прозорец`]);
        check('и листот го покажува тоа што стои сега', await np.$eval(`${cell('четврток', 5)} select.p-class`, (s) => s.value) === B);

        await np.selectOption(`${cell('петок', 6)} select.p-class`, '');
        await settle(async () => (await lessonAt('петок', 6)).length === 0);
        checkEq('„— слободен —" го брише часот', (await lessonAt('петок', 6)).length, 0);

        await np.evaluate(() => {
            localStorage.removeItem('mtb_editing_v1');
            window.dispatchEvent(new StorageEvent('storage', { key: 'mtb_editing_v1' }));
        });
        await np.waitForTimeout(400);
        check('исклучено уредување: листот е пак хартија, нема што да се притисне',
            await np.locator(`${sheet} .p-edit`).count() === 0 && await np.locator(sheet).count() === 1);
        check('нема JavaScript грешки во Личен распоред', npErrors.length === 0, npErrors.join(' ;; '));
        await own.close();

        // Owner, 27 Sep 2026: an одделенски наставник's class is fixed and only
        // the subject is picked; a предметен наставник picks the паралелка and
        // the subject is one of their own.
        console.log('\nкој што бира: одделенскиот само предмет, предметниот паралелка');
        await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
                 VALUES ($1, $2, $3, 'homeroom')
                 ON CONFLICT (school_year_id, teacher_id, class_id) DO UPDATE SET role = 'homeroom'`, [year.id, teachers[T1], classes[A]]);
        const [t3] = await q("INSERT INTO teachers (name, kind, subject) VALUES ($1, 'pred', 'Математика, Физика') RETURNING id", [T3]);
        await q('INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)', [year.id, t3.id]);
        const up = await browser.newPage();
        up.on('pageerror', (e) => errors.push(String(e)));
        await up.goto(`${BASE}/NastavaUredi.html?year=${encodeURIComponent(YEAR)}`);
        await up.waitForSelector('#grid table', { timeout: 15000 });
        await up.click('[data-view="teacher"]');
        await up.waitForSelector(`#grid td.wk[data-teacher="${T3}"]`, { timeout: 15000 });
        const byWho = async (who, day, ordinal) => (await lessons(year.id))
            .filter((r) => r.teacher === who && r.day === day && r.ordinal === ordinal);
        const wait = async (test) => { for (let i = 0; i < 30 && !(await test()); i++) await up.waitForTimeout(200); };

        check('празниот час на одделенскиот вели „+ предмет", не „+"',
            /\+ предмет/.test(await cellOf(up, T1, 'четврток', 6).textContent()));
        await cellOf(up, T1, 'четврток', 6).click();
        await up.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
        check('одделенскиот не бира паралелка — се отвора изборот на предмет',
            await up.locator('#grid td.wk select.pick.subj').count() === 1 && await up.locator('#grid td.wk select.pick:not(.subj)').count() === 0);
        const oddSubject = await up.$eval('#grid td.wk select.pick.subj', (sel) => [...sel.options].map((o) => o.value).find((v) => v && v !== '__clear'));
        await up.selectOption('#grid td.wk select.pick.subj', oddSubject);
        await wait(async () => (await byWho(T1, 'четврток', 6)).length === 1);
        checkEq('часот е во неговата паралелка, со избраниот предмет',
            (await byWho(T1, 'четврток', 6)).map((r) => `${r.class}:${r.subject}`), [`${A}:${oddSubject}`]);

        await cellOf(up, T3, 'четврток', 6).click();
        await up.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
        check('предметниот бира паралелка', await up.locator('#grid td.wk select.pick:not(.subj)').count() === 1);
        await up.selectOption('#grid td.wk select.pick', B);
        await up.waitForSelector(`#grid td.wk[data-teacher="${T3}"][data-day="четврток"][data-ordinal="6"] select.pick.subj`, { timeout: 8000 });
        const predOptions = await up.$eval(`#grid td.wk[data-teacher="${T3}"][data-day="четврток"][data-ordinal="6"] select.pick.subj`,
            (sel) => [...sel.options].map((o) => o.value).filter((v) => v && v !== '__clear'));
        checkEq('со два свои предмети, изборот се отвора сам — и ги нуди прво нив', predOptions.slice(0, 2), ['Математика', 'Физика']);
        await up.selectOption(`#grid td.wk[data-teacher="${T3}"][data-day="четврток"][data-ordinal="6"] select.pick.subj`, 'Физика');
        await wait(async () => ((await byWho(T3, 'четврток', 6))[0] || {}).subject === 'Физика');
        checkEq('и е запишан во базата', (await byWho(T3, 'четврток', 6)).map((r) => `${r.class}:${r.subject}`), [`${B}:Физика`]);

        // Owner, 27 Sep 2026: the two kinds apart, the ticked lists in the
        // pickers, and a lock with a hand that drags the week.
        await q("UPDATE teachers SET subject = 'Музичко' WHERE id = $1", [teachers[T1]]);
        await up.reload();
        await up.waitForSelector('#grid table', { timeout: 15000 });
        await up.click('[data-view="teacher"]');
        await up.waitForSelector(`#grid td.wk[data-teacher="${T3}"]`, { timeout: 15000 });
        const groups = await up.$$eval('#grid h3.week-group', (h) => h.map((x) => x.textContent));
        check('две табели: одделенски, па предметни', groups.length === 2 && /Одделенски/.test(groups[0]) && /Предметни/.test(groups[1]), groups.join(' | '));
        check('секој наставник во својата', await up.$eval(`#grid td.wk[data-teacher="${T1}"]`, (td, g) => {
            const tables = [...document.querySelectorAll('#grid table.week')];
            return tables.indexOf(td.closest('table')) === 0;
        }) && await up.$eval(`#grid td.wk[data-teacher="${T3}"]`, (td) => [...document.querySelectorAll('#grid table.week')].indexOf(td.closest('table')) === 1));

        await cellOf(up, T3, 'петок', 5).click();
        await up.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
        checkEq('предметниот ги гледа прво своите паралелки, како своја група', await up.$eval('#grid td.wk select.pick',
            (sel) => [...sel.querySelectorAll('optgroup')[0].querySelectorAll('option')].map((o) => o.value)), [B]);
        check('другите се под „Други паралелки"', await up.$eval('#grid td.wk select.pick',
            (sel) => [...sel.querySelectorAll('optgroup')].map((g) => g.label).join('|')) === `Паралелки на ${T3}|Други паралелки`);
        await up.keyboard.press('Escape');
        await cellOf(up, T1, 'петок', 5).click();
        await up.locator('#grid td.wk select.pick.subj').waitFor({ state: 'visible' });
        checkEq('одделенскиот ги гледа прво штиклираните предмети', await up.$eval('#grid td.wk select.pick.subj',
            (sel) => [...sel.querySelectorAll('optgroup')[0].querySelectorAll('option')].map((o) => o.value)), ['Музичко']);
        await up.keyboard.press('Escape');

        // A subject the lists lack (owner, 27 Sep 2026): typed once, kept as the teacher's own.
        await cellOf(up, T3, 'петок', 3).click();
        await up.locator('#grid td.wk select.pick').waitFor({ state: 'visible' });
        await up.selectOption('#grid td.wk select.pick', B);
        const t3cell = `#grid td.wk[data-teacher="${T3}"][data-day="петок"][data-ordinal="3"]`;
        await up.waitForSelector(`${t3cell} select.pick.subj`, { timeout: 8000 });
        await up.selectOption(`${t3cell} select.pick.subj`, '__other__');
        await up.waitForSelector(`${t3cell} input.subj-other`, { timeout: 4000 });
        await up.fill(`${t3cell} input.subj-other`, 'Астрономија');
        await up.press(`${t3cell} input.subj-other`, 'Enter');
        await wait(async () => ((await byWho(T3, 'петок', 3))[0] || {}).subject === 'Астрономија');
        checkEq('„✎ друг предмет…" writes the typed subject', (await byWho(T3, 'петок', 3)).map((r) => r.subject), ['Астрономија']);
        checkEq('and keeps it as the teacher\'s own, for next time',
            (await q('SELECT subject FROM teachers WHERE id = $1', [t3.id]))[0].subject, 'Математика, Физика, Астрономија');

        await up.check('#lockEdit');
        await cellOf(up, T1, 'петок', 4).click();
        await up.waitForTimeout(300);
        check('🔒 заклучен внес: клик не отвора ништо', await up.locator('#grid td.wk select').count() === 0);
        check('и покажувачот е рака', await up.$eval('#gridPanel .scroll', (b) => b.classList.contains('locked') && getComputedStyle(b).cursor === 'grab'));
        await up.setViewportSize({ width: 700, height: 500 });
        await up.waitForTimeout(300);
        const box = await up.$eval('#gridPanel .scroll', (b) => { b.scrollIntoView({ block: 'start' }); const r = b.getBoundingClientRect(); return { x: r.left + 400, y: r.top + 80, left: b.scrollLeft }; });
        await up.mouse.move(box.x, box.y);
        await up.mouse.down();
        await up.mouse.move(box.x + 200, box.y, { steps: 8 });
        await up.mouse.up();
        const moved = await up.$eval('#gridPanel .scroll', (b) => ({ left: b.scrollLeft, sw: b.scrollWidth, cw: b.clientWidth, top: Math.round(b.getBoundingClientRect().top), h: b.clientHeight }));
        check('✋ влечење ја поместува неделата', moved.left < box.left - 100, JSON.stringify({ box, moved }));
        await up.close();

        const sheetCtx = await browser.newContext();
        await sheetCtx.addInitScript(() => { try { localStorage.setItem('mtb_editing_v1', '1'); } catch (_) { /* test */ } });
        const sp = await sheetCtx.newPage();
        await sp.goto(`${BASE}/Nastava.html?year=${encodeURIComponent(YEAR)}&view=personal`);
        await sp.waitForSelector(`#who option[value="${T1}"]`, { state: 'attached', timeout: 15000 });
        await sp.selectOption('#who', T1);
        await sp.waitForSelector(`.personal[data-teacher="${T1}"] td.p-cell`, { timeout: 15000 });
        const t1cell = `.personal[data-teacher="${T1}"] td.p-cell[data-day="среда"][data-ordinal="2"]`;
        check('и во Личен распоред одделенскиот има само избор на предмет',
            await sp.locator(`${t1cell} select`).count() === 1 && await sp.locator(`${t1cell} select.p-subj`).count() === 1);
        await sp.selectOption('#who', T3);
        await sp.waitForSelector(`.personal[data-teacher="${T3}"] td.p-cell`, { timeout: 15000 });
        check('а предметниот ја бира паралелката',
            await sp.locator(`.personal[data-teacher="${T3}"] td.p-cell[data-day="среда"][data-ordinal="2"] select.p-class`).count() === 1);
        const t3sheet = `.personal[data-teacher="${T3}"] td.p-cell[data-day="среда"][data-ordinal="2"]`;
        await sp.selectOption(`${t3sheet} select.p-class`, B);
        await sp.waitForSelector(`${t3sheet} select.p-subj`, { timeout: 8000 });
        await sp.selectOption(`${t3sheet} select.p-subj`, '__other');
        await sp.waitForSelector(`${t3sheet} input.p-other`, { timeout: 4000 });
        await sp.fill(`${t3sheet} input.p-other`, 'Геологија');
        await sp.press(`${t3sheet} input.p-other`, 'Enter');
        for (let i = 0; i < 30 && ((await byWho(T3, 'среда', 2))[0] || {}).subject !== 'Геологија'; i++) await sp.waitForTimeout(200);
        checkEq('и во Личен распоред „✎ друг предмет…" го запишува внесениот предмет',
            (await byWho(T3, 'среда', 2)).map((r) => `${r.class}:${r.subject}`), [`${B}:Геологија`]);
        check('и наставникот го добива во своите предмети',
            /Геологија/.test((await q('SELECT subject FROM teachers WHERE id = $1', [t3.id]))[0].subject));
        await sheetCtx.close();
    } finally {
        await browser.close();
        await cleanup();
        // The suite's own year is gone, and with it every row it created.
        const left = await q('SELECT id FROM school_years WHERE label = $1', [YEAR]);
        checkEq('свитата не остави ништо зад себе', left.length, 0);
        await pool.end();
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall good');
    process.exit(fails ? 1 : 0);
}

// A crash after the seed must not leave the invented rows behind.
run().catch(async (err) => { console.error(err); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
