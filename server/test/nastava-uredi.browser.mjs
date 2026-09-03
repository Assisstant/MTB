/**
 * NastavaUredi.html, in a real browser, against a real server.
 *
 *     npm run start                        # in one terminal
 *     npm run test:uredi
 *
 * Every write assertion here is read back from the DATABASE, never from what
 * the page believes it did. The two that matter most:
 *
 *   1. ONE Enter writes ONE lesson. The editor replaces its own contents on
 *      every cell, so a listener attached inside that redraw would stack — by
 *      the tenth cell a single Enter would send ten writes, and the timetable
 *      would look fine while the log filled with duplicates.
 *   2. A stale tab cannot overwrite. The page sends what it BELIEVED was in
 *      the cell; this suite changes the row behind its back and checks that
 *      the save is refused and the database is untouched.
 *
 * It works in a school year of its own and its classes are invented, so it
 * can share a database with a real school (rule 1). It writes NO screenshot:
 * this page lists real teacher names, and a PNG of it has no business near a
 * public repository (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const DAY = 'вторник';
const TAG = 'browser-uredi';
const YEAR = '1905/1906-uredi';
const SRC_YEAR = '1906/1907-uredi';
const CLASS = 'ПРОБНО-А';
const NEW_CLASS = 'ПРОБНО-Б';
const TEACHER = `${TAG} Наставник Пробен`;

const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};

const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q(`DELETE FROM school_years WHERE label IN ($1, $2)`, [YEAR, SRC_YEAR]);
    await q(`DELETE FROM school_classes WHERE label IN ($1, $2)`, [CLASS, NEW_CLASS]);
    await q(`DELETE FROM teachers WHERE name LIKE $1`, [`${TAG}%`]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1905-09-01', '1906-08-31', false) RETURNING id, label`, [YEAR]);
    const [source] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1906-09-01', '1907-08-31', false) RETURNING id, label`, [SRC_YEAR]);
    const [cls] = await q(
        `INSERT INTO school_classes (label, sort_key) VALUES ($1, '99-а') RETURNING id`, [CLASS]);
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind, subject) VALUES ($1, 'pred', 'ФЗО.') RETURNING id`, [TEACHER]);
    await q(
        `INSERT INTO class_years (school_year_id, class_id, active)
         VALUES ($1, $3, true), ($2, $3, true)`,
        [year.id, source.id, cls.id]
    );
    await q(
        `INSERT INTO teacher_years (school_year_id, teacher_id, active)
         VALUES ($1, $3, true), ($2, $3, true)`,
        [year.id, source.id, teacher.id]
    );
    // Two lessons in the SOURCE year, so the copy has something to carry.
    for (const [ordinal, subject] of [[1, 'мак.'], [2, 'мат.']]) {
        await q(
            `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             VALUES ($1, $2, 2, $3, $4, $5, $6)`,
            [source.id, DAY, ordinal, cls.id, teacher.id, subject]);
    }
    return { year, source, cls, teacher };
}

const cellIn = async (yearId, ordinal, label = CLASS) => q(
    `SELECT l.id, l.subject, l.day_order, t.name AS teacher
       FROM lessons l JOIN school_classes c ON c.id = l.class_id
       LEFT JOIN teachers t ON t.id = l.teacher_id
      WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = $3 AND c.label = $4
      ORDER BY l.id`,
    [yearId, DAY, ordinal, label]);

const run = async () => {
    const { year, source } = await seed();
    console.log(`editing in a browser — ${CLASS}, ${DAY}, ${YEAR}\n`);

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());

    await page.goto(`${BASE}/NastavaUredi.html?year=${encodeURIComponent(YEAR)}`);
    await page.waitForSelector('#grid table.grid', { timeout: 8000 });
    await page.selectOption('#day', DAY);
    await page.waitForTimeout(200);

    const cellText = (ordinal) => page.evaluate(([key]) => {
        const td = document.querySelector(`#grid td.cell[data-key="${key}"]`);
        return td ? { text: td.textContent.replace(/\s+/g, ' ').trim(), cls: td.className } : null;
    }, [`${CLASS}|${ordinal}`]);

    const openCell = async (ordinal) => {
        await page.click(`#grid td.cell[data-key="${CLASS}|${ordinal}"]`);
        await page.waitForSelector('#edSubject', { timeout: 4000 });
    };

    console.log('typing into an empty cell writes one lesson, and only one');
    check('the empty cell is drawn', (await cellText(1))?.cls.includes('empty'), JSON.stringify(await cellText(1)));
    await openCell(1);
    await page.fill('#edSubject', 'мак.');
    await page.selectOption('#edTeacher', TEACHER);
    await page.click('#edSave');
    await page.waitForTimeout(700);
    let rows = await cellIn(year.id, 1);
    checkEq('the database has the lesson', rows.length, 1);
    checkEq('with the subject that was typed', rows[0].subject, 'мак.');
    checkEq('and the teacher that was chosen', rows[0].teacher, TEACHER);
    checkEq('day_order is filled in, so it sorts with the rest of the week', rows[0].day_order, 2);
    check('and the grid now shows it', (await cellText(1))?.text.includes('мак.'), JSON.stringify(await cellText(1)));

    console.log('\none Enter is one write, and it moves to the next period');
    await openCell(3);
    await page.fill('#edSubject', 'з.о.');
    await page.press('#edSubject', 'Enter');
    await page.waitForTimeout(800);
    rows = await cellIn(year.id, 3);
    checkEq('exactly one lesson landed', rows.length, 1);
    const heading = await page.evaluate(() => document.querySelector('#editor h2')?.textContent.replace(/\s+/g, ' ').trim());
    check('the editor moved on to the next period', /4\. час/.test(String(heading)), String(heading));

    // The stacking bug this is really about: open several cells, then press
    // Enter ONCE. A handler added per redraw would fire once per cell opened.
    await openCell(5);
    await openCell(6);
    await openCell(7);
    await page.fill('#edSubject', 'физ.');
    await page.press('#edSubject', 'Enter');
    await page.waitForTimeout(800);
    checkEq('after opening four cells, one Enter still writes one lesson', (await cellIn(year.id, 7)).length, 1);
    checkEq('and it did not also write the cells passed through', (await cellIn(year.id, 5)).length, 0);
    checkEq('nor the other one', (await cellIn(year.id, 6)).length, 0);

    console.log('\nediting a filled cell changes it in place');
    await openCell(1);
    await page.fill('#edSubject', 'мат.');
    await page.click('#edSave');
    await page.waitForTimeout(700);
    rows = await cellIn(year.id, 1);
    checkEq('still one row, not a second', rows.length, 1);
    checkEq('with the new subject', rows[0].subject, 'мат.');

    console.log('\na stale tab is refused, and the database keeps what it has');
    // Behind the page's back, exactly as a re-import or another machine would.
    await q(`UPDATE lessons SET subject = 'лик.' WHERE id = $1`, [rows[0].id]);
    await openCell(1);
    await page.fill('#edSubject', 'муз.');
    await page.click('#edSave');
    await page.waitForTimeout(700);
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the page says somebody else changed it, in Macedonian',
        /Некој друг/.test(status), status);
    checkEq('and the row is untouched', (await cellIn(year.id, 1))[0].subject, 'лик.');

    console.log('\nemptying a lesson removes it');
    await page.click('#refresh');
    await page.waitForTimeout(700);
    await openCell(1);
    await page.click('#edDrop');
    await page.waitForTimeout(700);
    checkEq('the lesson is gone from the database', (await cellIn(year.id, 1)).length, 0);
    check('and the cell is drawn empty again', (await cellText(1))?.cls.includes('empty'), JSON.stringify(await cellText(1)));

    console.log('\nadding a class goes to the server, not to a list in the page');
    await page.evaluate(() => { document.getElementById('classSection').open = true; });
    await page.fill('#newClass', NEW_CLASS);
    await page.click('#addClass');
    await page.waitForTimeout(700);
    checkEq('the class is in the database', (await q(`SELECT count(*)::int AS n FROM school_classes WHERE label = $1`, [NEW_CLASS]))[0].n, 1);

    console.log('\ncopying last year is shown before it is done');
    await page.evaluate(() => { document.getElementById('copySection').open = true; });
    await page.selectOption('#copyFrom', SRC_YEAR);
    await page.check('#copyReplace');
    // What the hand-editing above left behind, so the dry run can be shown to
    // change nothing and the apply can be shown to replace it.
    const byHand = (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [year.id]))[0].n;
    await page.click('#copyCheck');
    await page.waitForTimeout(700);
    let report = await page.evaluate(() => document.getElementById('copyReport').textContent);
    check('it says what will happen, with the numbers', /2 часа/.test(report), report);
    const afterDry = (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [year.id]))[0].n;
    checkEq('and the dry run wrote nothing', afterDry, byHand);

    await page.click('#copyApply');
    await page.waitForTimeout(900);
    report = await page.evaluate(() => document.getElementById('copyReport').textContent);
    const copied = await q(
        `SELECT c.label, l.ordinal, l.subject FROM lessons l JOIN school_classes c ON c.id = l.class_id
          WHERE l.school_year_id = $1 ORDER BY l.ordinal`, [year.id]);
    checkEq('the year now holds exactly last year\'s two lessons', copied.length, 2);
    checkEq('which are last year\'s, not the ones typed in above',
        copied.map((r) => `${r.ordinal}:${r.subject}`), ['1:мак.', '2:мат.']);
    check('and the class kept its own label rather than being promoted',
        copied.every((r) => r.label === CLASS), JSON.stringify(copied));
    check('the report says it was done', /Копирани/.test(report), report);

    console.log('\nthe page keeps nothing of its own');
    // The header claims this: no local copy, no queue, nothing "for later".
    const stored = await page.evaluate(() => {
        try { return { local: localStorage.length, session: sessionStorage.length }; }
        catch (e) { return { local: -1, session: -1 }; }
    });
    checkEq('nothing was written to browser storage', stored, { local: 0, session: 0 });

    console.log('\nand it is honest when the server is gone');
    await ctx.route('**/api/teaching/**', (r) => r.abort());
    await page.click('#refresh');
    await page.waitForTimeout(1200);
    const offline = await page.evaluate(() => ({
        status: document.getElementById('status').textContent,
        grid: document.getElementById('grid').innerHTML
    }));
    check('it says the server is unreachable', /не одговара/.test(offline.status), offline.status);
    check('and explains that there is nowhere to write, instead of an empty grid',
        /Нема врска со серверот/.test(offline.grid), offline.grid.slice(0, 160));

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await cleanup();
    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
