/**
 * The one pupil form (`mtb-forms.js`), in a real browser, against a real server.
 *
 *     npm run start                    # in one terminal
 *     npm run test:forms
 *
 * The owner's rule, 24 Sep 2026: where a pupil is shown, the pupil can be
 * changed on the spot — one form, opened from every screen, behind one
 * „✏️ Уреди" switch. What this proves, read back from the DATABASE:
 *
 *   1. Nothing changes for anyone who never touches the switch: no door is
 *      visible and nothing is written to the browser.
 *   2. The form writes what it shows, through the pupil API that already owns
 *      it, and the page it was opened from redraws — and so does another page.
 *   3. A stale form is refused and keeps what was typed; an unsaved draft is
 *      not thrown away by Esc without asking.
 *   4. „Тргни од листата" and „Избриши — грешка при внес" are different acts,
 *      and the second is refused for anybody who is on another year's list.
 *   5. It is readable in both themes and fits a phone.
 *
 * Its people are invented and prefixed, in school years of its own, so it can
 * share a database with a real school (rule 1). No screenshots (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const TAG = 'browser-forms';
const YEAR = '1910/1911-forms';
const OTHER_YEAR = '1909/1910-forms';
const CLASS_A = 'ФОРМ-А';
const CLASS_B = 'ФОРМ-Б';
const T1 = `${TAG} Терапевт Прв`;
const T2 = `${TAG} Терапевт Втор`;
const P1 = { id: `${TAG}-p1`, name: `${TAG} Ученик Прв` };
const P2 = { id: `${TAG}-p2`, name: `${TAG} Ученик Втор` };

const pool = new pg.Pool({ connectionString: DB });
const q = async (text, args = []) => (await pool.query(text, args)).rows;

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};

async function cleanup() {
    await q(`DELETE FROM therapist_students WHERE student_id IN (SELECT id FROM students WHERE public_id LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM school_years WHERE label IN ($1, $2)`, [YEAR, OTHER_YEAR]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM school_classes WHERE label IN ($1, $2)`, [CLASS_A, CLASS_B]);
    await q(`DELETE FROM therapists WHERE name LIKE $1`, [`${TAG}%`]);
    // Migration 035 keeps a staff identity when the profile goes; the
    // fixture's must go too, or `check:names` learns these invented names.
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
    const [year] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
        VALUES ($1, '1910-09-01', '1911-08-31', false) RETURNING id`, [YEAR]);
    const [other] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
        VALUES ($1, '1909-09-01', '1910-08-31', false) RETURNING id`, [OTHER_YEAR]);
    for (const [label, key] of [[CLASS_A, '98-а'], [CLASS_B, '98-б']]) {
        const [cls] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id`, [label, key]);
        await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [year.id, cls.id]);
    }
    const therapists = [];
    for (const name of [T1, T2]) {
        const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]);
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [year.id, t.id]);
        therapists.push(t.id);
    }
    const pupils = {};
    for (const p of [P1, P2]) {
        const [s] = await q(`INSERT INTO students (public_id, name, grade, active) VALUES ($1, $2, $3, true) RETURNING id`,
            [p.id, p.name, CLASS_A]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, active) VALUES ($1, $2, $3, true)`,
            [s.id, year.id, CLASS_A]);
        pupils[p.id] = s.id;
    }
    // P1 was also on last year's list, so it is somebody, not a typo.
    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, active) VALUES ($1, $2, $3, true)`,
        [pupils[P1.id], other.id, CLASS_A]);
    await q(`INSERT INTO therapist_students (student_id, school_year_id, therapist_id) VALUES ($1, $2, $3)`,
        [pupils[P1.id], year.id, therapists[0]]);
    return { year, therapists };
}

const enrolment = async (publicId) => (await q(
    `SELECT e.grade, e.programme, e.placement, e.active FROM student_enrollments e
       JOIN students s ON s.id = e.student_id JOIN school_years y ON y.id = e.school_year_id
      WHERE s.public_id = $1 AND y.label = $2`, [publicId, YEAR]))[0];
const therapistsOf = async (publicId) => (await q(
    `SELECT t.name FROM therapist_students ts JOIN therapists t ON t.id = ts.therapist_id
       JOIN students s ON s.id = ts.student_id JOIN school_years y ON y.id = ts.school_year_id
      WHERE s.public_id = $1 AND y.label = $2 ORDER BY t.name`, [publicId, YEAR])).map((r) => r.name);

/** WCAG contrast of an element's text against the dialog's own background. */
async function contrasts(page) {
    return page.evaluate(() => {
        const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => {
            const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
        const dialog = document.querySelector('dialog.mtb-form');
        const bg = rgb(getComputedStyle(dialog).backgroundColor);
        const on = (sel, own) => {
            const n = dialog.querySelector(sel);
            if (!n) return 0;
            const s = getComputedStyle(n);
            return ratio(rgb(s.color), own ? rgb(s.backgroundColor) : bg);
        };
        return {
            title: on('h2'), label: on('label'), select: on('select', true),
            primary: on('.mtb-form__primary', true), danger: on('.mtb-form__danger', true)
        };
    });
}

const run = async () => {
    const { therapists } = await seed();
    console.log(`the one pupil form — ${YEAR}\n`);

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());

    await page.goto(`${BASE}/Podatoci.html?year=${encodeURIComponent(YEAR)}`);
    await page.waitForSelector('#students table.list', { timeout: 8000 });
    const door = (p) => `#students [data-mtb-door="pupil"][data-id="${p.id}"]`;

    console.log('nothing changes until somebody switches editing on');
    check('each pupil row carries a door', await page.$(door(P1)) !== null);
    check('but it is not visible', !(await page.isVisible(door(P1))));
    checkEq('and nothing was written to the browser', await page.evaluate(() => localStorage.getItem('mtb_editing_v1')), null);
    const toggle = '#mtbAppNav [data-mtb-editing-switch]';
    checkEq('the bar has the switch, off', await page.$eval(toggle, (b) => [b.textContent, b.getAttribute('aria-pressed')]),
        ['✏️ Уреди', 'false']);

    await page.click(toggle);
    checkEq('switched on, it says so', await page.$eval(toggle, (b) => b.getAttribute('aria-pressed')), 'true');
    check('and the doors appear', await page.isVisible(door(P1)));
    checkEq('the choice is remembered in this browser', await page.evaluate(() => localStorage.getItem('mtb_editing_v1')), '1');

    console.log('\nthe form shows what the database holds');
    await page.click(door(P1));
    await page.waitForSelector('dialog.mtb-form[open] form select[name="grade"]', { timeout: 6000 });
    const shown = await page.evaluate(() => {
        const f = document.querySelector('dialog.mtb-form form');
        return {
            title: document.querySelector('dialog.mtb-form h2').textContent,
            name: f.elements.name.value, grade: f.elements.grade.value,
            therapists: [...f.querySelectorAll('input[name="therapist"]')].map((n) => [n.closest('label').textContent.trim(), n.checked])
        };
    });
    checkEq('the pupil, their class and their therapists', shown, {
        title: P1.name, name: P1.name, grade: CLASS_A, therapists: [[T2, false], [T1, true]].sort((a, b) => a[0].localeCompare(b[0], 'mk'))
    });

    const light = await contrasts(page);
    check('readable in the light theme (≥ 4.5:1)', Object.values(light).every((r) => r >= 4.5), JSON.stringify(light));
    await page.evaluate(() => window.MTBTheme.set('dark'));
    const dark = await contrasts(page);
    check('and in the dark theme', Object.values(dark).every((r) => r >= 4.5), JSON.stringify(dark));
    await page.evaluate(() => window.MTBTheme.set('light'));

    await page.setViewportSize({ width: 400, height: 800 });
    const fit = await page.evaluate(() => {
        const d = document.querySelector('dialog.mtb-form');
        const r = d.getBoundingClientRect();
        const body = d.querySelector('.mtb-form__body');
        return { left: r.left >= 0, right: r.right <= window.innerWidth, noSideScroll: body.scrollWidth <= body.clientWidth };
    });
    checkEq('at phone width it fits, with no sideways scrolling', fit, { left: true, right: true, noSideScroll: true });
    await page.setViewportSize({ width: 1400, height: 1000 });

    console.log('\na save goes to the database, and the page redraws from it');
    // A second page of the same browser, as another window of the Workspace would be.
    const other = await ctx.newPage();
    await other.goto(`${BASE}/RasporediFusion.html?year=${encodeURIComponent(YEAR)}`);
    await other.waitForFunction(() => document.querySelector('#year') && !document.querySelector('#year').disabled, null, { timeout: 10000 });
    // Its own first load must be over, or that load would pass for the reload.
    await other.waitForLoadState('networkidle');
    let otherReloaded = false;
    other.on('request', (r) => { if (r.url().includes('/api/roster')) otherReloaded = true; });

    await page.selectOption('dialog.mtb-form select[name="grade"]', CLASS_B);
    await page.selectOption('dialog.mtb-form select[name="programme"]', 'modified');
    await page.check(`dialog.mtb-form input[name="therapist"][value="${therapists[1]}"]`);
    await page.click('dialog.mtb-form .mtb-form__primary');
    await page.waitForSelector('dialog.mtb-form', { state: 'detached', timeout: 6000 });
    const stored = await enrolment(P1.id);
    checkEq('class and programme are stored', [stored.grade, stored.programme], [CLASS_B, 'modified']);
    checkEq('and both therapists', await therapistsOf(P1.id), [T2, T1].sort());
    await page.waitForTimeout(900);
    checkEq('the row in Податоци redrew with the new class',
        await page.$eval(`#students tr[data-student="${P1.id}"] .s-grade`, (s) => s.value), CLASS_B);
    check('and the other window heard it and reloaded', otherReloaded);

    console.log('\na stale form is refused and keeps what was typed');
    await page.click(door(P1));
    await page.waitForSelector('dialog.mtb-form[open] form select[name="placement"]', { timeout: 6000 });
    await q(`UPDATE students SET name = $2 WHERE public_id = $1`, [P1.id, P1.name + ' Пр']);
    await page.selectOption('dialog.mtb-form select[name="placement"]', 'observation');
    await page.click('dialog.mtb-form .mtb-form__primary');
    await page.waitForTimeout(900);
    const refused = await page.evaluate(() => ({
        open: Boolean(document.querySelector('dialog.mtb-form[open]')),
        status: document.querySelector('dialog.mtb-form .mtb-form__status').textContent,
        placement: document.querySelector('dialog.mtb-form select[name="placement"]').value
    }));
    checkEq('the form stays open, with the draft', [refused.open, refused.placement], [true, 'observation']);
    check('and says why', /изменети/.test(refused.status), refused.status);
    checkEq('the database kept what it had', (await enrolment(P1.id)).placement, 'unknown');

    console.log('\nEsc does not throw a draft away without asking');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('it asks', await page.isVisible('dialog.mtb-form .mtb-form__ask'));
    await page.click('dialog.mtb-form [data-answer="no"]');
    check('„продолжи" keeps the form and the draft',
        await page.$eval('dialog.mtb-form select[name="placement"]', (s) => s.value) === 'observation');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.click('dialog.mtb-form [data-answer="yes"]');
    await page.waitForSelector('dialog.mtb-form', { state: 'detached', timeout: 4000 });
    check('„отфрли" closes it', true);

    console.log('\ntaking off the list and deleting a typo are different acts');
    await page.click('#refresh').catch(() => {});
    await page.waitForTimeout(900);
    await page.click(door(P1));
    await page.waitForSelector('dialog.mtb-form[open] .mtb-form__zone', { timeout: 6000 });
    await page.click('dialog.mtb-form .mtb-form__zone summary');
    await page.click('dialog.mtb-form [data-act="purge"]');
    await page.click('dialog.mtb-form [data-answer="yes"]');
    await page.waitForTimeout(900);
    const notTypo = await page.$eval('dialog.mtb-form .mtb-form__status', (n) => n.textContent);
    check('a pupil on another year\'s list is not deleted', /Не може да се избрише/.test(notTypo), notTypo);
    checkEq('and is still in the database', (await q(`SELECT count(*)::int AS n FROM students WHERE public_id = $1`, [P1.id]))[0].n, 1);

    await page.click('dialog.mtb-form [data-act="leave"]');
    await page.click('dialog.mtb-form [data-answer="yes"]');
    await page.waitForSelector('dialog.mtb-form', { state: 'detached', timeout: 6000 });
    checkEq('„Тргни од листата" ends the year\'s membership', (await enrolment(P1.id)).active, false);
    checkEq('and removes nobody', (await q(`SELECT count(*)::int AS n FROM students WHERE public_id = $1`, [P1.id]))[0].n, 1);

    await page.waitForTimeout(600);
    await page.click(door(P2));
    await page.waitForSelector('dialog.mtb-form[open] .mtb-form__zone', { timeout: 6000 });
    await page.click('dialog.mtb-form .mtb-form__zone summary');
    await page.click('dialog.mtb-form [data-act="purge"]');
    await page.click('dialog.mtb-form [data-answer="yes"]');
    await page.waitForSelector('dialog.mtb-form', { state: 'detached', timeout: 6000 });
    checkEq('a typo with nothing behind it is deleted', (await q(`SELECT count(*)::int AS n FROM students WHERE public_id = $1`, [P2.id]))[0].n, 0);

    console.log('\nthe same form opens from Кабинети');
    await other.bringToFront();
    await other.click('#rosterTab');
    await other.waitForSelector('#rosterTherapist option', { state: 'attached', timeout: 6000 });
    await other.selectOption('#rosterTherapist', String(therapists[0]));
    await other.waitForTimeout(400);
    // P1 has left the year's list, so bring them back first to have a row.
    await q(`UPDATE student_enrollments SET active = true WHERE student_id = (SELECT id FROM students WHERE public_id = $1)
              AND school_year_id = (SELECT id FROM school_years WHERE label = $2)`, [P1.id, YEAR]);
    await other.evaluate(() => window.dispatchEvent(new CustomEvent('mtb:saved', { detail: {} })));
    await other.waitForSelector(`#therapistRosterRows [data-mtb-door="pupil"][data-id="${P1.id}"]`, { timeout: 8000 });
    check('the door is there, and on, because the switch is one for the browser',
        await other.isVisible(`#therapistRosterRows [data-mtb-door="pupil"][data-id="${P1.id}"]`));
    await other.click(`#therapistRosterRows [data-mtb-door="pupil"][data-id="${P1.id}"]`);
    await other.waitForSelector('dialog.mtb-form[open] form select[name="grade"]', { timeout: 6000 });
    checkEq('and it is the same form, with the same pupil', await other.$eval('dialog.mtb-form h2', (h) => h.textContent), P1.name + ' Пр');
    await other.keyboard.press('Escape');

    console.log('\nswitching it off hides every door again');
    await page.bringToFront();
    await page.click(toggle);
    check('no door is visible', !(await page.isVisible(door(P1))));
    checkEq('and the flag is gone from the browser', await page.evaluate(() => localStorage.getItem('mtb_editing_v1')), null);

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await cleanup();
    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
