/**
 * „Одделенија“ in Podatoci.html: who is in the class, and the way in.
 *
 *     npm run start                    # in one terminal
 *     npm run test:podatoci-classes
 *
 * The tab used to answer „how many“ and stop there. A count is the one thing
 * about a class nobody needs help with: the question in front of a person
 * forming a year is WHICH children, and the answer lived one tab away with no
 * way across. So the row now names them, each name is the way to the screen
 * that owns it, and a dropdown puts a pupil in the class.
 *
 * TWO RULES THIS SUITE EXISTS TO PIN, both invisible on screen:
 *
 *   1. A pupil holds ONE class per school year — it is a single column on the
 *      enrolment. Putting them in a class therefore takes them out of the
 *      previous one by itself. If a second write ever appears to "remove them
 *      from the old class", that is a second owner of one fact (rule 5) and
 *      the two will disagree the first time one of them fails.
 *   2. Migration 029 says an ACTIVE internal or boarding pupil must have a
 *      class. Reached through a plain UPDATE that surfaces as HTTP 500 naming
 *      the constraint, which reads as a broken endpoint — and this screen is
 *      exactly where a person meets it. Checked to FAIL first: without the
 *      guard in roster-write.ts the last two assertions get 500, not 409.
 *
 * Its people are invented and prefixed and it works in a school year of its
 * own, so it can share a database with a real school (rule 1). No screenshot:
 * this page lists real children (rule 6).
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const TAG = 'browser-odd';
const YEAR = '1911/1912-odd';
const CLASS_A = 'ОДД-А';
const CLASS_B = 'ОДД-Б';
const CLASS_C = 'ОДД-В';
const TEACHER = `${TAG} Раководител`;

const pool = new pg.Pool({ connectionString: DB });

/**
 * WCAG contrast, because "is this readable?" was answered by looking and the
 * answer was wrong. A clickable chip is a <button>, and a button does NOT
 * inherit `color` — the browser gives it `buttontext`, which is BLACK. In the
 * light theme that passes at 18:1 and nobody notices; in the dark theme the
 * name fell to 2.0:1 and read as "the letters went dark again".
 */
const luminance = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const channels = (css) => css.match(/\d+/g).slice(0, 3).map(Number);
const contrast = (fg, bg) => {
    const [hi, lo] = [luminance(channels(fg)), luminance(channels(bg))].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
};

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const q = async (text, args = []) => (await pool.query(text, args)).rows;

async function cleanup() {
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM teachers WHERE name ILIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM school_classes WHERE label IN ($1, $2, $3)`, [CLASS_A, CLASS_B, CLASS_C]);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1911-09-01', '1912-08-31', false) RETURNING id, label`, [YEAR]);
    const classes = new Map();
    for (const [label, key] of [[CLASS_A, '11-а'], [CLASS_B, '11-б'], [CLASS_C, '11-в']]) {
        const [made] = await q(
            `INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id, label`, [label, key]);
        classes.set(label, made);
        await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [year.id, made.id]);
    }
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind, subject) VALUES ($1, 'odd', NULL) RETURNING id, name`, [TEACHER]);
    await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [year.id, teacher.id]);
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
             VALUES ($1, $2, $3, 'homeroom')`, [year.id, teacher.id, classes.get(CLASS_A).id]);

    // Two internal pupils in А, one in Б, and one external who is allowed to
    // carry no class at all — the asymmetry migration 029 exists to state.
    const people = [
        [`${TAG}-a`, `${TAG} Прва Ученичка`, CLASS_A, 'internal'],
        [`${TAG}-b`, `${TAG} Втор Ученик`,   CLASS_A, 'internal'],
        [`${TAG}-c`, `${TAG} Трета Ученичка`, CLASS_B, 'internal'],
        [`${TAG}-d`, `${TAG} Четврти Надворешен`, null, 'external']
    ];
    for (const [pid, name, grade, kind] of people) {
        const [s] = await q(
            `INSERT INTO students (public_id, name, grade, active) VALUES ($1, $2, $3, true) RETURNING id`,
            [pid, name, grade]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
                 VALUES ($1, $2, $3, $4, true)`, [s.id, year.id, grade, kind]);
    }
    return { year, teacher, classA: classes.get(CLASS_A) };
}

const gradeOf = async (yearId, pid) => (await q(
    `SELECT e.grade FROM student_enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.school_year_id = $1 AND s.public_id = $2`, [yearId, pid]))[0]?.grade ?? null;

const patch = (pid, body) => fetch(`${BASE}/api/students/${encodeURIComponent(pid)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

const run = async () => {
    const { year, teacher, classA } = await seed();
    console.log(`„Одделенија“ in a browser — ${YEAR}\n`);

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 1100 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());

    await page.goto(`${BASE}/Podatoci.html?year=${encodeURIComponent(YEAR)}`);
    await page.waitForSelector('#students table.list', { timeout: 8000 });
    await page.click('[data-tab="classes"]');
    await page.waitForSelector('#classes table.list tbody tr');

    const rowFor = (label) => page.locator('#classes tbody tr')
        .filter({ has: page.locator('.class-label', { hasText: new RegExp(`^${label}$`) }) });

    console.log('the row names its pupils, instead of only counting them');
    const named = await rowFor(CLASS_A).locator('[data-goto-student]').allTextContents();
    check('both pupils of the class are named', named.length === 2, JSON.stringify(named));
    check('and the count beside them agrees',
        (await rowFor(CLASS_A).locator('.count').textContent()).trim() === String(named.length));
    check('a class that HAS pupils does not also claim to be empty',
        await rowFor(CLASS_A).locator('.class-pupils .none').count() === 0);
    // A blank cell where a list belongs reads as a page that failed to draw.
    check('and an empty class says so in words, beside its 0',
        (await rowFor(CLASS_C).locator('.class-pupils').textContent()).includes('нема ученици'));

    console.log('\nwhere a fact is shown, the way to where it is changed');
    await rowFor(CLASS_A).locator('[data-goto-student]').first().click();
    await page.waitForTimeout(350);
    check('a pupil chip opens „Ученици“',
        await page.getAttribute('[data-tab="students"]', 'aria-pressed') === 'true');
    check('and marks that pupil’s own row', await page.locator('#students tr [class*="saved-mark"]').count() > 0);

    await page.click('[data-tab="classes"]');
    await rowFor(CLASS_A).locator('[data-goto-teacher]').first().click();
    await page.waitForTimeout(350);
    check('the homeroom chip opens „Наставници“',
        await page.getAttribute('[data-tab="teachers"]', 'aria-pressed') === 'true');
    check('on that teacher’s row',
        await page.locator(`#teachers tr[data-teacher="${teacher.id}"] [class*="saved-mark"]`).count() > 0);

    console.log('\nthe dropdown that puts a pupil in the class');
    await page.click('[data-tab="classes"]');
    await rowFor(CLASS_B).locator('[data-edit-class-students]').click();
    await page.waitForSelector('#classAddStudent');
    const options = (await page.locator('#classAddStudent option').allTextContents()).map((o) => o.trim());
    const moving = options.find((o) => o.startsWith(`${TAG} Прва Ученичка`));
    check('it says where a pupil is now, so a move is not a surprise',
        !!moving && moving.includes(`сега ${CLASS_A}`), moving);
    check('it offers the external pupil as being without a class',
        options.some((o) => o.startsWith(`${TAG} Четврти`) && o.includes('без одделение')));
    check('and omits whoever is already in this class',
        !options.some((o) => o.startsWith(`${TAG} Трета Ученичка`)));

    await page.selectOption('#classAddStudent', { label: moving });
    await page.click('[data-add-class-student]');
    await page.waitForTimeout(1200);

    console.log('\nand the move is ONE fact, read back from the database');
    check(`the pupil is in ${CLASS_B}`, await gradeOf(year.id, `${TAG}-a`) === CLASS_B,
        `got ${await gradeOf(year.id, `${TAG}-a`)}`);
    const left = await q(
        `SELECT count(*)::int AS n FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND s.public_id = $2 AND e.grade = $3`,
        [year.id, `${TAG}-a`, CLASS_A]);
    check('and is no longer in the old one, with no second write to undo', left[0].n === 0);
    check('the pupil who was not moved is untouched', await gradeOf(year.id, `${TAG}-b`) === CLASS_A);

    console.log('\nan internal pupil is never offered a way out of every class');
    await page.click('[data-tab="classes"]');
    await rowFor(CLASS_A).locator('[data-edit-class-students]').click();
    await page.waitForSelector('[data-move-student]');
    const moveOptions = await page.locator('[data-move-student]').first().locator('option').allTextContents();
    check('no „без одделение“ for an internal pupil',
        !moveOptions.some((o) => o.includes('без одделение')), JSON.stringify(moveOptions));

    console.log('\nand the server says the rule rather than leaking the constraint');
    const refused = await patch(`${TAG}-a`, { grade: null, year: YEAR });
    const body = await refused.json();
    check('clearing an internal pupil’s class answers 409, not 500', refused.status === 409, `got ${refused.status}`);
    check('and names the rule, so the page can say it in Macedonian', body.needsClass === true);
    check('the refusal changed nothing', await gradeOf(year.id, `${TAG}-a`) === CLASS_B);

    const external = await patch(`${TAG}-d`, { grade: null, year: YEAR });
    check('while an EXTERNAL pupil may still have no class at all', external.status === 200,
        `got ${external.status}`);

    console.log('\nand the chip is readable in BOTH themes, measured');
    for (const scheme of ['dark', 'light']) {
        const themed = await ctx.newPage();
        await themed.emulateMedia({ colorScheme: scheme });
        await themed.goto(`${BASE}/Podatoci.html?year=${encodeURIComponent(YEAR)}`);
        await themed.waitForSelector('#students table.list', { timeout: 8000 });
        await themed.click('[data-tab="classes"]');
        await themed.waitForSelector('#classes .chip');
        const seen = await themed.evaluate(() => {
            const chip = document.querySelector('#classes .chip');
            const note = chip.querySelector('.none');
            const cs = getComputedStyle(chip);
            return { bg: cs.backgroundColor, name: cs.color,
                     note: note ? getComputedStyle(note).color : null };
        });
        const nameRatio = contrast(seen.name, seen.bg);
        check(`${scheme}: the pupil's name reads on the chip`, nameRatio >= 4.5,
            `${nameRatio.toFixed(2)}:1 — ${seen.name} on ${seen.bg}`);
        if (seen.note) {
            const noteRatio = contrast(seen.note, seen.bg);
            check(`${scheme}: and so does „· одд. X"`, noteRatio >= 4.5,
                `${noteRatio.toFixed(2)}:1 — ${seen.note} on ${seen.bg}`);
        }
        await themed.close();
    }

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await cleanup();
    await pool.end();
    console.log(fails ? `\n${fails} FAILED` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (err) => {
    console.error(err);
    try { await cleanup(); await pool.end(); } catch (_) { /* already gone */ }
    process.exit(1);
});
