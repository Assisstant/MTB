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
    const { year, teachers } = await seed();
    const browser = await chromium.launch();
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
        await page.selectOption('#view', 'teacher');
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

        console.log('\nстраницата не чува ништо свое');
        const stored = await page.evaluate(() => {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out[k] = (localStorage.getItem(k) || '').slice(0, 40);
            }
            return out;
        });
        const schoolish = Object.keys(stored).filter((k) => !/theme|mtb_server|mtb_scale|display/i.test(k));
        checkEq('ниту еден училишен податок во localStorage', schoolish, []);

        check('нема JavaScript грешки на страницата', errors.length === 0, errors.join(' ;; '));
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

run().catch((err) => { console.error(err); process.exit(1); });
