/**
 * Nastava.html, in a real browser, against a real server.
 *
 *     npm run start                      # in one terminal
 *     node test/nastava.browser.mjs
 *
 * Every assertion here is about what a teacher would read off the screen, and
 * the numbers on the screen are checked against the DATABASE — never against
 * what the page itself believes.
 *
 * The year boundary matters most: through 2025/2026 an 08:00 session crosses
 * the old 07:30 bells, while 2026/2027 onward starts at 08:00 and the same
 * session belongs wholly to lesson 1.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@127.0.0.1:5432/therapy_dev';
const DAY = 'среда';
const TAG = 'browser-crossing';
const YEAR = process.env.SCHOOL_YEAR || null;

const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};

async function q(text, args) { return (await pool.query(text, args)).rows; }

async function cleanup() {
    await q(`DELETE FROM schedule_slots WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM therapist_students WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM therapists WHERE name LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
}

/**
 * Two children from one class, taken in the first cabinet block on a day the
 * timetable already covers. Their class is read from the timetable itself, so
 * this works against whatever workbook has been imported.
 */
async function seed() {
    await cleanup();
    const [selectedYear] = await q(
        `SELECT id, label, starts_on >= date '2026-09-01' AS aligned FROM school_years
         WHERE ($1::text IS NULL AND is_current) OR label = $1 LIMIT 1`,
        [YEAR]
    );
    if (!selectedYear) throw new Error(`No school year ${YEAR || '(current)'}.`);
    const [pick] = await q(
        `SELECT c.label FROM lessons l JOIN school_classes c ON c.id = l.class_id
          WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal IN (1, 2, 3)
          GROUP BY c.label HAVING count(DISTINCT l.ordinal) = 3
          ORDER BY c.label LIMIT 1`, [selectedYear.id, DAY]
    );
    if (!pick) throw new Error(`No class with the first three lessons on ${DAY}. Import a timetable first.`);
    const label = pick.label;

    const ids = [];
    for (const [n, name] of [['a', 'Прв Пробен'], ['b', 'Втор Пробен']]) {
        const [row] = await q(
            `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
            [`${TAG}-${n}`, `${TAG} ${name}`, label]
        );
        ids.push(row.id);
        await q(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade)
             VALUES ($1, $2, $3)`,
            [row.id, selectedYear.id, label]
        );
    }
    const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} Терапевт`]);
    await q(
        `INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`,
        [selectedYear.id, t.id]
    );
    // One child in block I (08:00), one in block III (09:40).
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, 3, '08:00-08:40', $3, $4)`, [selectedYear.id, DAY, t.id, ids[0]]);
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, 3, '09:40-10:20', $3, $4)`, [selectedYear.id, DAY, t.id, ids[1]]);
    return { label, year: selectedYear, aligned: selectedYear.aligned === true };
}

const run = async () => {
    const { label, year, aligned } = await seed();
    console.log(`crossing in a browser — class ${label}, ${DAY}\n`);

    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());

    await page.goto(`${BASE}/Nastava.html?year=${encodeURIComponent(year.label)}`);
    await page.waitForTimeout(1200);
    await page.selectOption('#day', DAY);
    await page.waitForTimeout(1500);

    const cellOf = async (ordinal) => page.evaluate(([cls, ord]) => {
        const rows = Array.from(document.querySelectorAll('#grid tbody tr'));
        const row = rows.find((r) => r.querySelector('th')?.textContent.trim() === cls);
        if (!row) return null;
        const td = row.querySelectorAll('td')[ord - 1];
        if (!td) return null;
        return {
            text: td.textContent.trim(),
            count: Number(td.querySelector('.count')?.textContent || 0),
            heat: (td.className.match(/heat-\d/) || [''])[0],
            title: td.getAttribute('title') || ''
        };
    }, [label, ordinal]);

    const firstHeader = await page.evaluate(() => document.querySelector('#grid thead th:nth-child(2) small')?.textContent.trim());
    checkEq('the first bell matches the selected school year', firstHeader, aligned ? '08:00' : '07:30');

    console.log('the year-specific crossing, on screen');
    const first = await cellOf(1);
    const second = await cellOf(2);
    check('the grid drew the class', !!first && !!second, JSON.stringify({ first, second }));
    const firstSession = aligned ? first : second;
    check(`the ${aligned ? 'FIRST' : 'SECOND'} lesson shows somebody missing`, firstSession.count >= 1);
    check('and the occupied lesson is shaded', /^heat-\d$/.test(firstSession.heat), firstSession.heat);
    check('the tooltip names the subject and the teacher',
        /·/.test(firstSession.title) && firstSession.title.includes(label), firstSession.title);

    const laterOrdinal = aligned ? 3 : 4;
    const laterNeighbour = aligned ? 4 : 3;

    const detailOf = async (ordinal) => {
        const cell = page.locator(`#grid td[data-key="${label}|${ordinal}"]`);
        if (await cell.count() === 0) return { open: false, text: '' };
        await cell.click();
        await page.waitForTimeout(200);
        return page.evaluate(() => {
            const box = document.getElementById('detail');
            return {
                open: box.classList.contains('open'),
                text: box.textContent.replace(/\s+/g, ' ').trim()
            };
        });
    };

    const firstDetail = await detailOf(aligned ? 1 : 2);
    check('the 08:00 child is in the correct lesson', firstDetail.text.includes('Прв Пробен'), firstDetail.text);
    const firstNeighbourDetail = await detailOf(aligned ? 2 : 1);
    check('the 08:00 child is not in the neighbouring lesson',
        !firstNeighbourDetail.text.includes('Прв Пробен'), firstNeighbourDetail.text);
    const laterDetail = await detailOf(laterOrdinal);
    check(`the 09:40 child is in lesson ${laterOrdinal}`, laterDetail.text.includes('Втор Пробен'), laterDetail.text);
    const laterNeighbourDetail = await detailOf(laterNeighbour);
    check('the 09:40 child is not in its neighbouring lesson',
        !laterNeighbourDetail.text.includes('Втор Пробен'), laterNeighbourDetail.text);

    console.log('\nthe screen agrees with the database');
    const dbCount = await q(
        `SELECT count(*)::int AS n FROM schedule_slots sl
           JOIN students st ON st.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.day = $2 AND st.public_id LIKE $3`,
        [year.id, DAY, `${TAG}%`]
    );
    checkEq('two sessions were seeded', dbCount[0].n, 2);
    const onScreen = await page.evaluate(() => Array.from(document.querySelectorAll('#grid .count'))
        .reduce((n, el) => n + Number(el.textContent || 0), 0));
    check('every seeded session is visible somewhere in the grid', onScreen >= 2, `grid total ${onScreen}`);

    console.log('\nclicking a cell names the children and the therapist');
    const detail = await detailOf(aligned ? 1 : 2);
    check('the panel opened', detail.open);
    check('it names the child', detail.text.includes('Прв Пробен'), detail.text);
    check('it names the therapist', detail.text.includes('Терапевт'), detail.text);
    check('and it says how much of the lesson they miss',
        new RegExp((aligned ? 40 : 25) + ' мин').test(detail.text), detail.text);

    console.log('\nnothing is quietly folded');
    // A child whose class the timetable does not know must be listed, not hidden.
    const [orphan] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
        [`${TAG}-x`, `${TAG} Трет Пробен`, 'НЕПОСТОЕЧКО-99']
    );
    await q(
        `INSERT INTO student_enrollments (student_id, school_year_id, grade)
         VALUES ($1, $2, $3)`,
        [orphan.id, year.id, 'НЕПОСТОЕЧКО-99']
    );
    const [t2] = await q(`SELECT id FROM therapists WHERE name = $1`, [`${TAG} Терапевт`]);
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, 3, '10:25-11:05', $3, $4)`, [year.id, DAY, t2.id, orphan.id]);
    await page.click('#refresh');
    await page.waitForTimeout(1200);
    const unplaced = await page.evaluate(() => document.getElementById('unplaced').textContent.replace(/\s+/g, ' ').trim());
    check('the unplaceable session is listed', unplaced.includes('Трет Пробен'), unplaced.slice(0, 300));
    // The server answers in English; the staff room reads Macedonian. The page
    // owns the sentence, so this asserts the sentence and not the code.
    check('with a reason a person can act on, in Macedonian',
        /не постои во распоредот на настава/.test(unplaced), unplaced.slice(0, 300));

    await page.screenshot({ path: 'nastava-page.png', fullPage: true });
    console.log('  →   screenshot at server/nastava-page.png');

    console.log('\nthe tab is honest when the server is gone');
    await ctx.route('**/api/teaching/**', (r) => r.abort());
    await page.click('#refresh');
    await page.waitForTimeout(1200);
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('it says the server is unreachable rather than drawing an empty school',
        /не одговара/.test(status), status);
    const gridAfter = await page.evaluate(() => document.getElementById('grid').innerHTML.trim());
    check('and it explains why instead of drawing an empty school',
        /Нема врска со серверот/.test(gridAfter), gridAfter.slice(0, 160));

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await cleanup();
    await browser.close();
    await pool.end();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
