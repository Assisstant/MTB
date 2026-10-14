// Акциски план во Колега (061; owner, 14 Oct 2026), on a phone-sized screen and
// against an invented server: the pupil's name stays in sight while writing,
// one part is saved without disturbing another being typed, „Потврди" names
// the pupil, a quarter starts from the one before, many pupils are confirmed
// at once, and a write refused as stale keeps what was typed.
//
//     node test/kolega-plan.browser.mjs     (npm run test:kolega-plan)
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3990';
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 412, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
const errors = [], writes = [];
await context.addInitScript(() => { localStorage.setItem('mtb_portal_token_v1', 'a'.repeat(64)); });

const ME = 'Измислена Логопедка';
const PUPILS = [
    { publicId: 'p1', name: 'Измислен Ученик Алфа', class: 'Т-1' },
    { publicId: 'p2', name: 'Измислена Ученичка Бета', class: 'Т-1' },
    { publicId: 'p3', name: 'Измислен Ученик Гама', class: 'Т-2' }
];
const store = { p1: { cabinets: part({ codes: ['logoped'] }) }, p2: { cabinets: part({ codes: ['logoped'] }) }, p3: {} };
store.p2['marks:logoped:1'] = part({ rows: [{ label: 'Артикулација', level: 1 }], note: '' }, ME);
let changeId = 100, staleNext = false, quarter = 1;
let bankMode = 'ready', bankReads = 0, reasonsOn = false, evidenceMode = 'ready', evidenceReads = 0;
const EVIDENCE = { sheet: true, periods: ['I', 'II'], items: [
    { id: 41, label: 'АРТИКУЛАЦИЈА И УПОТРЕБА НА ГЛАСОВИТЕ', group: null, section: { code: 's4', title: 'IV. ГОВОРНО - ЈАЗИЧНО ПОДРАЧЈЕ', scale: 'level' },
      why: ['decline', 'low'], marks: [{ period: 'I', value: '2' }, { period: 'II', value: '1' }] },
    { id: 71, label: 'ПРОБНА ОЗНАКА', group: '1. ПРОБНА ГРУПА', section: { code: 's7', title: 'VII. ПСИХОЛОШКО ПОДРАЧЈЕ', scale: 'mark' },
      why: ['changed'], marks: [{ period: 'I', value: '√' }, { period: 'II', value: 'X' }] }
] };
const BANK = { edition: 7, domains: [{ code: 'I', title: 'Прво пробно подрачје' }, { code: 'IV', title: 'Четврто пробно подрачје' }], items: [
    { id: 'I-P01', domain: 'I', use: 'area', text: 'Пробна област без оцена' },
    { id: 'IV-C01', domain: 'IV', use: 'goal', text: 'Пробна цел [ситуација], [помош], [критериум], [рок].\nПроверка: [начин]' },
    { id: 'IV-A01', domain: 'IV', use: 'activity', text: 'Пробна активност <текст>' },
    { id: 'IV-I01', domain: 'IV', use: 'criterion', text: 'Пробен критериум' },
    { id: 'G6-02', domain: null, use: 'adaptation', text: 'Пробна адаптација' },
    { id: 'I-S01', domain: 'I', use: 'baseline', text: 'Пробна почетна состојба' },
    { id: 'G11-02', domain: null, use: 'outcome', text: 'Пробен исход' },
    { id: 'G11-03', domain: null, use: 'decision', text: 'Пробна одлука' }
] };
// A write the test holds back, to act while the request is away.
let hold = null;
const held = () => { let release; hold = new Promise((resolve) => { release = resolve; }); return () => { hold = null; release(); }; };
function part(data, confirmedBy = null) { return { data, version: 1, by: ME, at: '2026-10-14T08:00:00Z', confirmedBy, confirmedAt: confirmedBy ? '2026-10-14T09:00:00Z' : null }; }
const blank = (value) => value == null ? true : typeof value === 'string' ? !value.trim() : Array.isArray(value) ? !value.length : Object.values(value).every(blank);

const days = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
await context.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/Kolega.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: await readFile(resolve(root, 'Kolega.html')) });
    if (u.pathname === '/api/portal/me') return json(200, { person: { employeeId: 7, name: ME }, usernames: { latin: 'Test', cyrillic: 'Тест' }, year: '2026/2027',
        roles: ['therapist'], therapist: { id: 5 }, teacher: null, duty: false, initialPassword: true });
    if (u.pathname === '/api/portal/week') return json(200, { year: '2026/2027', days, periods: [], me: { teacherId: null, therapistId: 5, homeroom: [] }, classes: [], teachers: [], lessons: [],
        clashes: [], notices: [], cabinet: { bells: [], pupils: [], names: {}, elsewhere: [], terms: [] } });
    if (u.pathname === '/api/portal/duty') return json(200, { year: '2026/2027', month: '2026-10', today: '2026-10-14', members: [], days: [], staleSwaps: [] });
    if (u.pathname === '/api/portal/plan') return json(200, { year: '2026/2027', quarter, categories: [{ code: 'logoped', name: 'Логопед' }, { code: 'psiholoski', name: 'Психолог' }],
        mine: { codes: ['logoped'], classes: [], caseload: 2 },
        pupils: PUPILS.map((p) => ({ ...p, cabinets: store[p.publicId].cabinets ? store[p.publicId].cabinets.data.codes : [],
            parts: Object.fromEntries(Object.entries(store[p.publicId]).filter(([key]) => key !== 'cabinets')
                .map(([key, v]) => [key, { version: v.version, by: v.by, confirmedBy: v.confirmedBy, ...(blank(v.data) ? { empty: true } : {}) }])) })) });
    if (u.pathname === '/api/portal/plan/pupil') {
        const p = PUPILS.find((x) => x.publicId === u.searchParams.get('publicId'));
        return json(200, { year: '2026/2027', pupil: p, labels: { logoped: ['Артикулација', 'Фонологија'] }, parts: store[p.publicId], ...(reasonsOn ? { reasons: true } : {}) });
    }
    if (u.pathname === '/api/portal/plan/evidence') {
        evidenceReads++;
        return evidenceMode === 'fail' ? json(503, { error: 'Нема врска.' }) : json(200, evidenceMode === 'none' ? { sheet: false, periods: [], items: [] } : EVIDENCE);
    }
    if (u.pathname === '/api/portal/plan/bank') {
        bankReads++;
        return bankMode === 'fail' ? json(503, { error: 'Банката не е достапна.' })
            : json(200, bankMode === 'empty' ? { ...BANK, edition: 0, items: [] } : BANK);
    }
    if (u.pathname === '/api/portal/plan/part') {
        const b = req.postDataJSON(); writes.push({ path: u.pathname, body: b });
        if (hold) await hold;
        const now = store[b.publicId][b.part];
        if (staleNext) { staleNext = false; return json(409, { stale: true, error: 'Овој дел е сменет во меѓувреме, па не е запишано.', current: now || null }); }
        if ((now ? now.version : 0) !== b.version) return json(409, { stale: true, error: 'Овој дел е сменет во меѓувреме, па не е запишано.' });
        store[b.publicId][b.part] = { ...part(b.data), version: b.version + 1 };
        return json(200, { ok: true, pupil: PUPILS.find((x) => x.publicId === b.publicId).name, changeId: ++changeId, part: store[b.publicId][b.part], reopened: Boolean(now && now.confirmedBy) });
    }
    if (u.pathname === '/api/portal/plan/confirm') {
        const b = req.postDataJSON(); writes.push({ path: u.pathname, body: b });
        const results = b.items.map((item) => {
            const pupil = PUPILS.find((x) => x.publicId === item.publicId).name;
            let now = store[item.publicId][item.part];
            if (item.carry && !now) now = store[item.publicId][item.part] = part(store[item.publicId][item.part.replace(/\d$/, (q) => q - 1)].data);
            if (!now || blank(now.data)) return { publicId: item.publicId, part: item.part, pupil, ok: false, error: 'Празно е — нема што да се потврди.' };
            store[item.publicId][item.part] = { ...now, version: now.version + 1, confirmedBy: b.on ? ME : null, confirmedAt: b.on ? '2026-10-14T10:00:00Z' : null };
            return { publicId: item.publicId, part: item.part, pupil, ok: true, now: store[item.publicId][item.part] };
        });
        return json(200, { ok: results.every((r) => r.ok), done: results.filter((r) => r.ok).length, results });
    }
    if (u.pathname === '/api/portal/plan/undo') {
        const b = req.postDataJSON(); writes.push({ path: u.pathname, body: b });
        store.p1.iop = { ...part({ program: '', goals: '', strategies: '', adaptations: '', assistant: '' }), version: 3 };
        return json(200, { ok: true, pupil: PUPILS[0].name, part: 'iop' });
    }
    if (u.pathname.startsWith('/api/')) return json(404, {});
    return route.fulfill({ status: 404, body: '' });
});

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const p = await context.newPage();
p.on('pageerror', (e) => errors.push(e.message));
const dialogs = [];
p.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
const text = (selector) => p.locator(selector).innerText();
const last = (path) => writes.filter((w) => w.path === path).at(-1)?.body;
/** Read first (owner, 14 Oct 2026): a part's form opens on ✏️ Уреди. */
const edit = async (form) => {
    const part = form.match(/data-part="([^"]+)"/)[1];
    if (await p.locator(form).isHidden()) await p.click(`[data-box="${part}"] [data-plan-edit]`);
};

try {
    await p.goto(origin + '/Kolega.html');
    await p.click('#welcomeContinue');
    await p.click('[data-tab="plan"]');
    await p.waitForSelector('.plan-list li');

    console.log('the list');
    check('opens on „мои непотврдени": the pupils whose plan holds my cabinet', (await p.locator('.plan-list li').count()) === 1
        && (await text('[data-plan-filter="todo"]')).includes('(1)') && (await text('[data-plan-filter="mine"]')).includes('(2)') && (await text('[data-plan-filter="all"]')).includes('(3)'));
    check('a part already confirmed is not work to do', false === (await text('.plan-list')).includes('Бета'));
    await p.click('[data-plan-filter="all"]');
    check('„Сите" shows every pupil, also one with no cabinet in the plan', (await p.locator('.plan-list li').count()) === 3 && (await text('.plan-list')).includes('без кабинети во планот'));
    check('the row says started, confirmed or empty', (await p.locator('.plan-list li').nth(1).locator('.plan-chip.confirmed').count()) === 1
        && (await p.locator('.plan-list li').nth(0).locator('.plan-chip.confirmed').count()) === 0);
    check('the list does not scroll sideways on a phone', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    console.log('\none pupil');
    await p.click('[data-plan-open="p1"]');
    await p.waitForSelector('.plan-who');
    check('the name and class stand at the top', (await text('.plan-who')).includes(PUPILS[0].name) && (await text('.plan-who')).includes('Т-1'));
    check('and stay there while the page scrolls', await p.evaluate(() => getComputedStyle(document.querySelector('.plan-head')).position === 'sticky'));
    check('the whole plan is open to read, my cabinet first', await p.evaluate(() => [...document.querySelectorAll('[data-plan-section]')].every((d) => d.open)
        && document.querySelector('[data-plan-section]').dataset.planSection === 'cab:logoped'));
    const marks = 'form[data-part="marks:logoped:1"]';
    check('„Потврди" names the pupil', (await text(marks + ' [data-plan-confirm]')).includes(PUPILS[0].name));
    check('a part reads first as a form: every field, „—" where nothing is written, and ✏️ Уреди', await p.locator(marks).isHidden()
        && (await text('[data-box="iop"] .plan-view')).includes('Стратегии') && (await text('[data-box="iop"] .plan-view')).includes('—')
        && await p.locator('[data-box="iop"] [data-plan-edit]').isVisible());
    await edit(marks);
    await p.click(marks + ' [data-row-add]');
    await p.fill(marks + ' [data-row-label]', 'Артикулација');
    await p.click(marks + ' [data-level-set="2"]');
    // The rest of an area — where the pupil started, the developmental level, a note — is one touch away.
    await p.click(marks + ' .plan-more > summary');
    await p.selectOption(marks + ' [data-row-baseline]', '1');
    await p.selectOption(marks + ' [data-row-stage]', '2');
    await p.fill(marks + ' [data-row-note]', 'Белешка за областа');
    // Another part is being typed while the first is saved.
    await edit('form[data-part="iop"]');
    await p.fill('form[data-part="iop"] textarea[name="goals"]', '  Цел што уште се пишува ');
    await p.click(marks + ' button[type="submit"]');
    await p.waitForFunction(() => /Зачувано за/.test(((document.getElementById('planMsg') || {}).textContent || '')));
    check('the part goes whole, with the version the screen showed', JSON.stringify(last('/api/portal/plan/part'))
        === JSON.stringify({ publicId: 'p1', part: 'marks:logoped:1', data: { rows: [{ label: 'Артикулација', level: 2, baseline: 1, stage: 2, note: 'Белешка за областа' }], note: '' }, version: 0 }), JSON.stringify(last('/api/portal/plan/part')));
    check('the answer names the pupil and offers „Врати"', (await text('#planMsg')).includes(PUPILS[0].name) && (await p.locator('#planMsg [data-plan-undo]').count()) === 1);
    check('saved, the part reads again as a filled form: the area, its quarter and its note', await p.locator(marks).isHidden()
        && /Артикулација\s+1\s+2/.test(await text('[data-box="marks:logoped:1"] .plan-view')) && (await text('[data-box="marks:logoped:1"] .plan-view')).includes('Белешка за областа'),
        await text('[data-box="marks:logoped:1"] .plan-view'));
    check('what was being typed in another part is still there', (await p.inputValue('form[data-part="iop"] textarea[name="goals"]')) === '  Цел што уште се пишува ');
    await p.click('form[data-part="iop"] button[type="submit"]');
    await p.waitForFunction(() => /ИОП|Зачувано/.test(((document.getElementById('planMsg') || {}).textContent || '')) && !document.querySelector('form[data-part="iop"] button:disabled'));
    check('typed text is sent as typed', last('/api/portal/plan/part').data.goals === '  Цел што уште се пишува ');
    await p.click('#planMsg [data-plan-undo]');
    await p.waitForFunction(() => /Вратено/.test(((document.getElementById('planMsg') || {}).textContent || '')));
    check('„Врати" sends that change and shows the part as it was', last('/api/portal/plan/undo').id === changeId
        && (await p.inputValue('form[data-part="iop"] textarea[name="goals"]').catch(() => '')) === '', JSON.stringify(last('/api/portal/plan/undo')));
    // ✏️ Уреди, then Откажи: what was typed goes after one question, and the part reads as stored.
    await edit('form[data-part="iop"]');
    await p.fill('form[data-part="iop"] textarea[name="strategies"]', 'Ова не се зачувува');
    dialogs.length = 0;
    await p.click('form[data-part="iop"] [data-plan-cancel]');
    check('„Откажи" asks, then closes the form without writing', dialogs.some((m) => /незачувано/.test(m)) && await p.locator('form[data-part="iop"]').isHidden()
        && await p.inputValue('form[data-part="iop"] textarea[name="strategies"]') === '' && !(await text('[data-box="iop"] .plan-view')).includes('Ова не се зачувува'));

    console.log('\nwhile a save is on its way (review, 14 Oct 2026)');
    const note = marks + ' textarea[name="note"]', count = () => writes.filter((w) => w.path === '/api/portal/plan/part').length;
    await edit(marks);
    await p.fill(note, 'Прво');
    let release = held();
    await p.click(marks + ' button[type="submit"]');
    await p.waitForFunction(() => document.querySelector('form[data-part="marks:logoped:1"] button:disabled'));
    await p.fill(note, 'Прво и допишано');
    release();
    await p.waitForFunction(() => /Зачувано за/.test(((document.getElementById('planMsg') || {}).textContent || '')) && !document.querySelector('form[data-part="marks:logoped:1"] button:disabled'));
    const before = count();
    await p.click(marks + ' button[type="submit"]');
    await p.waitForTimeout(200);
    check('what was typed while the save was away is still unsaved, and the next „Зачувај" sends it', count() === before + 1
        && last('/api/portal/plan/part').data.note === 'Прво и допишано' && store.p1['marks:logoped:1'].data.note === 'Прво и допишано', JSON.stringify(last('/api/portal/plan/part')));
    // The pupil is changed while the answer is away: it must not land on the one now open.
    await edit(marks);
    await p.fill(note, '');
    release = held();
    await p.click(marks + ' button[type="submit"]');
    await p.waitForFunction(() => document.querySelector('form[data-part="marks:logoped:1"] button:disabled'));
    await p.click('[data-plan-back]');
    await p.click('[data-plan-filter="all"]');
    await p.click('[data-plan-open="p2"]');
    await p.waitForFunction(() => /Бета/.test((document.querySelector('.plan-who') || {}).textContent || ''));
    const p2Before = await p.evaluate(() => { const f = document.querySelector('form[data-part="marks:logoped:1"]'); return f.dataset.version + '|' + f.querySelector('[data-row-label]').value + '|' + f.querySelector('[data-plan-status]').textContent; });
    release();
    await p.waitForFunction(() => /Зачувано за/.test(((document.getElementById('planMsg') || {}).textContent || '')));
    const p2After = await p.evaluate(() => { const f = document.querySelector('form[data-part="marks:logoped:1"]'); return f.dataset.version + '|' + f.querySelector('[data-row-label]').value + '|' + f.querySelector('[data-plan-status]').textContent; });
    check('an answer for one pupil does not touch the sheet of the pupil opened meanwhile', p2Before === p2After && /Потврдено од/.test(p2After), p2Before + ' → ' + p2After);
    check('and says whose it was', (await text('#planMsg')).includes(PUPILS[0].name));
    check('the other pupil\'s stored marks are their own', store.p2['marks:logoped:1'].version === 1 && store.p2['marks:logoped:1'].data.rows[0].level === 1);
    await p.click('[data-plan-back]');
    await p.click('[data-plan-open="p1"]');
    await p.waitForFunction(() => /Алфа/.test((document.querySelector('.plan-who') || {}).textContent || ''));

    console.log('\n„потврда"');
    await p.click('[data-box="marks:logoped:1"] .plan-view [data-plan-confirm]');
    await p.waitForFunction(() => /Потврдено за/.test(((document.getElementById('planMsg') || {}).textContent || '')));
    check('an unchanged part is confirmed without being written again', JSON.stringify(last('/api/portal/plan/confirm'))
        === JSON.stringify({ on: true, items: [{ publicId: 'p1', part: 'marks:logoped:1', version: 4 }] }), JSON.stringify(last('/api/portal/plan/confirm')));
    check('and says who confirmed', (await text(marks + ' [data-plan-status]')).includes('Потврдено од ' + ME)
        && (await text('[data-plan-section="cab:logoped"] > summary')).includes('✅'));

    console.log('\na write refused as stale');
    await edit(marks);
    await p.fill(marks + ' textarea[name="note"]', 'Белешка што не смее да се изгуби');
    staleNext = true;
    await p.click(marks + ' button[type="submit"]');
    await p.waitForSelector('#planMsg [data-plan-reload]');
    check('keeps what was typed and offers to read what stands now', (await p.inputValue(marks + ' textarea[name="note"]')) === 'Белешка што не смее да се изгуби'
        && (await text('#planMsg')).includes('сменет во меѓувреме'));
    const download = p.waitForEvent('download');
    await p.click('[data-plan-docx]');
    check('Word carries the plan under the pupil\'s name', /^Akciski-plan-.*\.docx$/.test((await download).suggestedFilename()));

    console.log('\nthe next quarter');
    await p.click('[data-plan-back]');
    await p.waitForSelector('.plan-list');
    check('leaving with something unsaved asks first', dialogs.some((m) => /незачувано/.test(m)));
    await p.click('[data-plan-quarter="2"]');
    await p.click('[data-plan-filter="todo"]');
    check('both pupils are work to do again, with the earlier quarter to take', (await p.locator('.plan-list li .plan-chip.carry').count()) === 2);
    await p.click('[data-plan-open="p2"]');
    await p.waitForSelector('.plan-carry');
    check('the quarter opens filled as the one before stood', (await p.inputValue('form[data-part="marks:logoped:2"] [data-row-label]')) === 'Артикулација'
        && (await p.getAttribute('form[data-part="marks:logoped:2"] [data-level-set="1"]', 'aria-pressed')) === 'true');
    dialogs.length = 0;
    await p.click('[data-plan-back]');
    await p.waitForSelector('.plan-list');
    check('and leaving it untouched asks nothing', dialogs.length === 0);
    // Review, 14 Oct 2026: a search hides a pupil; „Избери ги сите" must not reach behind it.
    await p.fill('#planQuery', 'Бета');
    // The list is drawn again when it comes back from the server: pick only once the search has hidden its row.
    await p.waitForFunction(() => [...document.querySelectorAll('.plan-list li')].filter((li) => !li.hidden).length === 1);
    await p.click('[data-plan-pick-all]');
    check('„Избери ги сите" picks only the pupils in sight', (await text('[data-plan-confirm-picked]')).includes('(1)')
        && (await p.locator('.plan-list li:not([hidden]) [data-plan-pick]:checked').count()) === 1, await text('#planBulk'));
    await p.fill('#planQuery', 'Алфа');
    check('a pick does not outlive being in sight', (await text('[data-plan-confirm-picked]')).includes('(0)') && await p.isDisabled('[data-plan-confirm-picked]'));
    await p.fill('#planQuery', '');
    await p.click('[data-plan-pick-all]');
    await p.click('[data-plan-confirm-picked]');
    await p.waitForFunction(() => /Потврдено: 2/.test((document.getElementById('planMsg') || {}).textContent || ''));
    check('many pupils are confirmed in one press, after one question', dialogs.length === 1 && /2 ученици/.test(dialogs[0]) && /ќе се преземат/.test(dialogs[0]), dialogs.join(' | '));
    check('each as its own part, taking the earlier quarter', JSON.stringify(last('/api/portal/plan/confirm')) === JSON.stringify({ on: true, items: [
        { publicId: 'p1', part: 'marks:logoped:2', version: 0, carry: true }, { publicId: 'p2', part: 'marks:logoped:2', version: 0, carry: true }] }), JSON.stringify(last('/api/portal/plan/confirm')));
    check('and nothing is left to do', (await text('#plan')).includes('Сè ваше за овој квартал е потврдено'));
    console.log('\nthe approved bank, draft only');
    await p.click('[data-plan-filter="all"]');
    await p.click('[data-plan-open="p1"]');
    await p.waitForSelector('.plan-who');
    const goals = 'form[data-part="goal:logoped"]';
    const picker = goals + ' [data-bank-target="goals"]';
    const original = '  Мој текст со празни места  ';
    await edit(goals);
    await p.fill(goals + ' textarea[name="goals"]', original);
    const beforeBank = writes.length;
    await p.click(picker + ' > summary');
    await p.waitForSelector(picker + ' [data-bank-add]');
    check('all domains remain in source order for every cabinet', JSON.stringify(await p.locator(picker + ' [data-bank-domain] option').evaluateAll((nodes) => nodes.map((n) => n.value))) === JSON.stringify(['', 'I', 'IV', 'general']));
    await p.selectOption(picker + ' [data-bank-domain]', 'I');
    check('domain filter shows an honest empty result', (await text(picker)).includes('Нема одобрени ставки за овој избор.'));
    await p.selectOption(picker + ' [data-bank-domain]', '');
    await p.fill(picker + ' [data-bank-search]', 'IV-C01');
    await p.press(picker + ' [data-bank-search]', 'Enter');
    check('Enter in bank search does not submit the plan', writes.length === beforeBank);
    await p.click(picker + ' [data-bank-add="IV-C01"]');
    const withGoal = original + '\n' + BANK.items[1].text;
    check('goal and check append without trimming or saving', await p.inputValue(goals + ' textarea[name="goals"]') === withGoal && writes.length === beforeBank);
    await p.fill(picker + ' [data-bank-search]', '');
    await p.selectOption(picker + ' [data-bank-use]', 'activity');
    check('markup in bank text is displayed literally', (await text(picker + ' [data-bank-items]')).includes('<текст>') && await p.locator(picker + ' текст').count() === 0);
    await p.click(picker + ' [data-bank-add="IV-A01"]');
    await p.selectOption(picker + ' [data-bank-use]', 'criterion');
    await p.click(picker + ' [data-bank-add="IV-I01"]');
    const draft = await p.inputValue(goals + ' textarea[name="goals"]');
    check('activities and criteria have readable labels inside the existing goal text', draft === withGoal + '\nАктивност: Пробна активност <текст>\nКритериум за успех: Пробен критериум');
    staleNext = true;
    await p.click(goals + ' button[type="submit"]');
    await p.waitForFunction(() => document.getElementById('planMsg').textContent.includes('сменет во меѓувреме'));
    check('a stale save keeps the inserted and edited draft', await p.inputValue(goals + ' textarea[name="goals"]') === draft);
    await p.click(goals + ' button[type="submit"]');
    await p.waitForFunction(() => document.getElementById('planMsg').textContent.includes('Зачувано за'));
    check('only Save writes copied text, without a bank ID or new fields', JSON.stringify(last('/api/portal/plan/part').data) === JSON.stringify({ baseline: '', goals: draft }));
    const areaPicker = 'form[data-part="marks:logoped:2"] [data-bank-target="area"]';
    await edit('form[data-part="marks:logoped:2"]');
    await p.click(areaPicker + ' > summary');
    await p.click(areaPicker + ' [data-bank-add="I-P01"]');
    const areaRow = p.locator('form[data-part="marks:logoped:2"] .plan-row').last();
    check('an inserted area starts unassessed, never at zero', await areaRow.getAttribute('data-level') === '' && await areaRow.locator('[data-row-baseline]').inputValue() === '' && await areaRow.locator('[data-row-stage]').inputValue() === '');
    const rowCount = await p.locator('form[data-part="marks:logoped:2"] .plan-row').count();
    await p.click(areaPicker + ' [data-bank-add="I-P01"]');
    check('a repeated area is explained without duplicating it', await p.locator('form[data-part="marks:logoped:2"] .plan-row').count() === rowCount && (await text(areaPicker)).includes('веќе е во нацртот'));
    await edit('form[data-part="iop"]');
    const adaptPicker = 'form[data-part="iop"] [data-bank-target="adaptations"]';
    await p.click(adaptPicker + ' > summary');
    await p.click(adaptPicker + ' [data-bank-add="G6-02"]');
    check('accommodations go to the existing IOP field', await p.inputValue('form[data-part="iop"] textarea[name="adaptations"]') === 'Пробна адаптација');
    await edit(goals);
    await p.fill(goals + ' textarea[name="goals"]', 'x'.repeat(7999));
    // Saved, the form was drawn anew: its picker opens again, from the page's copy of the fond.
    await p.click(picker + ' > summary');
    await p.waitForSelector(picker + ' [data-bank-use]');
    await p.selectOption(picker + ' [data-bank-use]', 'criterion');
    await p.click(picker + ' [data-bank-add="IV-I01"]');
    check('insertion refuses overflow without truncating the draft', (await p.inputValue(goals + ' textarea[name="goals"]')).length === 7999 && (await text(picker)).includes('Нема доволно место'));
    await p.fill(goals + ' textarea[name="goals"]', draft);
    const snapDir = resolve(root, 'backups/akciski-banka/ui');
    await mkdir(snapDir, { recursive: true });
    for (const theme of ['light', 'dark']) {
        await p.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        await p.setViewportSize({ width: 390, height: 844 });
        await p.locator(picker).scrollIntoViewIfNeeded();
        check(`bank fits the phone in ${theme}`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        check(`the pupil name stays below the toolbar in ${theme}`, await p.evaluate(() => {
            const name = document.querySelector('.plan-who').getBoundingClientRect(), bar = document.querySelector('.theme-bar').getBoundingClientRect();
            return name.top >= bar.bottom && name.bottom < innerHeight;
        }));
        await p.screenshot({ path: resolve(snapDir, `bank-${theme}.png`) });
    }
    check('all pickers share one read, without adding a second save path', bankReads === 1);
    // A fresh page has no bank cache: both lack of approval and a failed read
    // must leave the existing writer available.
    for (const mode of ['empty', 'fail']) {
        bankMode = mode;
        await p.reload();
        if (await p.locator('#welcomeContinue:visible').count()) await p.click('#welcomeContinue');
        await p.click('[data-tab="plan"]');
        await p.click('[data-plan-filter="all"]');
        await p.click('[data-plan-open="p1"]');
        await edit(goals);
        await p.click(picker + ' > summary');
        await p.waitForFunction(({ selector, word }) => document.querySelector(selector).textContent.includes(word), { selector: picker, word: mode === 'empty' ? 'стручен преглед' : 'рачно' });
        check(`${mode}: free text and Save stay available`, await p.locator(picker + ' [data-bank-add]').count() === 0 && !await p.isDisabled(goals + ' textarea[name="goals"]') && !await p.isDisabled(goals + ' button[type="submit"]'));
        if (mode === 'fail') {
            bankMode = 'ready';
            await p.click(picker + ' [data-bank-retry]');
            await p.waitForSelector(picker + ' [data-bank-add]');
            check('a failed load can be retried without reloading the pupil', await p.inputValue(goals + ' textarea[name="goals"]') === draft);
        }
    }

    console.log('\nphase 3: „Исход", „Одлука" and a reason for a change');
    const review = 'form[data-part="review:1"]';
    check('a server without 062 offers no reason field anywhere', await p.locator('[data-plan-reason]').count() === 0);
    check('the review has its own „Исход" and „Одлука"', await p.locator(review + ' textarea[name="outcome"]').count() === 1
        && await p.locator(review + ' textarea[name="decision"]').count() === 1);
    check('their suggestions sit beside them, not beside the IOP evaluation', await p.locator(review + ' [data-bank-target="outcome"]').count() === 1
        && await p.locator(review + ' [data-bank-target="decision"]').count() === 1 && await p.locator(review + ' [data-bank-target="iopEval"]').count() === 0);
    reasonsOn = true;
    await p.click('[data-plan-back]');
    await p.click('[data-plan-open="p1"]');
    await p.waitForSelector('.plan-who');
    check('nothing written yet is not a change, so no reason is asked', await p.locator(review + ' [data-plan-reason]').count() === 0);
    await edit(review);
    await p.click(review + ' [data-bank-target="outcome"] > summary');
    await p.click(review + ' [data-bank-target="outcome"] [data-bank-add="G11-02"]');
    await p.click(review + ' [data-bank-target="decision"] > summary');
    await p.click(review + ' [data-bank-target="decision"] [data-bank-add="G11-03"]');
    check('an outcome and a decision go into their own fields, without a label in front', await p.inputValue(review + ' textarea[name="outcome"]') === 'Пробен исход'
        && await p.inputValue(review + ' textarea[name="decision"]') === 'Пробна одлука' && await p.inputValue(review + ' textarea[name="iopEval"]') === '');
    await p.click(review + ' button[type="submit"]');
    await p.waitForFunction(() => document.getElementById('planMsg').textContent.includes('Зачувано за'));
    check('they are written with the rest of the review', JSON.stringify(last('/api/portal/plan/part')) === JSON.stringify({ publicId: 'p1', part: 'review:1',
        data: { date: '', iopEval: '', outcome: 'Пробен исход', decision: 'Пробна одлука', revision: '', report: '', parentMeeting: '' }, version: 0 }), JSON.stringify(last('/api/portal/plan/part')));
    await edit(review);
    check('once something is written, a change can say why', await p.inputValue(review + ' [data-plan-reason]') === '');
    await p.fill(review + ' textarea[name="decision"]', 'Пробна одлука, сменета');
    await p.fill(review + ' [data-plan-reason]', 'По тимската средба');
    await p.click(review + ' button[type="submit"]');
    await p.waitForFunction(() => document.querySelector('form[data-part="review:1"] [data-plan-status]').textContent.includes('причина'));
    check('the reason goes with the change, beside the part, not in it', last('/api/portal/plan/part').reason === 'По тимската средба'
        && !('reason' in last('/api/portal/plan/part').data), JSON.stringify(last('/api/portal/plan/part')));
    check('the sheet says it, and the next change starts with an empty reason', (await text(review + ' [data-plan-status]')).includes('По тимската средба')
        && await p.inputValue(review + ' [data-plan-reason]') === '');
    await edit(review);
    await p.fill(review + ' textarea[name="report"]', 'Извештај');
    await p.fill(review + ' [data-plan-reason]', '   ');
    await p.click(review + ' button[type="submit"]');
    await p.waitForFunction(() => !document.querySelector('form[data-part="review:1"] [data-plan-status]').textContent.includes('причина'));
    check('only spaces is not sent as a reason', !('reason' in last('/api/portal/plan/part')));
    check('the reason field fits the phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.locator('[data-box="review:1"]').scrollIntoViewIfNeeded();
    await p.screenshot({ path: resolve(snapDir, 'review-phase3.png') });

    console.log('\nphase 5: priorities suggested from the евидентен лист');
    const marks1 = 'form[data-part="marks:logoped:1"]', ev = marks1 + ' [data-evidence]';
    check('nothing is read until it is opened', evidenceReads === 0);
    const writesBefore = writes.length;
    await edit(marks1);
    await p.click(ev + ' > summary');
    await p.waitForSelector(ev + ' [data-evidence-add]');
    const said = await text(ev);
    check('each suggestion says what it is, with the marks it comes from', said.includes('пад, ниво 1 — недоволно') && said.includes('Артикулација и употреба на гласовите: I 2 → II 1')
        && said.includes('сменета ознака, за преглед') && said.includes('Предлог, не одлука'), said);
    const rowsBefore = await p.locator(marks1 + ' .plan-row').count();
    await p.click(ev + ' [data-evidence-add="41"]');
    const added = p.locator(marks1 + ' .plan-row').last();
    check('a suggestion becomes an area in the draft, unassessed, and nothing is saved', await p.locator(marks1 + ' .plan-row').count() === rowsBefore + 1
        && await added.locator('[data-row-label]').inputValue() === 'Артикулација и употреба на гласовите' && await added.getAttribute('data-level') === ''
        && writes.length === writesBefore);
    await p.click(ev + ' [data-evidence-add="41"]');
    check('the same area twice is refused and said', await p.locator(marks1 + ' .plan-row').count() === rowsBefore + 1 && (await text(ev)).includes('веќе е во нацртот'));
    check('read once for the open pupil', evidenceReads === 1);
    await p.locator(ev).scrollIntoViewIfNeeded();
    check('the suggestions fit the phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.screenshot({ path: resolve(snapDir, 'evidence-phase5.png') });
    for (const mode of ['none', 'fail']) {
        evidenceMode = mode;
        await p.click('[data-plan-back]');
        await p.click('[data-plan-open="p2"]');
        await p.waitForFunction(() => /Бета/.test((document.querySelector('.plan-who') || {}).textContent || ''));
        await edit(marks1);
        await p.click(ev + ' > summary');
        await p.waitForFunction(({ selector, word }) => document.querySelector(selector).textContent.includes(word),
            { selector: ev, word: mode === 'none' ? 'нема евидентен лист' : 'рачно' });
        check(`${mode}: said plainly, and the areas stay writable`, !await p.isDisabled(marks1 + ' [data-row-add]'));
    }
    evidenceMode = 'ready';
    await p.click(ev + ' [data-evidence-retry]');
    await p.waitForSelector(ev + ' [data-evidence-add]');
    check('a failed read can be tried again', (await text(ev)).includes('Артикулација'));

    console.log('\n„📘 Пример": a filled plan to read and to try, nothing saved');
    await p.click('[data-plan-back]');
    await p.click('.plan-help > summary');
    check('the list says in five steps how a plan is filled', (await text('.plan-help')).includes('✏️ Уреди') && await p.locator('.plan-help li').count() === 5);
    const sent = writes.length, realQuarter = await p.getAttribute('[data-plan-quarter][aria-pressed="true"]', 'data-plan-quarter');
    await p.click('button[data-plan-example]');
    await p.waitForSelector('.plan-example');
    check('the example opens as an invented pupil, said so, at the year\'s end', (await text('.plan-who')).includes('ПРИМЕР')
        && (await p.getAttribute('[data-plan-quarter="4"]', 'aria-pressed')) === 'true' && (await text('.plan-example')).includes('Ништо не се зачувува'));
    const exMarks = '[data-box="marks:logoped:4"] .plan-view';
    check('its areas read across the four quarters', /Артикулација — глас Р\s+1\s+2\s+3\s+3\s+4/.test(await text(exMarks)), await text(exMarks));
    await p.click('[data-plan-quarter="1"]');
    check('a past quarter opens to read and to change', (await text('[data-box="review:1"] .plan-view')).includes('27.11.2026')
        && await p.locator('[data-box="review:1"] [data-plan-edit]').isVisible());
    await edit('form[data-part="review:1"]');
    await p.fill('form[data-part="review:1"] textarea[name="revision"]', 'Проба во примерот');
    await p.click('form[data-part="review:1"] button[type="submit"]');
    await p.waitForFunction(() => /Зачувано за/.test(document.getElementById('planMsg').textContent));
    check('✏️ Уреди and „Зачувај" work in the example, and nothing reaches the server', writes.length === sent
        && (await text('[data-box="review:1"] .plan-view')).includes('Проба во примерот') && await p.locator('#planMsg [data-plan-undo]').count() === 0);
    const exampleDoc = p.waitForEvent('download');
    await p.click('[data-plan-docx]');
    check('the example makes its Word document from what it holds', /^Akciski-plan-ПРИМЕР.*\.docx$/.test((await exampleDoc).suggestedFilename()));
    await p.click('[data-plan-example="primer-b"]');
    check('the other examples are one touch away', (await text('.plan-who')).includes('Ученичка Б'));
    await p.setViewportSize({ width: 390, height: 844 });
    check('the example and its tables fit the phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.screenshot({ path: resolve(snapDir, 'example-view.png'), fullPage: true });
    await p.click('[data-plan-back]');
    await p.waitForSelector('.plan-list');
    check('leaving the example gives back the real list and quarter', (await text('#plan')).includes(PUPILS[0].name)
        && (await p.getAttribute('[data-plan-quarter="' + realQuarter + '"]', 'aria-pressed')) === 'true' && realQuarter !== '4' && writes.length === sent);
    check('no script error on the page', errors.length === 0, errors.join(' | '));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
