/**
 * AkciskiPlan.html (Евидентен лист), in a real browser, against a real server.
 *
 *     npm run start                    # in one terminal
 *     npm run test:evidence-ui
 *
 * Every write is read back from the DATABASE, never from the page's own
 * opinion. The two assertions the whole rewrite exists for:
 *
 *   1. TWO SPECIALISTS, ONE CHILD, ONE AFTERNOON. Two browsers signed in as
 *      different therapists fill different sections of the same sheet and both
 *      survive. The old app saved the record as one document, so the second
 *      save silently replaced the first one's work with its own view of the
 *      whole form -- and nothing on either screen said so.
 *
 *   2. NOTHING IS KEPT LOCALLY. localStorage may hold the sign-in token, the
 *      chosen server and the theme, and no record data at all. That is the
 *      claim in the page's own header comment and the one most able to rot
 *      quietly, so it is a test rather than a promise.
 *
 * Its people are invented and prefixed and it works in a school year of its
 * own, so it can share a database with a real school (rule 1). It writes no
 * screenshot: the page lists real children (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';

/** <option> elements are never "visible", so wait for the list to be filled. */
const gateReady = (target) => target.waitForFunction(
    () => document.querySelectorAll('#gateWho option').length > 0, null, { timeout: 8000 });
const pinReady = (target, value) => target.waitForFunction((wanted) => {
    const option = [...document.querySelectorAll('#gateWho option')]
        .find((candidate) => candidate.value === wanted);
    return option?.dataset.pin === '1';
}, value, { timeout: 8000 });

async function pupilReady(target, errors) {
    try {
        await target.waitForSelector('.pupil', { timeout: 8000 });
    } catch (err) {
        const state = await target.evaluate(() => ({
            gateHidden: document.querySelector('#gate')?.hidden,
            gateMessage: document.querySelector('#gateMsg')?.textContent,
            status: document.querySelector('#status')?.textContent,
            year: document.querySelector('#year')?.value,
            pupilCount: document.querySelector('#pupilCount')?.textContent
        }));
        throw new Error(`${err.message}\npage state: ${JSON.stringify(state)}\npage errors: ${errors.join(' | ')}`);
    }
}

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const TAG = 'browser-evidence';
const YEAR = '1903/1904-evid';
const PIN_A = '1357';
const PIN_B = '2468';
const THERAPIST_A = `${TAG} Прва Терапевтка`;
const THERAPIST_B = `${TAG} Втор Терапевт`;
const TEACHER = `${TAG} Пробен Наставник`;
const PUPIL = `${TAG} Пробен Ученик`;
const CLASS = `${TAG}-V-е`;
const CATEGORY_CODE = `${TAG}_category`;
const CATEGORY = `${TAG} Пробна категорија`;

const pool = new pg.Pool({ connectionString: DB });
let browser;
let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};
const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q('DELETE FROM evidence_items WHERE label LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM teachers WHERE name LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM school_classes WHERE label = $1', [CLASS]);
    await q('DELETE FROM evidence_sections WHERE title LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM specialist_categories WHERE code = $1', [CATEGORY_CODE]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1903-09-01', '1904-08-31', false) RETURNING id`, [YEAR]);
    const [pupil] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
        [`${TAG}-1`, PUPIL, CLASS]);
    await q(
        `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
         VALUES ($1, $2, $3, 'internal', true)`, [pupil.id, year.id, CLASS]);
    const therapists = [];
    for (const name of [THERAPIST_A, THERAPIST_B]) {
        const [t] = await q('INSERT INTO therapists (name) VALUES ($1) RETURNING id', [name]);
        await q('INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)',
            [year.id, t.id]);
        therapists.push(t);
    }
    const [category] = await q(
        `INSERT INTO specialist_categories (code, name, ord)
         VALUES ($1, $2, 990) RETURNING id`, [CATEGORY_CODE, CATEGORY]);
    const [section] = await q(
        `INSERT INTO evidence_sections (code, title, ord, scale, summary, catalog)
         VALUES ($1, $2, 990, 'level', true, 'prescribed') RETURNING id`,
        [`${TAG}_prescribed`, `${TAG} Пропишана секција`]);
    const [item] = await q(
        `INSERT INTO evidence_items (section_id, label, ord)
         VALUES ($1, $2, 0) RETURNING id`, [section.id, `${TAG} Пробна ставка`]);
    await q(`UPDATE therapist_years SET category_id = $3
             WHERE school_year_id = $1 AND therapist_id = $2`,
        [year.id, therapists[0].id, category.id]);
    await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
             VALUES ($1, $2, $3)`, [year.id, therapists[0].id, pupil.id]);
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [TEACHER]);
    const [schoolClass] = await q(
        `INSERT INTO school_classes (label, sort_key)
         VALUES ($1, $2) RETURNING id`, [CLASS, `zz-${TAG}`]);
    await q(
        `INSERT INTO teacher_years (school_year_id, teacher_id, active, category_id)
         VALUES ($1, $2, true, $3)`, [year.id, teacher.id, category.id]);
    await q(
        `INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
         VALUES ($1, $2, $3, 'homeroom')`, [year.id, teacher.id, schoolClass.id]);
    const [current] = await q('SELECT id FROM school_years WHERE is_current LIMIT 1');
    if (current) {
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active, category_id)
                 VALUES ($1, $2, true, $3)
                 ON CONFLICT (school_year_id, therapist_id)
                 DO UPDATE SET active = true, category_id = EXCLUDED.category_id`,
            [current.id, therapists[0].id, category.id]);
    }
    return { year, pupil, therapists, teacher, category, section, item };
}

const post = async (path, body, token) => {
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-MTB-Evidence-Token': token } : {}) },
        body: JSON.stringify(body)
    });
    return res.json();
};

const run = async () => {
    const fixture = await seed();
    console.log(`евидентен лист во прелистувач — ${YEAR}\n`);

    browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1050 }, acceptDownloads: true
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    // ── the gate ─────────────────────────────────────────────────────────────
    console.log('signing in');
    await page.goto(`${BASE}/AkciskiPlan.html?year=${encodeURIComponent(YEAR)}`);
    await gateReady(page);
    check('the page is gated until somebody signs in',
        await page.isVisible('#gate'), 'the record was readable without a name on it');
    await page.selectOption('#gateWho', `therapist:${fixture.therapists[0].id}`);
    check('a therapist with no PIN cannot simply enter',
        await page.isDisabled('#gateGo'), 'the login button was live with no PIN set');
    await page.fill('#gatePin', PIN_A);
    await page.click('#gateSet');                       // reveals the confirmation
    await page.fill('#gatePin2', PIN_A);
    await page.click('#gateSet');                       // sends it
    await pinReady(page, `therapist:${fixture.therapists[0].id}`);
    await page.selectOption('#gateWho', `therapist:${fixture.therapists[0].id}`);
    await page.fill('#gatePin', PIN_A);
    await page.click('#gateGo');
    await pupilReady(page, errors);
    check('after signing in the page names who is writing',
        (await page.textContent('#who')) === THERAPIST_A, await page.textContent('#who'));

    const [pinRow] = await q('SELECT pin_hash FROM evidence_logins WHERE therapist_id = $1',
        [fixture.therapists[0].id]);
    check('the PIN reached the database as a hash, not as typed',
        !!pinRow && pinRow.pin_hash !== PIN_A && pinRow.pin_hash.length >= 32, JSON.stringify(pinRow));

    // ── opening a sheet ──────────────────────────────────────────────────────
    console.log('\nopening a record');
    checkEq('the pupil list comes from the database',
        await page.$$eval('.pupil .nm', (nodes) => nodes.map((n) => n.textContent)), [PUPIL]);
    await page.click('.pupil');
    await page.click('#btnNewSheet');
    await page.waitForSelector('#btnDelSheet', { timeout: 8000 });
    const [sheetRow] = await q(
        `SELECT sh.id, sh.created_by FROM evidence_sheets sh
         JOIN students s ON s.id = sh.student_id WHERE s.public_id = $1`, [`${TAG}-1`]);
    check('the sheet exists in the database and records who opened it',
        !!sheetRow && sheetRow.created_by === THERAPIST_A, JSON.stringify(sheetRow));

    await page.click('.tab[data-p="pScores"]');
    await page.waitForSelector('select.ss', { timeout: 8000 });
    check('the action-plan view is discoverable before its first section exists',
        await page.isVisible('[data-doc="action"]'), 'the switch was hidden by an empty catalogue');
    // Each table sits in its own scroll box, so :first-of-type would match one
    // per section rather than the first table on the page.
    const columns = await page.evaluate(() => Array.from(
        document.querySelector('#pScores table.at').querySelectorAll('thead th')
    ).map((n) => n.textContent.trim()));
    checkEq('the year carries four assessment columns, not the form\'s three',
        columns.length, 5); // ставка + четири периоди

    // ── one cell at a time ───────────────────────────────────────────────────
    console.log('\none cell at a time');
    const firstCell = await page.$(`select.ss[data-item="${fixture.item.id}"]`);
    const itemId = Number(await firstCell.getAttribute('data-item'));
    const periodId = Number(await firstCell.getAttribute('data-period'));
    await firstCell.selectOption('2');
    await page.waitForTimeout(700);
    let rows = await q(
        'SELECT value, updated_by FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3',
        [sheetRow.id, itemId, periodId]);
    checkEq('the mark is in the database, signed by the therapist who typed it',
        rows.map((r) => [r.value, r.updated_by]), [['2', THERAPIST_A]]);

    check('the section average is computed on screen from the marks written',
        /\d+%/.test(await page.textContent(`table[data-score-section="${fixture.section.id}"] tr.ev`)),
        await page.textContent(`table[data-score-section="${fixture.section.id}"] tr.ev`));

    // A colleague writes the same cell from another machine. The page must
    // notice rather than overwrite -- this is the whole point of `expected`.
    await q('UPDATE evidence_scores SET value = $4 WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3',
        [sheetRow.id, itemId, periodId, '3']);
    await firstCell.selectOption('1');
    await page.waitForTimeout(700);
    rows = await q(
        'SELECT value FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3',
        [sheetRow.id, itemId, periodId]);
    checkEq('a cell changed elsewhere is not overwritten', rows[0].value, '3');
    check('and the screen is corrected to what really stands there',
        await firstCell.inputValue() === '3', await firstCell.inputValue());
    check('the corrected server value also refreshes the in-memory summary',
        /100%/.test(await page.textContent(`table[data-score-section="${fixture.section.id}"] tr.ev`)),
        await page.textContent(`table[data-score-section="${fixture.section.id}"] tr.ev`));
    check('the strip says the write was refused',
        /смени|Некој/i.test(await page.textContent('#status')), await page.textContent('#status'));

    // ── two therapists, one child, one afternoon ─────────────────────────────
    console.log('\ntwo therapists filling different sections of one sheet');
    const secondCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const second = await secondCtx.newPage();
    const secondErrors = [];
    second.on('pageerror', (e) => secondErrors.push(String(e)));
    second.on('dialog', (d) => d.accept());
    await post('/api/evidence/pin', { therapistId: fixture.therapists[1].id, pin: PIN_B });
    await second.goto(`${BASE}/AkciskiPlan.html?year=${encodeURIComponent(YEAR)}`);
    await gateReady(second);
    await second.selectOption('#gateWho', `therapist:${fixture.therapists[1].id}`);
    await second.fill('#gatePin', PIN_B);
    await second.click('#gateGo');
    await pupilReady(second, secondErrors);
    await second.click('.pupil');
    await second.waitForSelector('#btnDelSheet', { timeout: 8000 });
    check('the second therapist opens the SAME sheet, not a second one',
        (await q('SELECT count(*)::int AS n FROM evidence_sheets WHERE id = $1', [sheetRow.id]))[0].n === 1);

    await second.click('.tab[data-p="pScores"]');
    await second.waitForSelector('select.ss', { timeout: 8000 });
    // A cell in a different section: the psychologist's half of the form.
    const otherCell = await second.$('#pScores .card:nth-of-type(8) select.ss')
        || (await second.$$('select.ss')).slice(-1)[0];
    const otherItem = Number(await otherCell.getAttribute('data-item'));
    const otherPeriod = Number(await otherCell.getAttribute('data-period'));
    await otherCell.selectOption({ index: 1 });
    await second.waitForTimeout(700);

    rows = await q(
        `SELECT item_id, value, updated_by FROM evidence_scores
         WHERE sheet_id = $1 ORDER BY item_id`, [sheetRow.id]);
    check('both therapists\' marks are in the database at once',
        rows.length === 2 && rows.some((r) => r.item_id === itemId)
            && rows.some((r) => r.item_id === otherItem && r.updated_by === THERAPIST_B),
        JSON.stringify(rows));
    check('and each cell names the person who wrote it',
        new Set(rows.map((r) => r.updated_by)).size === 2, JSON.stringify(rows.map((r) => r.updated_by)));
    void otherPeriod;
    await secondCtx.close();

    // ── nothing is kept locally ──────────────────────────────────────────────
    console.log('\nthe page keeps no copy of the record');
    const stored = await page.evaluate(() => Object.fromEntries(
        Object.keys(localStorage).map((k) => [k, String(localStorage.getItem(k)).slice(0, 24)])));
    const allowed = new Set(['evidence_token_v1', 'evidence_theme_v1', 'mtb_podatoci_server_v1', 'mtb_servers_v1']);
    checkEq('localStorage holds only the sign-in, the server and the theme',
        Object.keys(stored).filter((k) => !allowed.has(k)), []);
    checkEq('and sessionStorage holds nothing at all',
        await page.evaluate(() => sessionStorage.length), 0);

    // ── the catalogue is editable ────────────────────────────────────────────
    console.log('\nadding and removing lines of the form');
    await page.check('#editToggle');
    await page.waitForSelector('[data-add-item]', { timeout: 8000 });
    const sectionId = fixture.section.id;
    await page.fill(`[data-new-item="${sectionId}"]`, `${TAG} нова ставка`);
    await page.click(`[data-add-item="${sectionId}"]`);
    await page.waitForTimeout(900);
    rows = await q('SELECT id, label, active FROM evidence_items WHERE label = $1', [`${TAG} нова ставка`]);
    checkEq('a new line is written to the catalogue', rows.length, 1);
    check('and it appears on the screen it was typed into',
        (await page.content()).includes(`${TAG} нова ставка`), 'the added line was not drawn');

    const addedId = rows[0].id;
    await page.click(`[data-item-del="${addedId}"]`);
    await page.waitForTimeout(900);
    checkEq('a line nobody has scored is deleted outright',
        (await q('SELECT count(*)::int AS n FROM evidence_items WHERE id = $1', [addedId]))[0].n, 0);

    // This suite owns the item as well as its section. It never hides a line
    // from the seeded prescribed form, even briefly.
    await page.click(`[data-item-del="${itemId}"]`);
    await page.waitForTimeout(1200);
    rows = await q('SELECT active FROM evidence_items WHERE id = $1', [itemId]);
    checkEq('a line that carries marks is hidden rather than deleted', rows.map((r) => r.active), [false]);
    checkEq('and its marks are still there',
        (await q('SELECT count(*)::int AS n FROM evidence_scores WHERE item_id = $1', [itemId]))[0].n, 1);
    // Edit mode adds a column to every table, which is exactly where a page
    // starts scrolling sideways as a whole instead of inside its own tables.
    checkEq('editing does not widen the page itself',
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    await page.click(`[data-item-hide="${itemId}"]`);   // put the form back as it was
    await page.waitForTimeout(900);
    checkEq('hiding is reversible', (await q('SELECT active FROM evidence_items WHERE id = $1', [itemId]))[0].active, true);
    await page.uncheck('#editToggle');

    // ── the first real action-plan section ───────────────────────────────────
    console.log('\ncreating and assessing an action-plan section');
    await page.click('.tab[data-p="pSetup"]');
    await page.waitForSelector('#newActionCategory', { timeout: 8000 });
    await page.selectOption('#newActionCategory', String(fixture.category.id));
    await page.fill('#newActionTitle', `${TAG} Акциски цели`);
    await page.selectOption('#newActionScale', 'level');
    await page.click('#btnAddActionSection');
    await page.waitForFunction((wanted) => [...document.querySelectorAll('#pSetup [data-section-title]')]
        .some((node) => node.value === wanted), `${TAG} Акциски цели`, { timeout: 8000 });
    const [actionSection] = await q(
        `SELECT id, catalog, category_id, scale FROM evidence_sections
         WHERE title = $1`, [`${TAG} Акциски цели`]);
    check('the settings screen creates a category-linked action section',
        actionSection?.catalog === 'action'
            && actionSection?.category_id === fixture.category.id
            && actionSection?.scale === 'level', JSON.stringify(actionSection));

    await page.click('.tab[data-p="pScores"]');
    await page.click('[data-doc="action"]');
    const actionToggle = `[data-action-section="${actionSection.id}"]`;
    check('the pupil receives that section from the therapist caseload',
        await page.isChecked(actionToggle), 'the derived category was not checked');

    await page.route('**/api/evidence/sheet-section', (route) => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test refusal' })
    }), { times: 1 });
    await page.uncheck(actionToggle);
    await page.waitForTimeout(300);
    check('a refused inclusion change returns the checkbox to the database-confirmed state',
        await page.isChecked(actionToggle), 'the failed override was still shown as saved');

    await page.check('#editToggle');
    await page.fill(`[data-new-item="${actionSection.id}"]`, `${TAG} Акциска цел`);
    await page.click(`[data-add-item="${actionSection.id}"]`);
    await page.waitForTimeout(900);
    const [actionItem] = await q('SELECT id FROM evidence_items WHERE label = $1', [`${TAG} Акциска цел`]);
    check('a goal entered in that section reaches the database', !!actionItem?.id, JSON.stringify(actionItem));

    await page.uncheck(actionToggle);
    await page.waitForTimeout(700);
    check('an excluded section remains visible while editing but its scores are locked',
        await page.isDisabled(`select.ss[data-item="${actionItem.id}"]`), 'the excluded cell was editable');
    await page.check(actionToggle);
    await page.waitForTimeout(700);
    await page.uncheck('#editToggle');
    const actionCell = page.locator(`select.ss[data-item="${actionItem.id}"]`).first();
    await actionCell.selectOption('2');
    await page.waitForTimeout(700);
    checkEq('the action-plan assessment is signed in the database',
        (await q(`SELECT value, updated_by FROM evidence_scores
                  WHERE sheet_id = $1 AND item_id = $2`, [sheetRow.id, actionItem.id]))
            .map((row) => [row.value, row.updated_by]), [['2', THERAPIST_A]]);
    check('a level-scale action section refreshes its own summary after the write',
        /\d+%/.test(await page.textContent(`table[data-score-section="${actionSection.id}"] tr.ev`)),
        await page.textContent(`table[data-score-section="${actionSection.id}"] tr.ev`));

    console.log('\na teacher signs and writes through the same page');
    const teacherCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const teacherPage = await teacherCtx.newPage();
    const teacherErrors = [];
    teacherPage.on('pageerror', (e) => teacherErrors.push(String(e)));
    await teacherPage.goto(`${BASE}/AkciskiPlan.html?year=${encodeURIComponent(YEAR)}`);
    await gateReady(teacherPage);
    const teacherRef = `teacher:${fixture.teacher.id}`;
    await teacherPage.selectOption('#gateWho', teacherRef);
    await teacherPage.fill('#gatePin', PIN_B);
    await teacherPage.click('#gateSet');
    await teacherPage.fill('#gatePin2', PIN_B);
    await teacherPage.click('#gateSet');
    await pinReady(teacherPage, teacherRef);
    await teacherPage.selectOption('#gateWho', teacherRef);
    await teacherPage.fill('#gatePin', PIN_B);
    await teacherPage.click('#gateGo');
    await pupilReady(teacherPage, teacherErrors);
    checkEq('the page identifies the teacher who signed in',
        await teacherPage.textContent('#who'), TEACHER);
    await teacherPage.click('.pupil');
    await teacherPage.waitForSelector('#btnDelSheet', { timeout: 8000 });
    await teacherPage.click('.tab[data-p="pScores"]');
    await teacherPage.click('[data-doc="action"]');
    const teacherCell = teacherPage.locator(`select.ss[data-item="${actionItem.id}"]`).first();
    await teacherCell.selectOption('3');
    await teacherPage.waitForTimeout(700);
    checkEq('the teacher can write their category and stamps the shared score',
        (await q(`SELECT value, updated_by FROM evidence_scores
                  WHERE sheet_id = $1 AND item_id = $2`, [sheetRow.id, actionItem.id]))
            .map((row) => [row.value, row.updated_by]), [['3', TEACHER]]);
    check('the teacher browser has no page errors', teacherErrors.length === 0, teacherErrors.join('\n       '));
    await teacherCtx.close();

    // Keep the first download below on the prescribed document.
    await page.click('[data-doc="prescribed"]');

    // ── printing ─────────────────────────────────────────────────────────────
    console.log('\nprinting for Word');
    await page.click('.tab[data-p="pPrint"]');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 12000 }),
        page.click('#btnDocOne')
    ]);
    const doc = await readFile(await download.path(), 'utf8');
    check('the document names the pupil', doc.includes(PUPIL), download.suggestedFilename());
    check('it carries the prescribed heading',
        doc.includes('ЕВИДЕНТЕН ЛИСТ ЗА СЛЕДЕЊЕ НА РАЗВОЈОТ'), '');
    const periodLabels = (await q(
        'SELECT label FROM evidence_periods WHERE school_year_id = $1 AND active ORDER BY ord',
        [fixture.year.id])).map((r) => r.label);
    check('and one column per period of THIS year, not a fixed three',
        periodLabels.every((label) => doc.includes(label)), periodLabels.join(' | '));
    check('the printed form uses the server value learned from the earlier conflict',
        doc.includes(`1. ${TAG} Пробна ставка</td><td style="text-align:center;">3</td>`), 'stale score in print');
    check('the verdict wording of the form is printed under each section',
        doc.includes('целосно ниво 3') && doc.includes('ОПШТА ПРОЦЕНКА НА СОСТОЈБАТА'), '');

    await page.click('.tab[data-p="pScores"]');
    await page.click('[data-doc="action"]');
    await page.click('.tab[data-p="pPrint"]');
    const [actionDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 12000 }),
        page.click('#btnDocOne')
    ]);
    const actionDoc = await readFile(await actionDownload.path(), 'utf8');
    check('the action-plan download is a separate document',
        actionDoc.includes('АКЦИСКИ ПЛАН')
            && !actionDoc.includes('ЕВИДЕНТЕН ЛИСТ ЗА СЛЕДЕЊЕ НА РАЗВОЈОТ'),
        actionDownload.suggestedFilename());
    check('it carries the goal, its periods and the person who entered the mark',
        actionDoc.includes(`${TAG} Акциска цел`)
            && periodLabels.every((label) => actionDoc.includes(label))
            && actionDoc.includes(TEACHER), 'the action record is incomplete');
    check('it does not leak the diagnosis or sensory appendices from the evidence form',
        !actionDoc.includes('Дијагноза според Наод и мислење')
            && !actionDoc.includes('ГОВОР, ГЛАС И КОМУНИКАЦИЈА'), 'evidence-only panels were appended');

    console.log('\nphone width');
    await page.click('.tab[data-p="pScores"]');
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await page.evaluate(() => {
        const side = document.querySelector('.side');
        const tableWrap = document.querySelector('#pScores .tw');
        const style = getComputedStyle(side);
        const suspects = [...document.querySelectorAll('body *')].map((node) => {
            const rect = node.getBoundingClientRect();
            const css = getComputedStyle(node);
            return {
                node: node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`,
                left: Math.round(rect.left), right: Math.round(rect.right),
                width: Math.round(rect.width), scroll: node.scrollWidth,
                overflow: css.overflowX
            };
        }).filter((row) => (row.left < -1 || row.right > window.innerWidth + 1)
            && row.overflow === 'visible').slice(0, 12);
        return {
            pageFits: document.documentElement.scrollWidth <= window.innerWidth,
            pageWidth: document.documentElement.scrollWidth,
            sideMax: parseFloat(style.maxHeight),
            tableScrolls: tableWrap ? ['auto', 'scroll'].includes(getComputedStyle(tableWrap).overflowX) : false,
            suspects
        };
    });
    check('the record stays inside the phone viewport', phone.pageFits, JSON.stringify(phone));
    check('the pupil list is capped instead of pushing the form off-screen',
        phone.sideMax > 0 && phone.sideMax <= 360, JSON.stringify(phone));
    check('wide assessment tables scroll inside their own pane', phone.tableScrolls, JSON.stringify(phone));

    // ── signing out, and honesty when the server is gone ─────────────────────
    console.log('\nsigning out, and losing the server');
    await page.click('#btnOut');
    await page.waitForTimeout(600);
    check('signing out puts the gate back', await page.isVisible('#gate'), '');
    checkEq('and the token is gone from this browser',
        await page.evaluate(() => localStorage.getItem('evidence_token_v1')), null);

    await ctx.route('**/api/**', (r) => r.abort());
    await page.reload();
    await page.waitForTimeout(1500);
    check('with no server it explains rather than drawing an empty form',
        /Нема врска со серверот/.test(await page.content()), '');

    check('no page errors', errors.length === 0, errors.join('\n       '));
    check('no page errors in the second therapist\'s browser', secondErrors.length === 0,
        secondErrors.join('\n       '));

    await cleanup();
    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    await browser?.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
