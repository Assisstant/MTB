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
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind)
             VALUES ($1, $2, $3, $4)`,
            [row.id, selectedYear.id, label, n === 'a' ? 'external' : 'internal']
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
    await page.waitForTimeout(1500);
    // Owner, 27 Sep 2026: the class's week is the first view — each lesson,
    // and under it which child leaves it, for which cabinet, and when.
    check('it opens on the class\'s week', await page.getAttribute('#viewClassWeek', 'aria-pressed') === 'true');
    check('with no day to pick: every view is a week', await page.locator('#day').count() === 0);
    await page.selectOption('#klass', label);
    await page.waitForTimeout(500);
    const dayCol = await page.evaluate((d) => Array.from(document.querySelectorAll('#grid .personal thead th'))
        .map((th) => th.textContent.trim().toLowerCase()).indexOf(d), DAY);
    // As a person reads it: the lesson and its lines, one after the other.
    const cellOf = async (ordinal) => page.evaluate(([ord, col]) => {
        const row = document.querySelectorAll('#grid .personal tbody tr')[ord - 1];
        const td = row && row.querySelectorAll('td')[col - 1];
        return td ? td.innerText.replace(/\s+/g, ' ').trim() : null;
    }, [ordinal, dayCol]);

    const firstHeader = await page.evaluate(() => document.querySelector('#grid .personal tbody tr th small')?.textContent.trim());
    checkEq('the first bell matches the selected school year', firstHeader, aligned ? '08:00' : '07:30');

    console.log('the year-specific crossing, on screen');
    check('the sheet has the day the fixture uses', dayCol > 0, String(dayCol));
    const firstLesson = await cellOf(aligned ? 1 : 2);
    check(`the ${aligned ? 'FIRST' : 'SECOND'} lesson names the child who leaves it`,
        (firstLesson || '').includes('Прв Пробен'), firstLesson);
    check('and the cabinet that takes them, and when', /Терапевт/.test(firstLesson || '') && /08:00–08:40/.test(firstLesson || ''), firstLesson);
    const firstNeighbour = await cellOf(aligned ? 2 : 1);
    check('the 08:00 child is not in the neighbouring lesson', !(firstNeighbour || '').includes('Прв Пробен'), firstNeighbour);
    const laterOrdinal = aligned ? 3 : 4;
    const laterNeighbour = aligned ? 4 : 3;
    const later = await cellOf(laterOrdinal);
    check(`the 09:40 child is in lesson ${laterOrdinal}`, (later || '').includes('Втор Пробен'), later);
    const laterNext = await cellOf(laterNeighbour);
    check('the 09:40 child is not in its neighbouring lesson', !(laterNext || '').includes('Втор Пробен'), laterNext);
    check('an external pupil with a teaching group is not labelled as therapy-only',
        !(await page.locator('#external').innerText()).includes('Прв Пробен'));

    console.log('\nthe screen agrees with the database');
    const dbCount = await q(
        `SELECT count(*)::int AS n FROM schedule_slots sl
           JOIN students st ON st.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.day = $2 AND st.public_id LIKE $3`,
        [year.id, DAY, `${TAG}%`]
    );
    checkEq('two sessions were seeded', dbCount[0].n, 2);
    const sheetText = await page.evaluate(() => document.querySelector('#grid .personal').innerText);
    check('every seeded session is on the class\'s sheet', /Прв Пробен/.test(sheetText) && /Втор Пробен/.test(sheetText));

    console.log('\nthe overview counts them, and a click names the child and the therapist');
    await page.click('#viewWeek');
    await page.waitForTimeout(800);
    const overKey = `${DAY}|${label}|${aligned ? 1 : 2}`;
    const over = await page.evaluate((key) => {
        const td = document.querySelector(`#grid td[data-key="${key}"]`);
        return td ? { count: Number(td.querySelector('.count')?.textContent || 0), heat: (td.className.match(/heat-\d/) || [''])[0] } : null;
    }, overKey);
    check('the lesson counts somebody missing, and is shaded', over && over.count >= 1 && /^heat-[1-4]$/.test(over.heat), JSON.stringify(over));
    await page.click(`#grid td[data-key="${overKey}"]`);
    await page.waitForTimeout(300);
    const detail = await page.evaluate(() => {
        const box = document.getElementById('detail');
        return { open: box.classList.contains('open'), text: box.textContent.replace(/\s+/g, ' ').trim() };
    });
    check('the panel opened', detail.open);
    check('it names the child', detail.text.includes('Прв Пробен'), detail.text);
    check('it names the therapist', detail.text.includes('Терапевт'), detail.text);
    check('and it says how much of the lesson they miss',
        new RegExp((aligned ? 40 : 25) + ' мин').test(detail.text), detail.text);
    await page.keyboard.press('Escape');
    await page.click('#viewClassWeek');
    await page.waitForTimeout(500);

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
    //
    // And it asserts the SPLIT, not a fragment of one sentence. „НЕПОСТОЕЧКО-99"
    // is on nobody's list, so it must get the „neither timetabled nor on the
    // list" wording — while a class that IS formed and merely has no lessons
    // must not. One assertion that pins both, because the whole point of
    // separating them is that they send a person to different screens.
    check('with a reason a person can act on, in Macedonian',
        /не е ни во распоредот, ни на списокот паралелки/.test(unplaced), unplaced.slice(0, 300));
    check('and it says WHERE to fix that one',
        /провери го одделението во „Списоци и пристап"/.test(unplaced), unplaced.slice(0, 400));

    await page.screenshot({ path: 'nastava-page.png', fullPage: true });
    console.log('  →   screenshot at server/nastava-page.png');

    console.log('\nthe overview marks off-staff staff while keeping their names visible');
    await ctx.route('**/api/teaching/crossing*', async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        if (json.cells) {
            json.cells.push({
                day: DAY, dayOrder: 3, ordinal: 1, class: 'ТЕСТ-ОФФ', subject: 'тест',
                teacher: 'Пробен Наставник Офф', teacherOnStaff: false, away: [], awayCount: 0
            });
            json.cells.push({
                day: DAY, dayOrder: 3, ordinal: 1, class: 'ТЕСТ-ОН', subject: 'тест',
                teacher: 'Пробен Наставник Он', teacherOnStaff: true, away: [], awayCount: 0
            });
        }
        await route.fulfill({ json });
    });
    await page.click('#refresh');
    await page.waitForTimeout(1000);
    await page.click('#viewWeek');
    await page.waitForTimeout(600);

    const teacherHeaders = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('#grid tbody tr th')).map((th) => ({
            text: th.textContent.replace(/\s+/g, ' ').trim(),
            badge: th.querySelector('.off-staff')?.textContent.trim() || null
        }));
    });

    const offTeacher = teacherHeaders.find((t) => t.text.includes('Пробен Наставник Офф'));
    const onTeacher = teacherHeaders.find((t) => t.text.includes('Пробен Наставник Он'));

    check('the teacher view renders the marker text for an off-staff teacher',
        offTeacher && offTeacher.badge === 'не е на списокот оваа година', JSON.stringify(offTeacher));
    check('her name is still visible alongside the marker',
        offTeacher && offTeacher.text.includes('Пробен Наставник Офф'), JSON.stringify(offTeacher));
    check('a teacher who is on the list has no marker',
        onTeacher && onTeacher.badge === null, JSON.stringify(onTeacher));

    console.log('\nthe overview lists the STAFF, not a reading of the timetable');
    await ctx.unroute('**/api/teaching/crossing*');
    await ctx.route('**/api/teaching/crossing*', async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        // Three on the year's list; only one of them has a lesson. The fourth
        // name is on a lesson but NOT on the list.
        json.teachers = [
            { id: 9001, name: 'Пробен Соchas', kind: 'odd' },
            { id: 9002, name: 'Пробен Безчас', kind: 'pred' },
            { id: 9003, name: 'Пробен Празен', kind: 'pred' }
        ];
        json.cells = [
            { day: DAY, dayOrder: 3, ordinal: 1, class: 'ТЕСТ-С', subject: 'тест',
              teacher: 'Пробен Соchas', teacherOnStaff: true, away: [], awayCount: 0 },
            { day: DAY, dayOrder: 3, ordinal: 2, class: 'ТЕСТ-О', subject: 'тест',
              teacher: 'Пробен Отстранет', teacherOnStaff: false, away: [], awayCount: 0 }
        ];
        await route.fulfill({ json });
    });
    await page.click('#refresh');
    await page.waitForTimeout(1000);
    await page.click('#viewWeek');
    await page.waitForTimeout(600);

    const staffRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#grid tbody tr th'))
            .map((th) => th.textContent.replace(/\s+/g, ' ').trim()));

    // This is the assertion the screens disagreed on: „Податоци" listed
    // everybody on the year, this page listed only whoever had a lesson.
    check('a teacher on the year list with NO lesson still gets a row',
        staffRows.some((r) => r.includes('Пробен Безчас'))
        && staffRows.some((r) => r.includes('Пробен Празен')), JSON.stringify(staffRows));
    check('a teacher on a lesson but NOT on the list is shown and marked',
        staffRows.some((r) => r.includes('Пробен Отстранет') && r.includes('не е на списокот')),
        JSON.stringify(staffRows));
    check('nobody is listed twice',
        new Set(staffRows).size === staffRows.length, JSON.stringify(staffRows));

    console.log('\n⎙ the week as a poster: A2, or A2 on four A4 sheets');
    await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    await page.click('#printBtn');
    check('in the overview, „Печати" offers a choice first', await page.isVisible('#printMenu'));
    await page.click('[data-print="a2"]');
    // The banner's face is waited for (2.5 s at most) before the dialog opens.
    await page.waitForFunction(() => window.__printed >= 1, null, { timeout: 6000 });
    const a2 = await page.evaluate(() => ({
        printed: window.__printed,
        title: document.title,
        banner: (document.querySelector('#poster .pz-banner') || {}).textContent,
        page: (document.getElementById('posterPage') || {}).textContent || '',
        pages: document.querySelectorAll('#poster .pz-page.a2').length,
        sections: [...document.querySelectorAll('#poster .pz-sec')].map((s) => ({
            title: s.querySelector('h2').firstChild.textContent,
            names: [...s.querySelectorAll('tbody th')].map((th) => th.firstChild.textContent)
        }))
    }));
    check('one A2 landscape page', a2.pages === 1 && a2.page.includes('594mm 420mm'), JSON.stringify(a2));
    check('одделенска and предметна настава in separate tables, anyone else apart',
        JSON.stringify(a2.sections) === JSON.stringify([
            { title: 'Одделенска настава', names: ['Пробен Соchas'] },
            { title: 'Предметна настава', names: ['Пробен Безчас', 'Пробен Празен'] },
            { title: 'Други', names: ['Пробен Отстранет'] }]), JSON.stringify(a2.sections));
    const cells = await page.evaluate(() => [...document.querySelectorAll('#poster .pz-sec')].map((s) =>
        [...s.querySelectorAll('tbody td')].map((td) => td.textContent.trim()).filter((t) => t && t !== '/' && !/^\d+\.$/.test(t))));
    check('одделенска says the SUBJECT in the period, предметна the CLASS, and no counts',
        cells[0].includes('тестТЕСТ-С') && cells[2].includes('ТЕСТ-Отест')
        && await page.evaluate(() => !document.querySelector('#poster .pz-count')), JSON.stringify(cells));
    // Owner, 9 Oct 2026: under the class, the subject of that lesson — the
    // class first and whole, the subject small beneath it.
    const under = await page.evaluate(() => {
        const td = [...document.querySelectorAll('#poster .pz-sec')][2].querySelector('tbody td .pz-c').closest('td');
        return { first: td.firstElementChild.className, klass: td.querySelector('.pz-c').textContent,
                 subject: (td.querySelector('small') || {}).textContent, smalls: td.querySelectorAll('small').length };
    });
    checkEq('in предметна the period says the class and, under it, the subject once',
        under, { first: 'pz-c', klass: 'ТЕСТ-О', subject: 'тест', smalls: 1 });
    check('and the print dialog was opened', a2.printed === 1);
    check('the heading is „Распоред на часови", and so is the title the browser prints and names the PDF by',
        a2.banner === 'Распоред на часови' && /^Распоред на часови \d{4}-\d{4}/.test(a2.title), JSON.stringify([a2.banner, a2.title]));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    check('after printing the page is itself again',
        await page.evaluate(() => !document.body.dataset.print && !document.getElementById('posterPage')
            && !document.title.startsWith('Распоред на часови')));
    await page.click('#printBtn');
    await page.click('[data-print="tiles"]');
    await page.waitForFunction(() => window.__printed >= 2, null, { timeout: 6000 });
    const tiles = await page.evaluate(() => ({
        page: (document.getElementById('posterPage') || {}).textContent || '',
        pages: [...document.querySelectorAll('#poster .pz-page.tile')].map((p) => p.querySelector('.pz-area').style.transform)
    }));
    check('four A4 landscape sheets, each a quarter, overlapping by 1 cm',
        tiles.page.includes('297mm 210mm') && JSON.stringify(tiles.pages) === JSON.stringify([
            'translate(0mm, 0mm)', 'translate(-267mm, 0mm)', 'translate(0mm, -180mm)', 'translate(-267mm, -180mm)']),
        JSON.stringify(tiles));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

    // ⬇ PDF: the look is chosen first („Изглед на PDF"), then the FILE is made
    // by the page, so its pages are exactly the paper chosen whatever printer
    // is installed. The two libraries come from cdnjs; with no connection the
    // window says so, and so does this check, without failing.
    console.log('\n⬇ PDF: „Изглед на PDF", then a file of exactly the chosen paper');
    const fsMod = await import('node:fs');
    const openLook = async () => {
        await page.click('#printBtn');
        await page.click('[data-pdf="poster"]');
        await page.waitForSelector('.mtb-pdf', { timeout: 5000 });
        // The preview is drawn, or it says why it cannot be.
        return page.waitForFunction(() => {
            const d = document.querySelector('.mtb-pdf');
            if (!d) return 'gone';
            if (/не може/.test(d.querySelector('.say').textContent)) return 'offline';
            return d.querySelector('.wait').hidden ? 'drawn' : false;
        }, null, { timeout: 60000 }).then((h) => h.jsonValue(), () => 'timeout');
    };
    const first = await openLook();
    const look = await page.evaluate(() => ({
        formats: [...document.querySelectorAll('.mtb-pdf input[name=format]')].map((i) => i.value),
        parts: document.querySelectorAll('.mtb-pdf [data-part]').length,
        footer: !!document.querySelector('.mtb-pdf [data-k="footer.text"]') && !!document.querySelector('.mtb-pdf [data-k="footer.pages"]'),
        title: (document.querySelector('.mtb-pdf [data-k="title.text"]') || {}).value
    }));
    check('the window offers the paper, the title, what is on the sheet, the footer and the letters',
        JSON.stringify(look.formats) === JSON.stringify(['a2', 'a3', 'a4', 'a2-4', 'a3-2', 'a0-16'])
        && look.parts === 6 && look.footer && look.title === 'Распоред на часови', JSON.stringify(look));
    if (first === 'offline') {
        console.log('  skip ⬇ PDF: no connection to cdnjs');
        await page.click('.mtb-pdf [data-close]');
    } else {
        check('and draws a preview of the sheet', first === 'drawn', first);
        const download = async (format) => {
            await page.check(`.mtb-pdf input[name=format][value="${format}"]`);
            const [got] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.mtb-pdf [data-make]')]);
            const text = fsMod.readFileSync(await got.path()).toString('latin1');
            return {
                name: got.suggestedFilename(), pdf: text.startsWith('%PDF'),
                boxes: [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)]
                    .map((m) => `${Math.round(m[1] * 25.4 / 72)}x${Math.round(m[2] * 25.4 / 72)}`)
            };
        };
        const a2 = await download('a2');
        check('A2: one page of exactly 594 × 420 mm, named after the timetable',
            a2.pdf && JSON.stringify(a2.boxes) === '["594x420"]' && /^Распоред на часови .* — A2\.pdf$/.test(a2.name), JSON.stringify(a2));
        check('the window closes and the page is itself again', await page.waitForFunction(() =>
            !document.querySelector('.mtb-pdf') && !document.getElementById('poster').innerHTML, null, { timeout: 5000 }).then(() => true, () => false));
        await openLook();
        // A changed title names the file; an unticked table stays unticked next time.
        await page.fill('.mtb-pdf [data-k="title.text"]', 'Тест распоред');
        await page.uncheck('.mtb-pdf [data-part="pred"]');
        const tiles = await download('a2-4');
        check('A2 on four A4: four pages of exactly 297 × 210 mm, with the chosen title in the name',
            tiles.pdf && JSON.stringify(tiles.boxes) === JSON.stringify(['297x210', '297x210', '297x210', '297x210'])
            && /^Тест распоред .* — A2 на 4 листа A4\.pdf$/.test(tiles.name), JSON.stringify(tiles));
        await openLook();
        const again = await page.evaluate(() => ({
            format: (document.querySelector('.mtb-pdf input[name=format]:checked') || {}).value,
            pred: document.querySelector('.mtb-pdf [data-part="pred"]').checked,
            title: document.querySelector('.mtb-pdf [data-k="title.text"]').value,
            shared: Object.keys(JSON.parse(localStorage.getItem('mtb_print_v1') || '{}'))
        }));
        check('the window remembers the choice; the footer and the letters are kept for every print',
            again.format === 'a2-4' && again.pred === false && again.title === 'Тест распоред'
            && JSON.stringify(again.shared) === '["footer","letters"]', JSON.stringify(again));
        await page.click('.mtb-pdf [data-close]');
        await page.evaluate(() => { localStorage.removeItem('mtb_print_v1'); localStorage.removeItem('mtb_print_v1:nastava-poster'); });
    }

    console.log('\nthe weekly view crosses the whole week and keeps the days apart');
    let weekUrl = '';
    await ctx.unroute('**/api/teaching/crossing*');
    await ctx.route('**/api/teaching/crossing*', async (route) => {
        weekUrl = route.request().url();
        const response = await route.fetch();
        const json = await response.json();
        // The same class, the same period, on two different days — which is the
        // whole reason a weekly cell key has to carry the day.
        json.cells = [
            { day: 'понеделник', dayOrder: 1, ordinal: 1, class: 'ТЕСТ-Н', subject: 'мат',
              teacher: 'Пробен Неделен', teacherOnStaff: true, awayCount: 1,
              away: [{ student: 'Понеделник Дете', therapist: 'Пробен Терапевт', minutes: 25 }] },
            { day: 'петок', dayOrder: 5, ordinal: 1, class: 'ТЕСТ-Н', subject: 'мат',
              teacher: 'Пробен Неделен', teacherOnStaff: true, awayCount: 1,
              away: [{ student: 'Петок Дете', therapist: 'Пробен Терапевт', minutes: 30 }] },
            { day: 'среда', dayOrder: 3, ordinal: 2, class: 'ТЕСТ-Н', subject: 'мат',
              teacher: 'Пробен Неделен', teacherOnStaff: true, away: [], awayCount: 0 }
        ];
        json.summary = Object.assign({}, json.summary, { offStaffLessons: 0 });
        await route.fulfill({ json });
    });

    // Every view is a week now, so changing views asks nothing: the refresh
    // is what brings this invented week in.
    await page.click('#viewWeek');
    await page.click('#refresh');
    await page.waitForTimeout(1000);

    check('the weekly view asks the server for every day at once',
        weekUrl && !/[?&]day=/.test(weekUrl), weekUrl);

    const dayHeads = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#grid thead th.wk-day')).map((th) => th.textContent.trim()));
    check('the header names more than one day', dayHeads.length >= 2, JSON.stringify(dayHeads));

    const keyOn = (day) => page.evaluate((d) => {
        const td = Array.from(document.querySelectorAll('#grid td.cell[data-key]'))
            .find((t) => t.dataset.key.startsWith(d + '|'));
        return td ? td.dataset.key : null;
    }, day);

    const monKey = await keyOn('понеделник');
    const friKey = await keyOn('петок');
    const wedKey = await keyOn('среда');
    check('Monday and Friday are separate cells, not one shared key',
        monKey && friKey && monKey !== friKey, `${monKey} / ${friKey}`);

    // Without the day in the key this passes on Monday and silently opens the
    // wrong lesson on Friday — plausible, and wrong all week.
    await page.click(`#grid td[data-key="${friKey}"]`);
    await page.waitForTimeout(400);
    const friDetail = await page.evaluate(() =>
        document.getElementById('detail').textContent.replace(/\s+/g, ' ').trim());
    check("clicking the Friday cell opens FRIDAY's lesson, not Monday's",
        /Петок Дете/.test(friDetail) && !/Понеделник Дете/.test(friDetail), friDetail);

    await page.hover(`#grid td[data-key="${monKey}"]`);
    await page.waitForTimeout(400);
    const tip = await page.evaluate(() => {
        const t = document.getElementById('tip');
        return { shown: getComputedStyle(t).display !== 'none',
                 text: t.textContent.replace(/\s+/g, ' ').trim() };
    });
    check('hovering a lesson shows the therapy that overlaps it', tip.shown, JSON.stringify(tip));
    check('and it names the child, the therapist and the minutes',
        /Понеделник Дете/.test(tip.text) && /Пробен Терапевт/.test(tip.text) && /25/.test(tip.text),
        tip.text);

    await page.hover(`#grid td[data-key="${wedKey}"]`);
    await page.waitForTimeout(400);
    const quietTip = await page.evaluate(() =>
        document.getElementById('tip').textContent.replace(/\s+/g, ' ').trim());
    check('a lesson nobody is taken out of says so rather than showing a blank card',
        /Никој не е на третман/.test(quietTip), quietTip);

    // Картичката е брз поглед и некому пречи додека чита мрежа. Гаснењето не
    // крие ништо: панелот на клик останува единствениот што мора да работи.
    await page.uncheck('#hoverCard');
    await page.waitForTimeout(300);
    check('turning the hover card off hides the one on screen',
        await page.evaluate(() => getComputedStyle(document.getElementById('tip')).display === 'none'));
    await page.hover(`#grid td[data-key="${monKey}"]`);
    await page.waitForTimeout(400);
    check('and hovering does not bring it back',
        await page.evaluate(() => getComputedStyle(document.getElementById('tip')).display === 'none'));
    await page.click(`#grid td[data-key="${monKey}"]`);
    await page.waitForTimeout(300);
    check('while clicking still answers, because nothing depends on hover alone',
        (await page.evaluate(() => document.getElementById('detail').textContent)).includes('Понеделник Дете'));
    await page.check('#hoverCard');
    await page.waitForTimeout(200);
    await page.hover(`#grid td[data-key="${monKey}"]`);
    await page.waitForTimeout(400);
    check('turning it back on restores it',
        await page.evaluate(() => getComputedStyle(document.getElementById('tip')).display !== 'none'));

    console.log('\nмрежата е прозорец: замрзнат ред и колона, лизгач на екранот, влечење со рака');
    // Owner, 25 Sep 2026: the week is wider than the screen and hard to move
    // around. Narrow enough here that it certainly overflows both ways.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const frame = () => page.evaluate(() => {
        const box = document.querySelector('#gridPanel .scroll');
        const r = box.getBoundingClientRect();
        const head = box.querySelector('table.grid thead tr:first-child th:nth-child(2)').getBoundingClientRect();
        const second = box.querySelector('table.grid thead tr + tr th').getBoundingClientRect();
        const firstCol = box.querySelector('table.grid tbody tr th').getBoundingClientRect();
        return { left: box.scrollLeft, top: box.scrollTop, wide: box.scrollWidth > box.clientWidth,
            tall: box.scrollHeight > box.clientHeight, boxTop: Math.round(r.top), boxLeft: Math.round(r.left),
            boxBottom: r.bottom, viewport: window.innerHeight, headTop: Math.round(head.top),
            secondTop: Math.round(second.top), firstRowBottom: Math.round(head.bottom),
            colLeft: Math.round(firstCol.left) };
    });
    let f = await frame();
    check('the week overflows its window both ways here', f.wide && f.tall, JSON.stringify(f));
    check('and the window ends on the screen, so its sideways scrollbar is always in reach',
        f.boxBottom <= f.viewport + 1, JSON.stringify(f));
    await page.evaluate(() => { const b = document.querySelector('#gridPanel .scroll'); b.scrollTop = 200; b.scrollLeft = 300; });
    await page.waitForTimeout(200);
    f = await frame();
    check('scrolled down, the header row stays at the top of the window', Math.abs(f.headTop - f.boxTop) <= 2, JSON.stringify(f));
    check('and the second header row stops under the first, not on top of it',
        Math.abs(f.secondTop - f.firstRowBottom) <= 2, JSON.stringify(f));
    check('scrolled across, the teachers\' column stays at the left', Math.abs(f.colLeft - f.boxLeft) <= 2, JSON.stringify(f));

    // The fixture teacher's row is near the end of the staff list: bring the
    // lesson into view first, as a person would, and measure from there.
    const aim = async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.$eval(`#grid td[data-key="${monKey}"]`, (td) => {
            const box = document.querySelector('#gridPanel .scroll');
            box.scrollLeft = 0;
            box.scrollTop = Math.max(0, td.offsetTop - box.clientHeight / 2);
        });
        await page.waitForTimeout(150);
        return page.$eval(`#grid td[data-key="${monKey}"]`, (td) => {
            const r = td.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
    };
    const detailBefore = await page.evaluate(() => document.getElementById('detail').className);
    let start = await aim();
    let from = await frame();
    // Leftwards and DOWN: the row is low in the list, so there is room to go up.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 120, start.y + 40, { steps: 6 });
    await page.mouse.move(start.x - 240, start.y + 80, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    f = await frame();
    check('✋ dragging moves the grid under the hand, both ways',
        f.left - from.left >= 200 && from.top - f.top >= 60, JSON.stringify({ from, to: f }));
    checkEq('and the drag is not taken for a click on the lesson it started on',
        await page.evaluate(() => document.getElementById('detail').className), detailBefore);
    await page.uncheck('#hand');
    start = await aim();
    from = await frame();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 240, start.y + 80, { steps: 6 });
    await page.mouse.up();
    f = await frame();
    check('switched off, the mouse no longer drags', f.left === from.left && f.top === from.top, JSON.stringify({ from, to: f }));
    await page.check('#hand');

    check('the teacher picker belongs to the personal sheets only', !(await page.isVisible('#whoField')));
    await page.click(`#grid td[data-key="${monKey}"]`);
    await page.waitForTimeout(250);
    const card = await page.evaluate(() => {
        const d = document.getElementById('detail');
        const r = d.getBoundingClientRect();
        return { open: d.classList.contains('open'), position: getComputedStyle(d).position,
            onScreen: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1 };
    });
    checkEq('a clicked lesson opens over the grid, on screen, not below it out of sight', card,
        { open: true, position: 'fixed', onScreen: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('and Esc closes it', !(await page.evaluate(() => document.getElementById('detail').classList.contains('open'))));
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.waitForTimeout(300);

    console.log('\nнеделата на паралелката: кое дете, во кој кабинет, на кој час');
    let noticeUrl = null;
    page.on('request', (r) => {
        if (r.url().includes('/api/teaching/crossing')) noticeUrl = r.url();
    });
    await page.click('#viewClassWeek');
    await page.waitForTimeout(600);
    check('the overview and the class\'s week are one answer drawn twice, not a second request', noticeUrl === null, noticeUrl);
    check('the class chooser appears with it', await page.isVisible('#klassField'));
    const classSheets = () => page.evaluate(() => Array.from(document.querySelectorAll('#grid .personal')).map((s) => ({
        title: s.querySelector('h3').textContent.trim(),
        sub: s.querySelector('.p-sub').textContent,
        days: Array.from(s.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
        rows: Array.from(s.querySelectorAll('tbody tr')).map((r) =>
            Array.from(r.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
    })));
    await page.selectOption('#klass', '');
    await page.waitForTimeout(300);
    checkEq('„Сите паралелки" is a sheet for each class that has lessons', (await classSheets()).map((s) => s.title),
        ['Паралелка ТЕСТ-Н — неделен распоред']);
    const [classSheet] = await classSheets();
    checkEq('the week has the days the timetable uses, in the school\'s order', classSheet && classSheet.days,
        ['Час', 'Понеделник', 'Среда', 'Петок']);
    checkEq('Monday\'s first lesson names the lesson, its teacher, the child and the cabinet',
        classSheet && classSheet.rows[0][0], 'мат Пробен Неделен ↳ Понеделник Дете Пробен Терапевт');
    checkEq('and Friday\'s its own child', classSheet && classSheet.rows[0][2], 'мат Пробен Неделен ↳ Петок Дете Пробен Терапевт');
    checkEq('a lesson nobody leaves carries no pull-out line', classSheet && classSheet.rows[1][1], 'мат Пробен Неделен');
    check('the header counts the lessons, the pupils and the pull-outs',
        classSheet && /3 часа неделно/.test(classSheet.sub) && /2 ученици/.test(classSheet.sub) && /2 излегувања/.test(classSheet.sub),
        classSheet && classSheet.sub);
    await page.emulateMedia({ media: 'print' });
    const classPrinted = await page.evaluate(() => {
        const s = document.querySelector('#grid .personal');
        const hidden = (sel) => { const n = document.querySelector(sel); return !n || getComputedStyle(n).display === 'none'; };
        return { page: getComputedStyle(s).page, png: hidden('#grid .personal .p-png'),
            controls: hidden('.controls'), unplaced: hidden('#unplaced') };
    });
    await page.emulateMedia({ media: 'screen' });
    checkEq('printed, the class gets its own landscape page, with only the sheet on it', classPrinted,
        { page: 'personal', png: true, controls: true, unplaced: true });
    const [classPng] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        page.click('#grid .personal [data-png-class]')
    ]);
    check('„🖼 Слика" gives the class\'s sheet as a picture',
        classPng && classPng.suggestedFilename() === 'Paralelka-ТЕСТ-Н.png', classPng ? classPng.suggestedFilename() : 'нема преземање');

    console.log('\nличниот распоред: истиот одговор, по наставник, по еден лист');
    // Owner, 25 Sep 2026: the forms' picture, per teacher, with who leaves
    // which lesson for which therapist — to be printed and handed over.
    noticeUrl = null;
    await page.click('#viewPersonal');
    await page.waitForTimeout(600);
    check('the personal sheets read the same week and do not ask again', noticeUrl === null, noticeUrl);
    check('the teacher picker appears with them', await page.isVisible('#whoField'));
    const sheets = () => page.evaluate(() => Array.from(document.querySelectorAll('#grid .personal')).map((s) => ({
        title: s.querySelector('h3').textContent.trim(),
        sub: s.querySelector('.p-sub').textContent,
        days: Array.from(s.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
        rows: Array.from(s.querySelectorAll('tbody tr')).map((r) =>
            // As a person reads it: the lesson and its note are separate lines.
            Array.from(r.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
    })));
    const everyone = await sheets();
    checkEq('„Сите" prints a sheet only for a teacher who has lessons', everyone.map((s) => s.title),
        ['Неделен распоред — Пробен Неделен']);
    await page.selectOption('#who', 'Пробен Неделен');
    await page.waitForTimeout(300);
    const [sheet1] = await sheets();
    checkEq('the week has the days the timetable uses, in the school\'s order', sheet1 && sheet1.days,
        ['Час', 'Понеделник', 'Среда', 'Петок']);
    checkEq('Monday\'s first lesson names the lesson, the class, the child and the therapist',
        sheet1 && sheet1.rows[0][0], 'мат ТЕСТ-Н ↳ Понеделник Дете Пробен Терапевт');
    checkEq('and Friday\'s its own child', sheet1 && sheet1.rows[0][2], 'мат ТЕСТ-Н ↳ Петок Дете Пробен Терапевт');
    checkEq('a lesson nobody leaves carries no pull-out line', sheet1 && sheet1.rows[1][1], 'мат ТЕСТ-Н');
    check('the header counts the lessons and the pull-outs',
        sheet1 && /3 часа неделно/.test(sheet1.sub) && /2 излегувања на третман/.test(sheet1.sub), sheet1 && sheet1.sub);

    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(() => {
        const s = document.querySelector('#grid .personal');
        const hidden = (sel) => { const n = document.querySelector(sel); return !n || getComputedStyle(n).display === 'none'; };
        // One sheet here, so it is also the last: no break after it, but it
        // still prints on the landscape page kept for these sheets.
        return { page: getComputedStyle(s).page, png: hidden('#grid .personal .p-png'),
            controls: hidden('.controls'), unplaced: hidden('#unplaced') };
    });
    await page.emulateMedia({ media: 'screen' });
    checkEq('printed, a sheet takes its own landscape page, with only the sheet on it', printed,
        { page: 'personal', png: true, controls: true, unplaced: true });

    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        page.click('#grid .personal [data-png]')
    ]);
    check('„🖼 Слика" gives the same sheet as a picture, named for the teacher',
        download && download.suggestedFilename() === 'Licen-raspored-Пробен-Неделен.png',
        download ? download.suggestedFilename() : 'нема преземање');

    await page.click('#viewWeek');
    await page.waitForTimeout(800);

    console.log('\nќелиите можат да го испишат кој кого зема');
    check('by default a cell shows a count, not a list',
        (await page.locator('#grid .take').count()) === 0);
    let askedWhileToggling = null;
    page.on('request', (r) => { if (r.url().includes('/api/teaching/crossing')) askedWhileToggling = r.url(); });
    await page.check('#named');
    await page.waitForTimeout(500);
    // Истиот одговор, друго цртање: ново барање овде би значело дека бројот и
    // списокот можат да дојдат од две различни читања.
    check('turning it on does not ask the server again', askedWhileToggling === null, askedWhileToggling);
    const written = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#grid .cell .take')).map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
    check('the cell now names the child and the cabinet',
        written.some((t) => /Понеделник Дете/.test(t) && /Пробен Терапевт/.test(t)), JSON.stringify(written));
    check('and the count stays beside the names',
        (await page.locator('#grid .cell .count').count()) > 0);
    await page.uncheck('#named');
    await page.waitForTimeout(400);
    check('turning it off returns the compact grid',
        (await page.locator('#grid .take').count()) === 0);

    console.log('\nистото вкрстување, прочитано од страната на кабинетот');
    // Серверскиот дел е носечкиот: без public_id и без суровите термини,
    // распоредот на кабинетите би морал да погодува по ИМЕ — а во ова училиште
    // две деца делат едно (правило 2).
    const crossing = await (await fetch(
        `${BASE}/api/teaching/crossing?year=${encodeURIComponent(year.label)}&day=${encodeURIComponent(DAY)}`
    )).json();
    const mine = [];
    (crossing.cells || []).forEach((c) => (c.away || []).forEach((a) => {
        if (a.therapist === `${TAG} Терапевт`) mine.push({ cell: c, away: a });
    }));
    check('the crossing reports the fixture\'s own sessions', mine.length >= 1, String(mine.length));
    const firstAway = mine.find((m) => m.away.student.includes('Прв Пробен'));
    check('an absence carries the pupil\'s public id, not only the name',
        firstAway && firstAway.away.studentPublicId === `${TAG}-a`,
        JSON.stringify(firstAway && firstAway.away));
    // Точно оние стрингови што schedule_slots ги чува: по нив распоредот на
    // кабинетите ја наоѓа својата ќелија, без втора копија од аритметиката.
    check('and the raw term strings the schedule itself stores',
        firstAway && Array.isArray(firstAway.away.slots) && firstAway.away.slots.includes('08:00-08:40'),
        JSON.stringify(firstAway && firstAway.away.slots));

    // The invented week above is still answering for this browser. Кабинети
    // must read the REAL crossing, the one just checked, or it gets lessons
    // with no term strings and rightly has nothing to put on the card.
    await ctx.unroute('**/api/teaching/crossing*');
    const fusion = await ctx.newPage();
    const fusionErrors = [];
    fusion.on('pageerror', (e) => fusionErrors.push(String(e)));
    await fusion.goto(`${BASE}/RasporediFusion.html?year=${encodeURIComponent(year.label)}`);
    await fusion.waitForTimeout(2500);
    await fusion.click(`#dayTabs [data-day="${DAY}"]`);
    await fusion.waitForTimeout(2000);
    const whereSel = `.student-slot[data-where="${DAY}|08:00-08:40|${TAG}-a"]`;
    const hasSlot = await fusion.locator(whereSel).count();
    check('the cabinet schedule marks the term with day, term and pupil', hasSlot === 1, String(hasSlot));
    if (hasSlot === 1) {
        await fusion.hover(whereSel);
        await fusion.waitForTimeout(500);
        const card = await fusion.evaluate(() => {
            const t = document.getElementById('whereTip');
            return { shown: getComputedStyle(t).display !== 'none',
                     text: t.textContent.replace(/\s+/g, ' ').trim() };
        });
        check('hovering it says where the child actually is', card.shown, JSON.stringify(card));
        check('and names the class it reads out of the crossing',
            card.text.includes(label), card.text);
    }
    check('no page errors in the cabinet schedule', fusionErrors.length === 0, fusionErrors.join('\n       '));
    await fusion.close();

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

// A crash after the seed must not leave the invented pupils in the real year.
run().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });
