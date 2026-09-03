/**
 * The T1→T4 progress report, in a real browser.
 *
 * Two halves. First the pivot's rules, which are the part that can be wrong
 * without looking wrong: a term with two assessments, two scales at once, two
 * school years, and an indicator that was simply not scored. Then the page
 * itself is rendered and photographed, because a report nobody has looked at
 * is not finished.
 *
 *     npm run start                             # in one terminal
 *     node test/progress-report.browser.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const FIXTURE = JSON.parse(
    readFileSync(new URL('../../sample-data/anonymized/diary-sample.json', import.meta.url), 'utf8')
);

let fails = 0;
const check = (l, c, d = '') => { if (c) console.log(`  ok   ${l}`); else { fails++; console.log(`  FAIL ${l}${d ? '\n       ' + d : ''}`); } };
const checkEq = (l, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    check(l, same, same ? '' : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};

/**
 * A year of assessments for one student, plus the awkward cases on purpose:
 * a second T2 on a later date, a second scale, and a previous school year.
 */
const SCALES = [
    {
        id: 'proba_v1', name: 'Проба скала', category: 'говор',
        indicators: [
            { id: 'i1', label: 'Разбирање на говор', levels: ['не', 'малку', 'делумно', 'добро', 'целосно'] },
            { id: 'i2', label: 'Изговор на гласови', levels: ['не', 'малку', 'делумно', 'добро', 'целосно'] },
            { id: 'i3', label: 'Речник', levels: ['не', 'малку', 'делумно', 'добро', 'целосно'] }
        ]
    },
    {
        id: 'proba_v2', name: 'Втора проба скала', category: 'слух',
        indicators: [
            { id: 'j1', label: 'Реакција на звук', levels: ['не', 'малку', 'делумно', 'добро', 'целосно'] }
        ]
    }
];

const A = (id, period, date, scaleType, scores, average, comment) =>
    ({ id, studentId: 9001, scaleType, date, period, scores, average, comment: comment || '' });

const ASSESSMENTS = [
    // This school year, first scale.
    A(1, 'T1', '2025-11-10', 'proba_v1', { i1: 1, i2: 0, i3: 2 }, 1.0, 'Почетна состојба.'),
    A(2, 'T2', '2026-01-15', 'proba_v1', { i1: 2, i2: 1, i3: 2 }, 1.67, ''),
    // A SECOND T2 — later date, so this one wins and the other is named.
    A(3, 'T2', '2026-01-28', 'proba_v1', { i1: 2, i2: 2, i3: 2 }, 2.0, 'Поправена по повторна проверка.'),
    // i3 deliberately NOT scored in T3 — must stay blank, not zero.
    A(4, 'T3', '2026-04-02', 'proba_v1', { i1: 3, i2: 2 }, 2.5, ''),
    A(5, 'T4', '2026-06-01', 'proba_v1', { i1: 4, i2: 3, i3: 1 }, 2.67, 'Напредок кај разбирањето.'),
    // Same year, DIFFERENT scale — its own table.
    A(6, 'T1', '2025-11-10', 'proba_v2', { j1: 1 }, 1.0, ''),
    A(7, 'T4', '2026-06-01', 'proba_v2', { j1: 3 }, 3.0, ''),
    // LAST school year — a separate table, and must not share columns.
    A(8, 'T4', '2025-05-20', 'proba_v1', { i1: 0, i2: 0, i3: 1 }, 0.33, '')
];

const run = async () => {
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/S-Dnevnik.html`);
    await page.waitForTimeout(2500);

    await page.evaluate(({ fixture, scales, assessments }) => {
        window.SdnV3.applyPayload(fixture);
        window.scaleTemplates = scales;
        window.assessments = assessments;
    }, { fixture: FIXTURE, scales: SCALES, assessments: ASSESSMENTS });

    // ── the pivot ───────────────────────────────────────────────────────────
    console.log('\nhow the assessments are grouped');
    const groups = await page.evaluate(() => assessmentProgressGroups(window.assessments)
        .map((g) => ({
            year: g.year, scale: g.scaleType,
            periods: Object.keys(g.byPeriod).sort(),
            chosen: Object.fromEntries(Object.entries(g.byPeriod).map(([p, a]) => [p, a.id])),
            superseded: g.superseded.map((a) => a.id)
        })));

    checkEq('three tables: two scales this year, one last year', groups.length, 3);
    checkEq('the newest school year comes first', groups[0].year, '2025/2026');
    check('last year is its own table, not extra columns',
        groups.some((g) => g.year === '2024/2025' && g.scale === 'proba_v1'),
        JSON.stringify(groups.map((g) => g.year + ' ' + g.scale)));

    const main = groups.find((g) => g.year === '2025/2026' && g.scale === 'proba_v1');
    checkEq('all four terms are present', main.periods, ['T1', 'T2', 'T3', 'T4']);
    checkEq('the LATER of the two T2 assessments is the one shown', main.chosen.T2, 3);
    checkEq('and the earlier one is named rather than dropped', main.superseded, [2]);

    const second = groups.find((g) => g.scale === 'proba_v2');
    checkEq('the second scale keeps its own terms', second.periods, ['T1', 'T4']);

    // ── the rendered page ───────────────────────────────────────────────────
    console.log('\nthe printed page');
    const html = await page.evaluate(() => {
        const s = getStudentById(9001);
        return buildProgressReportHtml([{ student: s, groups: assessmentProgressGroups(window.assessments) }]);
    });

    check('an unscored indicator is blank, not zero', /class="v empty">—</.test(html));
    check('a rise is marked as one', /▲ \+3/.test(html), 'i1 went 1 → 4');
    check('a fall is marked as one', /▼ -1/.test(html), 'i3 went 2 → 1');
    check('the change is spelled out in words, with the level reached',
        /Разбирање на говор<\/b>: 1 → 4 <i>\(целосно\)/.test(html));
    check('the stored average is shown, not a recomputed one', /2\.67/.test(html));
    check('the duplicate term is disclosed', /уште 1 проценка\(и\)/.test(html));
    check('comments come through', /Напредок кај разбирањето/.test(html));

    // Render it and look at it.
    const shot = await ctx.newPage();
    await shot.setContent(html.replace(/<script[\s\S]*?<\/script>/g, ''), { waitUntil: 'load' });
    await shot.setViewportSize({ width: 900, height: 1400 });
    await shot.screenshot({ path: 'progress-report.png', fullPage: true });
    console.log('  →   rendered to server/progress-report.png');

    writeFileSync('progress-report.sample.html', html);
    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
