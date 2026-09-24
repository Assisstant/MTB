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

    // The subject is picked from the class's catalogue; anything else goes
    // through „✎ друг предмет…", which turns the picker into a text field.
    const typeSubject = async (text) => {
        await page.selectOption('#edSubject', '__other__');
        await page.waitForSelector('input#edSubject', { timeout: 2000 });
        await page.fill('#edSubject', text);
    };

    console.log('the views are tabs, and the day editor offers the same lists as the week');
    const tabs = await page.$$eval('#views [data-view]', (b) => b.map((x) => [x.dataset.view, x.getAttribute('aria-pressed')]));
    checkEq('three view tabs, the day grid chosen', tabs, [['class', 'true'], ['classweek', 'false'], ['teacher', 'false']]);
    await openCell(2);
    const dayOffer = await page.$$eval('#edSubject option', (o) => o.map((x) => x.value));
    check('the day editor offers the MON catalogue, not only what is already typed',
        dayOffer.includes('Математика') && dayOffer.includes('__other__'), dayOffer.slice(0, 8).join(', '));
    const teachOffer = await page.$$eval('#edTeacher option', (o) => o.map((x) => x.value));
    check('and the teachers of the year', teachOffer.includes(TEACHER), teachOffer.join(', '));
    await page.selectOption('#edSubject', 'Математика');
    await page.click('#edSave');
    await page.waitForTimeout(700);
    checkEq('a subject picked from the list is written as it reads', (await cellIn(year.id, 2))[0]?.subject, 'Математика');
    await page.click('#edDrop');
    await page.waitForTimeout(700);
    checkEq('and emptied again, so the rest of the suite starts from an empty period', (await cellIn(year.id, 2)).length, 0);

    console.log('\ntyping into an empty cell writes one lesson, and only one');
    check('the empty cell is drawn', (await cellText(1))?.cls.includes('empty'), JSON.stringify(await cellText(1)));
    await openCell(1);
    await typeSubject('мак.');
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
    await typeSubject('з.о.');
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
    await typeSubject('физ.');
    await page.press('#edSubject', 'Enter');
    await page.waitForTimeout(800);
    checkEq('after opening four cells, one Enter still writes one lesson', (await cellIn(year.id, 7)).length, 1);
    checkEq('and it did not also write the cells passed through', (await cellIn(year.id, 5)).length, 0);
    checkEq('nor the other one', (await cellIn(year.id, 6)).length, 0);

    console.log('\nediting a filled cell changes it in place');
    await openCell(1);
    await typeSubject('мат.');
    await page.click('#edSave');
    await page.waitForTimeout(700);
    rows = await cellIn(year.id, 1);
    checkEq('still one row, not a second', rows.length, 1);
    checkEq('with the new subject', rows[0].subject, 'мат.');

    console.log('\na stale tab is refused, and the database keeps what it has');
    // Behind the page's back, exactly as a re-import or another machine would.
    await q(`UPDATE lessons SET subject = 'лик.' WHERE id = $1`, [rows[0].id]);
    await openCell(1);
    await typeSubject('муз.');
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

    console.log('\nthe class week: periods down, days across, a dropdown in every cell');
    const WED = 'среда';
    const FRI = 'петок';
    const cellOn = async (day, ordinal) => q(
        `SELECT l.id, l.subject, t.name AS teacher
           FROM lessons l JOIN school_classes c ON c.id = l.class_id
           LEFT JOIN teachers t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = $3 AND c.label = $4
          ORDER BY l.id`,
        [year.id, day, ordinal, CLASS]);
    const cw = (day, ordinal) => `#grid td.cw[data-day="${day}"][data-ordinal="${ordinal}"]`;
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/teaching/lesson')) puts.push(r.url()); });

    await page.goto(`${BASE}/NastavaUredi.html?year=${encodeURIComponent(YEAR)}`
        + `&view=classweek&class=${encodeURIComponent(CLASS)}`);
    await page.waitForSelector('#grid table.cweek', { timeout: 8000 });
    const shape = await page.evaluate(() => ({
        view: (document.querySelector('#views [aria-pressed="true"]') || {}).dataset?.view,
        klass: (document.querySelector('#classStrip [aria-pressed="true"]') || {}).dataset?.class,
        heads: Array.from(document.querySelectorAll('#grid table.cweek thead th')).map((t) => t.textContent.trim()),
        rows: document.querySelectorAll('#grid table.cweek tbody tr').length,
        cells: document.querySelectorAll('#grid td.cw').length
    }));
    checkEq('the address opens the class week of the class it names', [shape.view, shape.klass], ['classweek', CLASS]);
    checkEq('the days run across', shape.heads.slice(1), ['Понеделник', 'Вторник', 'Среда', 'Четврток', 'Петок']);
    check('one row per period, five cells in each', shape.rows > 0 && shape.cells === shape.rows * 5, JSON.stringify(shape));
    const offered = await page.$$eval(`${cw(WED, 2)} select.cw-subj option`, (o) => o.map((x) => x.value));
    check('the subject list is the MON catalogue', offered.includes('Математика') && offered.includes('Англиски јазик'),
        offered.slice(0, 8).join(', '));

    await page.selectOption(`${cw(WED, 2)} select.cw-subj`, 'Математика');
    await page.waitForTimeout(1500);
    rows = await cellOn(WED, 2);
    checkEq('choosing a subject writes one lesson', rows.map((r) => r.subject), ['Математика']);
    checkEq('with no teacher, because none was chosen', rows[0] && rows[0].teacher, null);

    await page.selectOption(`${cw(WED, 2)} select.cw-teach`, TEACHER);
    await page.waitForTimeout(1500);
    rows = await cellOn(WED, 2);
    checkEq('choosing the teacher changes the same row', rows.map((r) => [r.subject, r.teacher]), [['Математика', TEACHER]]);

    // A closed <select> fires `change` on each arrow key. Without the pause
    // before sending, this would be three writes and three reloads.
    puts.length = 0;
    await page.focus(`${cw(WED, 3)} select.cw-subj`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(1600);
    checkEq('three arrow presses are one write, not three', puts.length, 1);
    checkEq('and one lesson', (await cellOn(WED, 3)).length, 1);

    await q(`UPDATE lessons SET subject = 'лик.' WHERE id = $1`, [rows[0].id]);
    await page.selectOption(`${cw(WED, 2)} select.cw-subj`, 'Англиски јазик');
    await page.waitForTimeout(1500);
    const stale = await page.evaluate((sel) => ({
        status: document.getElementById('status').textContent,
        failed: document.querySelector(sel).classList.contains('failed')
    }), cw(WED, 2));
    check('a stale tab is refused here too', /Некој друг/.test(stale.status), stale.status);
    check('and the cell is marked, keeping what was chosen', stale.failed);
    checkEq('the database keeps what it had', (await cellOn(WED, 2))[0].subject, 'лик.');

    await page.click('#refresh');
    await page.waitForTimeout(900);
    checkEq('after a refresh the cell shows what the database holds',
        await page.$eval(`${cw(WED, 2)} select.cw-subj`, (s) => s.value), 'лик.');
    await page.selectOption(`${cw(WED, 2)} select.cw-subj`, '');
    await page.selectOption(`${cw(WED, 2)} select.cw-teach`, '');
    await page.waitForTimeout(1600);
    checkEq('emptying both pickers frees the period', (await cellOn(WED, 2)).length, 0);

    await page.selectOption(`${cw(FRI, 1)} select.cw-subj`, '__other__');
    await page.waitForSelector(`${cw(FRI, 1)} input.cw-other`, { timeout: 3000 });
    await page.fill(`${cw(FRI, 1)} input.cw-other`, 'Планинарење');
    await page.press(`${cw(FRI, 1)} input.cw-other`, 'Enter');
    await page.waitForTimeout(1200);
    checkEq('„друг предмет" writes a subject the catalogue does not list',
        (await cellOn(FRI, 1)).map((r) => r.subject), ['Планинарење']);
    checkEq('and the cell shows it, rather than a blank picker',
        await page.$eval(`${cw(FRI, 1)} select.cw-subj`, (s) => s.value), 'Планинарење');

    // Readable in both themes is a measurement, not a glance (the chip trap).
    const contrast = await page.evaluate((sel) => {
        const lum = (rgb) => {
            const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
                v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (node) => {
            const s = getComputedStyle(node);
            const a = lum(s.color); const b = lum(s.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const out = {};
        for (const theme of ['light', 'dark']) {
            document.documentElement.setAttribute('data-theme', theme);
            out[theme] = Math.round(ratio(document.querySelector(sel)) * 10) / 10;
        }
        return out;
    }, `${cw(FRI, 1)} select.cw-subj`);
    check('the chosen subject is readable in both themes (≥ 4.5:1)',
        contrast.light >= 4.5 && contrast.dark >= 4.5, JSON.stringify(contrast));

    check('the print button is offered in this view', await page.isVisible('#printWeek'));
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate((sel) => ({
        select: getComputedStyle(document.querySelector(sel + ' select.cw-subj')).display,
        text: document.querySelector(sel + ' .print-only').textContent,
        shown: getComputedStyle(document.querySelector(sel + ' .print-only')).display
    }), cw(FRI, 1));
    await page.emulateMedia({ media: 'screen' });
    checkEq('on paper the cell is the subject, not a dropdown',
        [printed.select, printed.shown, printed.text], ['none', 'block', 'Планинарење']);

    const chip = await page.evaluate((label) => {
        const b = document.querySelector(`#classStrip [data-class="${label}"]`);
        return b ? b.textContent.replace(/\s+/g, ' ').trim() : null;
    }, CLASS);
    check('the class strip says how many lessons the class has', /\d+ час/.test(String(chip)), String(chip));

    await page.click('#views [data-view="class"]');
    await page.waitForSelector('#grid table.grid.day', { timeout: 4000 });
    checkEq('the tab puts the view in the address', new URL(page.url()).searchParams.get('view'), 'class');

    console.log('\na class name in the day grid opens the week of that class');
    await page.click(`#grid [data-week="${CLASS}"]`);
    await page.waitForSelector('#grid table.cweek', { timeout: 4000 });
    checkEq('the week of the class that was clicked',
        await page.evaluate(() => Array.from(document.querySelectorAll('#grid .cw-sheet')).map((x) => x.dataset.sheet)), [CLASS]);
    await page.click('#views [data-view="class"]');
    await page.waitForSelector('#grid table.grid.day', { timeout: 4000 });

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
