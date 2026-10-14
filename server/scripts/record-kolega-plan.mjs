/**
 * Упатство за Колега → Акциски план, како видео: вистинската Kolega.html во два
 * прозорци (монитор и телефон) во ист кадар, со објаснување за секој чекор.
 * Ист изглед како record.mjs (кабинетите). Сè е измислено: луѓе, ученици,
 * планови. Серверот е лажиран тука, базата не се допира.
 *
 *     node server/scripts/record-kolega-plan.mjs          (од коренот на репото)
 *     FAST=1 node server/scripts/record-kolega-plan.mjs   (брза проба, со слика по чекор)
 *
 * Излез: backups/tutorial-kolega/Kolega-akciski-plan-banka-upatstvo.mp4
 */
import { createRequire } from 'node:module';
import { readFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const require = createRequire(join(ROOT, 'server', 'package.json'));
const { chromium } = require('playwright');
// FAST=1 runs the script through quickly, to see that every step still finds its button.
const FAST = Boolean(process.env.FAST);
const SPEED = FAST ? 0.12 : 1;
const SMOOTH = FAST ? 'instant' : 'smooth';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

// ── измислениот свет ──────────────────────────────────────────────────────
const YEAR = '2026/2027';
const TODAY = '2026-10-14';
const DAYS = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
const BELLS = ['08:00-08:40', '08:45-09:25', '09:40-10:20', '10:25-11:05', '11:10-11:50', '11:55-12:35']
    .map((time, i) => ({ ordinal: i + 1, label: ['I', 'II', 'III', 'IV', 'V', 'VI'][i], time }));
const ME = { employeeId: 1, name: 'Елена Примерова' };
const CATEGORIES = [{ code: 'logoped', name: 'Логопед' }, { code: 'psiholog', name: 'Психолог' }, { code: 'somatoped', name: 'Соматопед' }, { code: 'reedukator', name: 'Реедукатор' }];
const PUPILS = [
    { publicId: 'p1', name: 'Марко Примеров', class: 'II-а' },
    { publicId: 'p2', name: 'Сара Пробна', class: 'III' },
    { publicId: 'p3', name: 'Давид Тестов', class: 'V-б' },
    { publicId: 'p4', name: 'Мила Измислена', class: 'подготвителна' },
    { publicId: 'p5', name: 'Лука Пробен', class: 'VI-а' }
];
const LABELS = { logoped: ['Артикулација', 'Разбирање на говор', 'Изразен говор', 'Фонолошка свесност'] };
const term = (day, bell, ...pupils) => ({ day: DAYS[day], time: BELLS[bell].time, pupils, overlap: false });
const part = (data, by = ME.name, confirmedBy = null) => ({ data, version: 1, by, at: '2026-10-12T10:15:00', confirmedBy, confirmedAt: confirmedBy ? '2026-10-13T12:40:00' : null });
const blank = (value) => value == null ? true : typeof value === 'string' ? !value.trim() : Array.isArray(value) ? !value.length
    : typeof value === 'object' ? Object.values(value).every(blank) : false;

function newWorld() {
    return {
        changeId: 100, changes: [],
        plans: {
            p1: { cabinets: part({ codes: ['logoped'] }) },
            p2: { cabinets: part({ codes: ['logoped', 'psiholog'] }),
                'marks:logoped:1': part({ rows: [{ label: 'Артикулација', level: 1, baseline: null, stage: null, note: '' }, { label: 'Изразен говор', level: 2, baseline: null, stage: null, note: '' }], note: '' }),
                'marks:psiholog:1': part({ rows: [{ label: 'Внимание', level: 2, baseline: null, stage: null, note: '' }], note: '' }, 'Горан Пробен', 'Горан Пробен') },
            p3: { cabinets: part({ codes: ['logoped'] }),
                'marks:logoped:1': part({ rows: [{ label: 'Артикулација', level: 3, baseline: 2, stage: 1, note: '' }, { label: 'Разбирање на говор', level: 3, baseline: null, stage: null, note: '' }], note: '' }, ME.name, ME.name),
                iop: part({ program: 'Модифицирана', goals: 'Чита кратки реченици со поддршка.', strategies: '', adaptations: '', assistant: '' }, 'Вера Тестова') },
            p4: {},
            p5: { cabinets: part({ codes: ['psiholog'] }),
                'marks:psiholog:1': part({ rows: [{ label: 'Самостојност', level: 2, baseline: null, stage: null, note: '' }], note: '' }, 'Горан Пробен', 'Горан Пробен') }
        }
    };
}

function answer(world, method, path, query, body) {
    const pupilOf = (id) => PUPILS.find((p) => p.publicId === id);
    if (path === '/api/portal/door') return [200, {}];
    if (path === '/api/portal/me') return [200, { person: ME, usernames: { latin: 'ElenaPrimerova', cyrillic: 'ЕленаПримерова' }, initialPassword: false,
        year: YEAR, roles: ['therapist'], teacher: null, therapist: { id: 1 }, duty: false }];
    if (path === '/api/portal/week') return [200, { year: YEAR, days: DAYS, periods: [], me: { teacherId: null, therapistId: 1, homeroom: [], subject: null },
        classes: [], teachers: [], lessons: [], classPupils: {}, clashes: [], notices: [],
        cabinet: { bells: BELLS, pupils: PUPILS, names: {}, elsewhere: [],
            terms: [term(0, 0, 'p1'), term(0, 1, 'p2', 'p3'), term(0, 3, 'p4'), term(1, 0, 'p5'), term(2, 1, 'p4'), term(2, 3, 'p2'), term(3, 0, 'p3'), term(4, 2, 'p2')] } }];
    if (path === '/api/portal/duty') return [200, { year: YEAR, month: '2026-10', today: TODAY, members: [], days: [], staleSwaps: [] }];
    if (path === '/api/portal/notices/seen') return [200, { ok: true }];
    if (path === '/api/portal/plan') return [200, { year: YEAR, quarter: 1, categories: CATEGORIES, mine: { codes: ['logoped'], classes: [], caseload: 4 },
        pupils: PUPILS.map((p) => {
            const plan = world.plans[p.publicId];
            return { ...p, cabinets: plan.cabinets ? plan.cabinets.data.codes : [],
                parts: Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'cabinets')
                    .map(([key, v]) => [key, { version: v.version, by: v.by, confirmedBy: v.confirmedBy, ...(blank(v.data) ? { empty: true } : {}) }])) };
        }) }];
    // Demonstration content only. The real bank remains edition 0 until reviewed.
    if (path === '/api/portal/plan/bank') return [200, { edition: 1,
        domains: [{ code: 'I', title: 'Прво подрачје' }, { code: 'IV', title: 'Говорно-јазично подрачје' }],
        items: [{ id: 'IV-C90', domain: 'IV', use: 'goal', text: 'Демонстрациска цел [ситуација], [помош], [критериум], [рок].\nПроверка: [начин на проверка]' },
            { id: 'G6-90', domain: null, use: 'adaptation', text: 'Демонстрациска адаптација' }] }];
    if (path === '/api/portal/plan/pupil') return [200, { year: YEAR, pupil: pupilOf(query.get('publicId')), labels: LABELS, parts: world.plans[query.get('publicId')] }];
    if (path === '/api/portal/plan/part') {
        const plan = world.plans[body.publicId], before = plan[body.part];
        plan[body.part] = { data: body.data, version: body.version + 1, by: ME.name, at: TODAY + 'T09:00:00', confirmedBy: null, confirmedAt: null };
        world.changes.push({ id: ++world.changeId, publicId: body.publicId, part: body.part, before });
        return [200, { ok: true, pupil: pupilOf(body.publicId).name, changeId: world.changeId, part: plan[body.part], reopened: Boolean(before && before.confirmedBy) }];
    }
    if (path === '/api/portal/plan/confirm') {
        const results = body.items.map((item) => {
            const plan = world.plans[item.publicId], pupil = pupilOf(item.publicId).name;
            let now = plan[item.part];
            if (item.carry && (!now || blank(now.data))) {
                const [kind, code, quarter] = item.part.split(':');
                for (let q = Number(quarter) - 1; q >= 1; q--) {
                    const earlier = plan[`${kind}:${code}:${q}`];
                    if (earlier && !blank(earlier.data)) { now = plan[item.part] = { ...part({ rows: earlier.data.rows.map((row) => ({ ...row, note: '' })), note: '' }), version: 0 }; break; }
                }
            }
            if (!now || blank(now.data)) return { publicId: item.publicId, part: item.part, pupil, ok: false, error: 'Празно е — нема што да се потврди.' };
            plan[item.part] = { ...now, version: now.version + 1, confirmedBy: body.on ? ME.name : null, confirmedAt: body.on ? TODAY + 'T09:00:00' : null };
            return { publicId: item.publicId, part: item.part, pupil, ok: true, now: plan[item.part] };
        });
        return [200, { ok: results.every((r) => r.ok), done: results.filter((r) => r.ok).length, results }];
    }
    if (path === '/api/portal/plan/undo') {
        const change = world.changes.find((c) => c.id === body.id), plan = world.plans[change.publicId], now = plan[change.part];
        plan[change.part] = change.before ? { ...change.before, version: now.version + 1 }
            : { data: Object.fromEntries(Object.keys(now.data).map((key) => [key, Array.isArray(now.data[key]) ? [] : ''])), version: now.version + 1, by: ME.name, at: TODAY + 'T09:00:00', confirmedBy: null, confirmedAt: null };
        return [200, { ok: true, pupil: pupilOf(change.publicId).name, part: change.part }];
    }
    return [404, { error: 'Нема во ова упатство.' }];
}

// ── сцената: два прозорци и текст (иста како во record.mjs) ───────────────
const STAGE = `<!doctype html><html lang="mk"><meta charset="utf-8"><title>Упатство</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#e9edf3;font-family:"Segoe UI",Arial,sans-serif;color:#16233b}
.shot{position:absolute;transition:left .7s ease,top .7s ease,transform .7s ease,opacity .5s ease;transform-origin:0 0}
#deskBox{left:28px;top:26px;width:1280px;height:800px;transform:scale(1.092);border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(20,35,60,.22);border:1px solid #c5cedb;background:#fff}
#deskBox::before{content:"💻 На компјутер";position:absolute;left:14px;top:9px;z-index:2;font-size:14px;font-weight:700;color:#5a6b85;background:#fffc;padding:2px 10px;border-radius:99px}
#phoneBox{left:1466px;top:20px;width:414px;height:848px;padding:12px;border-radius:44px;background:#16233b;box-shadow:0 10px 34px rgba(20,35,60,.35)}
#phoneBox::after{content:"";position:absolute;left:50%;top:14px;width:90px;height:8px;margin-left:-45px;border-radius:9px;background:#33435f;z-index:3}
iframe{border:0;display:block;background:#fff}
#desk{width:1280px;height:800px}#phone{width:390px;height:824px;border-radius:32px}
#caption{position:absolute;left:28px;right:28px;top:912px;height:150px;border-radius:14px;background:#16233b;color:#fff;padding:16px 26px;display:flex;gap:24px;align-items:center;transition:opacity .4s}
#caption .n{flex:none;width:92px;height:92px;border-radius:50%;background:#2f7fd1;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800}
#caption h2{margin:0 0 6px;font-size:34px;line-height:1.1}#caption p{margin:0;font-size:25px;line-height:1.3;color:#dce6f5}
#side,#caption{pointer-events:none}
#side{position:absolute;left:760px;top:0;width:1100px;height:1080px;display:flex;flex-direction:column;justify-content:center;opacity:0;transition:opacity .5s}
#side .k{font-size:30px;font-weight:700;color:#2f7fd1;letter-spacing:.04em;text-transform:uppercase}
#side h1{font-size:76px;line-height:1.08;margin:14px 0 26px}#side p{font-size:38px;line-height:1.38;margin:0;color:#34455f}
#side .pause{margin-top:44px;font-size:24px;color:#6a7b95}
body.solo #deskBox{opacity:0}body.solo #phoneBox{left:150px;top:16px;transform:scale(1.235)}body.solo #caption{opacity:0}body.solo #side{opacity:1}
#cover{position:absolute;inset:0;z-index:20;background:linear-gradient(135deg,#16233b,#2f5f9e);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transition:opacity .7s}
#cover.off{opacity:0;pointer-events:none}#cover h1{font-size:92px;margin:0 0 22px}#cover p{font-size:40px;margin:0;color:#d5e2f5;max-width:1400px;line-height:1.35}
#cover ul{font-size:34px;text-align:left;line-height:1.6;color:#e6eefb;margin:34px 0 0}
</style><body class="solo">
<div class="shot" id="deskBox"><iframe id="desk" src="http://desk.test/Kolega.html"></iframe></div>
<div class="shot" id="phoneBox"><iframe id="phone" src="http://phone.test/Kolega.html"></iframe></div>
<div id="side"><div class="k"></div><h1></h1><p></p><div class="pause">⏸ Паузирајте тука ако треба да се продискутира.</div></div>
<div id="caption"><div class="n"></div><div><h2></h2><p></p></div></div>
<div id="cover"><h1></h1><p></p><ul></ul></div>
<script>
const q=(s)=>document.querySelector(s);
window.stage={
  cover(title,text,list){q('#cover h1').textContent=title;q('#cover p').textContent=text||'';q('#cover ul').innerHTML=(list||[]).map(x=>'<li>'+x+'</li>').join('');q('#cover').classList.remove('off')},
  uncover(){q('#cover').classList.add('off')},
  solo(n,total,title,text){document.body.classList.add('solo');q('#side .k').textContent='Чекор '+n+' од '+total;q('#side h1').textContent=title;q('#side p').textContent=text;
    q('#caption .n').textContent=n;q('#caption h2').textContent=title;q('#caption p').textContent=text},
  both(){document.body.classList.remove('solo')},
  note(text){q('#caption p').textContent=text}
};
</script></body></html>`;

const RIPPLE = () => {
    if (window.top === window.self) return;
    try { localStorage.setItem('mtb_portal_token_v1', 'a'.repeat(64)); } catch { /* the stage itself keeps nothing */ }
    window.__ripple = (x, y) => {
        if (!document.getElementById('tutStyle')) {
            const s = document.createElement('style'); s.id = 'tutStyle';
            s.textContent = '.tut-ripple{position:fixed;z-index:99999;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:rgba(255,140,0,.38);border:4px solid rgba(240,110,0,.95);pointer-events:none;animation:tut .9s ease-out forwards}@keyframes tut{0%{transform:scale(.35);opacity:1}70%{opacity:1}100%{transform:scale(1.25);opacity:0}}';
            document.documentElement.appendChild(s);
        }
        const d = document.createElement('div'); d.className = 'tut-ripple'; d.style.left = x + 'px'; d.style.top = y + 'px';
        document.documentElement.appendChild(d); setTimeout(() => d.remove(), 950);
    };
    window.__rippleOn = (el) => { const r = el.getBoundingClientRect(); window.__ripple(r.left + r.width / 2, r.top + r.height / 2); };
    window.addEventListener('pointerdown', (e) => window.__ripple(e.clientX, e.clientY), true);
};

// ── снимањето ─────────────────────────────────────────────────────────────
const OUT = join(ROOT, 'backups/tutorial-kolega'), RAW = join(OUT, 'raw-bank-' + Date.now());
await mkdir(RAW, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light', locale: 'mk-MK', serviceWorkers: 'block',
    recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } } });
await context.clock.setFixedTime(new Date(TODAY + 'T09:00:00'));
await context.addInitScript(RIPPLE);
const worlds = { 'http://desk.test': newWorld(), 'http://phone.test': newWorld() };
const kolega = await readFile(join(ROOT, 'Kolega.html'));
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === 'http://stage.test') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STAGE });
    const world = worlds[url.origin];
    if (!world) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/Kolega.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: kolega });
    const [status, body] = answer(world, req.method(), url.pathname, url.searchParams, req.postData() ? JSON.parse(req.postData()) : null);
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const started = Date.now();
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
// The app asks its questions in the browser's own box, which a recording does not show: the caption says what was asked.
page.on('dialog', (dialog) => dialog.accept());
const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.goto('http://stage.test/');
const F = [page.frameLocator('#phone'), page.frameLocator('#desk')];
const stage = (fn, ...args) => page.evaluate(([f, a]) => window.stage[f](...a), [fn, args]);

/** The same thing on the phone, then on the monitor. */
const each = async (fn) => {
    try { for (const f of F) await fn(f); }
    catch (err) { await page.screenshot({ path: join(OUT, 'failed-step.png') }); throw err; }
};
const tap = async (selector, wait = 1100) => {
    // The click is made inside the frame: the frames are scaled on the stage, and a
    // click aimed from outside lands beside a small button.
    await each(async (f) => { const l = f.locator(selector).first(); await l.scrollIntoViewIfNeeded(); await sleep(250);
        await l.evaluate((el) => { window.__rippleOn(el); el.click(); }); });
    await sleep(wait);
};
const choose = async (selector, value, wait = 1100) => {
    await each(async (f) => { const l = f.locator(selector).first(); await l.scrollIntoViewIfNeeded(); await l.evaluate((el) => window.__rippleOn(el)); });
    await sleep(450);
    await each((f) => f.locator(selector).first().selectOption(value));
    await sleep(wait);
};
const type = async (selector, text, wait = 500) => {
    await each(async (f) => { const l = f.locator(selector).first(); await l.scrollIntoViewIfNeeded(); await l.evaluate((el) => window.__rippleOn(el)); await l.pressSequentially(text, { delay: FAST ? 0 : 38 }); });
    await sleep(wait);
};
const show = async (selector, block = 'center') => {
    await each((f) => f.locator(selector).first().evaluate((el, [b, SMOOTH]) => el.scrollIntoView({ behavior: SMOOTH, block: b }), [block, SMOOTH]));
    await sleep(800);
};
const top = async () => { await each((f) => f.locator('body').evaluate((el, SMOOTH) => window.scrollTo({ top: 0, behavior: SMOOTH }), SMOOTH)); await sleep(700); };
const note = async (text, wait = 2600) => { await stage('note', text); await sleep(wait); };
/** The app has answered: this text stands in this place, on both screens. */
const seen = (selector, text) => each((f) => f.locator(selector).filter({ hasText: text }).first().waitFor({ timeout: 8000 }));
const said = (text) => seen('#planMsg', text);

const STEPS = 12;
let stepNo = 0;
/** A picture of where the step before ended — only on the quick rehearsal. */
const snap = async () => { if (FAST && stepNo) await page.screenshot({ path: join(RAW, `step-${String(stepNo).padStart(2, '0')}.png`) }); };
/** Two seconds of the phone alone with the step's words, then both screens. */
async function step(title, text, soloMs = 2600) {
    await snap();
    stepNo++;
    await stage('solo', stepNo, STEPS, title, text);
    await sleep(700 + soloMs);
    await stage('both');
    await sleep(1100);
}
const MARKS = 'form[data-part="marks:logoped:1"]';
const GOAL = 'form[data-part="goal:logoped"]';
const IOP = 'form[data-part="iop"]';
const rowOf = (n) => `${MARKS} .plan-row:nth-child(${n})`;
/** Read first (owner, 14 Oct 2026): a part is read as a filled form, and ✏️ Уреди opens its form. */
const view = (part) => `[data-box="${part}"] .plan-view`;
const edit = async (form, wait = 1200) => {
    const part = form.match(/data-part="([^"]+)"/)[1];
    await each(async (f) => {
        if (!await f.locator(form).first().isHidden()) return;
        const l = f.locator(`${view(part)} [data-plan-edit]`).first();
        await l.scrollIntoViewIfNeeded(); await sleep(250);
        await l.evaluate((el) => { window.__rippleOn(el); el.click(); });
    });
    await sleep(wait);
};

await stage('cover', 'Колеги — акциски план', 'Како се пополнува акцискиот план на ученик: на телефон и на компјутер.', [
    'Каде е и што покажува списокот', 'Еден ученик: оцени по област', 'Зачувај, Потврди и Врати',
    'ИОП, квартален преглед и другите делови', 'Кабинети во планот', 'Нов квартал и потврда за повеќе ученици', 'Word']);
await each((f) => f.locator('#welcome:not([hidden])').waitFor({ timeout: 15000 }));
const lead = (Date.now() - started) / 1000;
await sleep(5000);
await stage('uncover');
await sleep(900);

// 1 ── каде е
await step('Каде е акцискиот план', 'Најавете се во Колега како и досега — истиот линк, истата лозинка. Горе има ново јазиче: „📄 Акциски план“.');
await tap('#welcomeContinue', 1500);
await each((f) => f.locator('#tabs [data-tab="plan"]').waitFor({ timeout: 8000 }));
await note('Јазичето стои покрај „Мој кабинет“. Го имаат сите: кабинетите и наставниците.', 2600);
await tap('#tabs [data-tab="plan"]', 1600);
await each((f) => f.locator('.plan-list li').first().waitFor({ timeout: 8000 }));

// 2 ── списокот
await step('Списокот на ученици', 'Секој ученик е еден ред, со состојбата на секој дел за избраниот квартал. Сите колеги гледаат и пишуваат сè.', 3200);
await note('✅ потврдено · ✏️ запишано, уште не е потврдено · ↻ може да се преземе претходниот квартал · ○ празно.', 4200);
await show('#plan .filters');
await note('„Мои непотврдени“ е она што ви останува за кварталот. Така се отвора списокот.', 3200);
await tap('[data-plan-filter="mine"]', 1600);
await note('„Мои ученици“ се оние што во планот го имаат вашиот кабинет.', 2600);
await tap('[data-plan-filter="all"]', 1600);
await note('„Сите“ — секој ученик. Можете да отворите и пополните кој било од нив.', 3000);
await show('.plan-help');
await note('„❓ Како се пополнува“ ги кажува петте чекори. „📘 Пример: пополнет план“ отвора измислен ученик — гледајте и пробувајте, ништо не се зачувува.', 4600);
await type('#planQuery', 'Мила', 1500);
await note('Полето за барање наоѓа ученик по име или паралелка.', 2400);
await each((f) => f.locator('#planQuery').fill(''));
await sleep(700);
await tap('[data-plan-filter="todo"]', 1300);

// 3 ── еден ученик
await step('Отвори ученик', 'Допрете го името. Името и паралелката остануваат горе додека пишувате — проверете дека е вистинскиот ученик.');
await tap('[data-plan-open="p1"]', 1500);
await seen('.plan-who', 'Марко');
await note('Горе: „← Список“, името на ученикот и „Word“. Под нив е кварталот за кој пишувате.', 3400);
await show('[data-plan-section="cab:logoped"]', 'start');
await note('Планот се гледа како образец: што е запишано, и „—“ каде што е празно. Вашиот кабинет е прв.', 3400);

// 4 ── оцени по област
await step('Оцени по област', '„✏️ Уреди“ го отвора делот. „+ Додај област“, напишете што се работи и изберете оцена од 0 до 4.', 3200);
await edit(MARKS);
await tap(`${MARKS} [data-row-add]`, 1000);
await type(`${rowOf(1)} [data-row-label]`, 'Артикулација', 600);
await tap(`${rowOf(1)} [data-level-set="2"]`, 1300);
await note('0 не реагира · 1 целосна помош · 2 делумна помош · 3 минимална помош · 4 самостојно.', 3800);
await tap(`${MARKS} [data-row-add]`, 1000);
await type(`${rowOf(2)} [data-row-label]`, 'Разбирање на говор', 600);
await tap(`${rowOf(2)} [data-level-set="3"]`, 1300);
await note('Област што веќе сте ја напишале се нуди за избор кај следниот ученик.', 2800);
await tap(`${rowOf(1)} .plan-more > summary`, 1300);
await note('Под областа, ако треба: почетна оцена, развојно ниво и белешка. Не е задолжително.', 3000);
await choose(`${rowOf(1)} [data-row-baseline]`, '1', 900);
await choose(`${rowOf(1)} [data-row-stage]`, '1', 900);
await type(`${rowOf(1)} [data-row-note]`, 'Гласот Р во почетна позиција.', 900);
await show(`${MARKS} .plan-actions`);
await tap(`${MARKS} button[type="submit"]`, 1200);
await said('Зачувано за');
await show('#planMsg');
await note('„Зачувано за Марко Примеров“ — апликацијата секогаш кажува кај кој ученик е запишано.', 3400);
await show(view('marks:logoped:1'));
await note('Зачуваниот дел пак се гледа како образец: областите во табела, по квартали.', 3200);

// 5 ── потврда
await step('Потврди', '„Зачувај“ го запишува делот. „Потврди за …“ значи: мојот дел за овој квартал е готов. На копчето пишува името на ученикот.', 3600);
await show(`${view('marks:logoped:1')} .plan-view-actions`);
await note('Запишано, но уште не потврдено: во списокот тоа е ✏️.', 2600);
await tap(`${view('marks:logoped:1')} [data-plan-confirm]`, 1300);
await said('Потврдено за');
await show(`${view('marks:logoped:1')} .plan-status`);
await note('„✅ Потврдено од …“ со датум и час. Во списокот ученикот веќе не е во „Мои непотврдени“.', 3600);
await note('Ако потоа нешто смените и зачувате, потврдата се отвора одново. „Тргни ја потврдата“ ја трга рачно.', 3800);

// 6 ── другите делови
await step('ИОП и другите делови', 'Под кабинетите се: ИОП, Квартален преглед, Фаза А и Крај на година. Секој дел се зачувува посебно.', 3200);
await show(view('goal:logoped'));
await note('Во вашиот кабинет, под оцените: „Почетна состојба и цели“ за годината.', 3000);
await show('[data-plan-section="iop"]', 'start');
await edit(IOP);
await choose(`${IOP} select[name="program"]`, 'Модифицирана', 900);
await type(`${IOP} textarea[name="goals"]`, 'Именува 10 предмети од секојдневието.', 900);
await show(`${IOP} .plan-actions`);
await tap(`${IOP} button[type="submit"]`, 1200);
await said('Зачувано за');
await note('Зачувување на еден дел не го допира она што го пишувате во друг.', 3000);
await show('[data-plan-section="review"]', 'start');
await note('Кварталниот преглед е за избраниот квартал. Фаза А и Крај на година се по едни за годината.', 3600);

// Bank ── the selection copies text into the draft; this fixture approves nothing in the real bank.
await step('Предлози од фондот на содржини', 'Пример со демонстрациска содржина. Во вистинскиот фонд ќе се нудат само ставки што колегите ги одобриле.', 3800);
const BANK_GOALS = `${GOAL} [data-bank-target="goals"]`;
await show(view('goal:logoped'), 'start');
await edit(GOAL);
await tap(`${BANK_GOALS} > summary`, 1300);
await note('Изберете подрачје и вид или пребарајте збор. Сите подрачја се достапни, по ред.', 3500);
await tap(`${BANK_GOALS} [data-bank-add="IV-C90"]`, 1300);
await show(`${GOAL} textarea[name="goals"]`);
await note('Текстот е додаден во нацртот. Ништо не е зачувано. Пополнете ги заградите и „Проверка“ за конкретниот ученик.', 4500);
await type(`${GOAL} textarea[name="goals"]`, '\nБелешка за доработка.', 800);
await tap(`${GOAL} button[type="submit"]`, 1200);
await said('Зачувано за');
await note('Само „Зачувај“ го запишува текстот. Промена на фондот подоцна не ја менува оваа цел.', 3600);
const BANK_ADAPT = `${IOP} [data-bank-target="adaptations"]`;
await edit(IOP);
await tap(`${BANK_ADAPT} > summary`, 1200);
await tap(`${BANK_ADAPT} [data-bank-add="G6-90"]`, 1200);
await show(`${IOP} textarea[name="adaptations"]`);
await note('Адаптациите од фондот одат во постојното поле „Адаптации“ во ИОП. И тие се уредуваат пред зачувување.', 3800);
await tap(`${IOP} button[type="submit"]`, 1200);
await said('Зачувано за');

// 7 ── грешка
await step('Грешка? „Врати“', 'По секое зачувување, до пораката стои „Врати“. Го враќа делот како што бил пред вашето последно зачувување.', 3200);
await edit(GOAL);
await type(`${GOAL} textarea[name="goals"]`, 'Ова е запишано кај погрешен ученик.', 900);
await tap(`${GOAL} button[type="submit"]`, 1200);
await said('Зачувано за');
await show('#planMsg');
await note('Запишано е кај погрешен ученик. До „Зачувано за …“ е копчето „Врати“.', 3200);
await tap('#planMsg [data-plan-undo]', 1400);
await said('Вратено како што беше');
await seen('.plan-who', 'Марко');
await note('„Вратено како што беше“. Ако грешката ја забележите подоцна, администраторот може да врати или да премести запис кај друг ученик.', 4600);

// 8 ── кабинети во планот
await step('Кабинети во планот', 'Кои кабинети работат со ученикот се избира рачно, во неговиот план. Изборот останува додека некој не го смени.', 3200);
await top();
await tap('[data-plan-back]', 1400);
await each((f) => f.locator('.plan-list li').first().waitFor({ timeout: 8000 }));
await tap('[data-plan-filter="all"]', 1400);
await show('[data-plan-open="p4"]');
await note('„без кабинети во планот“ — кај овој ученик уште никој не избрал кабинет.', 3000);
await tap('[data-plan-open="p4"]', 1500);
await seen('.plan-who', 'Мила');
await show('.plan-cabinets');
await tap('[data-plan-cabinet="logoped"]', 1500);
await each((f) => f.locator('[data-plan-section="cab:logoped"]').waitFor({ timeout: 8000 }));
await note('Допир на кабинетот го додава во планот и го отвора неговиот дел. Уште еден допир го трга.', 3600);
await note('Планот не ја следи листата „Мои ученици“: кој кабинет кое дете го зема се менува низ годината.', 3800);
await top();
await tap('[data-plan-back]', 1400);
await each((f) => f.locator('.plan-list li').first().waitFor({ timeout: 8000 }));
await show('.plan-take');
await note('Побрзо: „+ Додај „Логопед“ во планот на учениците од мојата листа“ го додава вашиот кабинет кај сите одеднаш.', 4200);

// 9 ── нов квартал
await step('Нов квартал', 'Горе се четирите квартали. Новиот квартал почнува пополнет како претходниот — менувате само што е различно.', 3200);
await top();
await tap('[data-plan-quarter="2"]', 1600);
await note('Квартал 2: кај учениците стои ↻ — оцените од квартал 1 можат да се преземат.', 3200);
await tap('[data-plan-open="p3"]', 1500);
await each((f) => f.locator('.plan-view .plan-carry').first().waitFor({ timeout: 8000 }));
await show('.plan-view .plan-carry', 'start');
await note('„↻ За квартал 2 уште не е запишано“. „✏️ Уреди“ ги презема оцените од квартал 1 — сменете што е различно; или „Потврди“ ако нема промена.', 4600);
await note('Белешките не се преземаат — тие се за својот квартал.', 2400);
await top();
await tap('[data-plan-back]', 1400);
await each((f) => f.locator('.plan-list li').first().waitFor({ timeout: 8000 }));

// 10 ── потврда за повеќе
await step('Потврда за повеќе ученици', 'Ако кај повеќе ученици нема промена, не мора да ги отворате еден по еден: изберете ги во списокот и потврдете одеднаш.', 3600);
await tap('[data-plan-filter="todo"]', 1400);
await show('#planBulk');
await note('Квадратчето пред името го избира ученикот. „Избери ги сите прикажани“ ги зема сите што се гледаат.', 3400);
await tap('[data-plan-pick-all]', 1500);
await note('Ученик кај кого нема што да се потврди нема квадратче.', 2600);
await tap('[data-plan-confirm-picked]', 1200);
await said('Потврдено: 3');
await note('Пред да потврди, апликацијата прашува: за колку ученици, и кај колку се преземаат оцените од претходниот квартал.', 4200);
await show('#planMsg');
await note('„Потврдено: 3“. Во „Мои непотврдени“ останува само ученикот кај кого уште нема оцени.', 3600);

// 11 ── Word
await step('Word', 'Во планот на ученикот, горе десно: „Word (.docx)“ го презема целиот план — сите делови и четирите квартали.');
await top();
await tap('[data-plan-quarter="1"]', 1200);
await tap('[data-plan-filter="all"]', 1200);
await tap('[data-plan-open="p1"]', 1500);
await seen('.plan-who', 'Марко');
await tap('[data-plan-docx]', 1500);
for (let i = 0; i < 40 && !downloads.length; i++) await sleep(150);
if (!downloads.length) console.log('NO DOWNLOAD');
await note('Документот се презема со името на ученикот. Во него пишува и кој го потврдил секој дел.', 3800);
await snap();

await stage('cover', 'Тоа е сè', 'Запишете, па потврдете го својот дел за кварталот. Сè што ќе запишете останува забележано: кој, кога и што. За прашања — кај администраторот.', []);
await sleep(4500);

const total = (Date.now() - started) / 1000;
await context.close();
await browser.close();
const raw = (await readdir(RAW)).find((f) => f.endsWith('.webm'));
await rename(join(RAW, raw), join(RAW, 'raw.webm'));
if (FAST) { console.log(`проба готова: ${(total - lead).toFixed(0)} s · слики во ${RAW}`); process.exit(0); }
const mp4 = join(OUT, 'Kolega-akciski-plan-banka-upatstvo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', lead.toFixed(2), '-i', join(RAW, 'raw.webm'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
console.log(`готово: ${mp4} · ${(total - lead).toFixed(0)} s`);
