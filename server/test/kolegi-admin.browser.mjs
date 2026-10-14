/**
 * Податоци → „👥 Колеги", and the administrator's look at a colleague's form,
 * in a real browser with every API call answered here from invented data.
 * What the server decides is asserted against a real database in
 * portal-week.e2e.ts. What this proves:
 *
 *   1. The tab shows the link to hand out, the clashes standing now, the
 *      notices with their state, and every account with its username.
 *   2. „Врати почетна лозинка" asks first, then resets.
 *   3. „Отвори го формуларот" opens that colleague's form in a new tab, as the
 *      administrator's look: the banner says so, the password and sign-out are
 *      not offered, and the look is taken out of the address at once.
 *   4. The normal link stays normal; a separate permanent, revocable link opens
 *      the duty-only administrator mode and keeps its capability in that tab.
 *
 *   node test/kolegi-admin.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3989';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const YEAR = '2026/2027';
const LOOK = 'b'.repeat(64);
const DUTY_ADMIN = 'c'.repeat(43);

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const writes = [];
let dutyAdminLinks = [];
let readerProfile = null, readerEnabled = false;
let changeUndone = false, planMoved = false;
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    const p = url.pathname;
    if (p.startsWith('/api/')) {
        if (req.method() !== 'GET') writes.push({ method: req.method(), path: p,
            token: req.headers()['x-mtb-portal-token'] || '', body: req.postData() || '' });
        if (p === '/api/health') return json(200, { ok: true });
        if (p === '/api/years') return json(200, [{ id: 1, label: YEAR, is_current: true }]);
        if (p === '/api/roster') return json(200, { year: YEAR, isCurrentYear: true, students: [], teachers: [], therapists: [], classes: [],
            candidates: { students: [], teachers: [], therapists: [], classes: [] } });
        if (p === '/api/categories') return json(200, { categories: [] });
        if (p === '/api/categories/holders') return json(200, { therapists: [], teachers: [] });
        if (p === '/api/duty/delegations' && req.method() === 'GET') return json(200, { links: dutyAdminLinks });
        if (p === '/api/duty/delegations' && req.method() === 'POST') {
            const link = { id: 'duty-link-1', createdAt: '2026-09-28T08:00:00Z',
                expiresAt: req.postDataJSON().hours == null ? null : '2026-09-29T08:00:00Z' };
            dutyAdminLinks = [link];
            return json(200, { url: '/kolegi#duty-admin=' + DUTY_ADMIN, link });
        }
        if (p === '/api/duty/delegations' && req.method() === 'DELETE') {
            const revoked = dutyAdminLinks.length;
            dutyAdminLinks = [];
            return json(200, { ok: true, revoked });
        }
        if (p === '/api/workspace/employees' && req.method() === 'POST') {
            const body=req.postDataJSON();
            if(body.identifier!==null || body.roles[0]!=='administration' || body.teacherKind!=='none') throw Error('New reader must use the directory writer without a teaching profile');
            readerProfile={employeeId:9,name:body.name,usernames:{latin:'IzmislenCitatel',cyrillic:'ИзмисленЧитател'},readOnly:false};
            return json(200,{employee:{id:9}});
        }
        if (p === '/api/staff-accounts/9/access') { readerEnabled=req.postDataJSON().readOnly;return json(200,{ok:true}); }
        if (p === '/api/staff-accounts') return json(200, { year: YEAR,
            candidates: [{employeeId:7,name:'Ана Измислена'},...(readerProfile?[{...readerProfile,readOnly:readerEnabled}]:[])], accounts: [
            { employeeId: 7, name: 'Ана Измислена', usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' }, teacher: true, therapist: false,
              ownPassword: true, lastLoginAt: '2026-09-25T07:00:00Z', ambiguous: false },
            { employeeId: 8, name: 'Двојно Име', usernames: { latin: 'DvojnoIme', cyrillic: 'ДвојноИме' }, teacher: false, therapist: true,
              ownPassword: false, lastLoginAt: null, ambiguous: true },
            ...(readerEnabled?[{...readerProfile,readOnly:true}]:[])
        ] });
        if (p === '/api/staff-notices') return json(200, { year: YEAR,
            notices: [{ id: 1, createdAt: '2026-09-25T08:00:00Z', recipient: 'Ана Измислена', author: 'Колега Бе', kind: 'lesson', day: 'понеделник',
                slot: '2', about: 'class:II-б', sentence: 'Колега Бе запиша „Физичко" во II-б, понеделник, 2. час.', seen: false, open: true }],
            teaching: [{ day: 'понеделник', ordinal: 2, class: 'II-б', who: ['Ана Измислена („Математика")', 'Колега Бе („Физичко")'] }],
            cabinet: [] });
        // The safety net (060): the record of colleagues' changes, the baseline and „Врати".
        if (p === '/api/portal-changes') return json(200, { year: YEAR, therapists: [{ id: 5, name: 'Двојно Име' }], changes: [
            { id: 3, at: '2026-10-13T09:00:00Z', therapistId: 5, therapist: 'Двојно Име', author: 'Двојно Име', day: 'понеделник', slot: '08:45-09:25',
              before: [], after: [{ publicId: 'p1', name: 'Ученик Измислен', time: '08:45-09:25' }], forced: false, undoOf: null, undoneAt: changeUndone ? '2026-10-13T10:00:00Z' : null, canUndo: !changeUndone },
            { id: 2, at: '2026-10-13T08:30:00Z', therapistId: 5, therapist: 'Двојно Име', author: 'Двојно Име', day: 'вторник', slot: '08:00-08:40',
              before: [{ publicId: 'p2', name: 'Ученичка Измислена', time: '08:20-08:40' }], after: [{ publicId: 'p1', name: 'Ученик Измислен', time: '08:00-08:40' }], forced: true, undoOf: null, undoneAt: null, canUndo: false }
        ] });
        if (p === '/api/portal-changes/baseline') return json(200, { year: YEAR, since: '2026-10-13T08:30:00Z', unchanged: 1, blocks: [
            { changeId: 2, day: 'вторник', slot: '08:00-08:40', was: [{ publicId: 'p2', name: 'Ученичка Измислена', time: '08:20-08:40' }], now: [{ publicId: 'p1', name: 'Ученик Измислен', time: '08:00-08:40' }], overlap: false }] });
        if (p === '/api/portal-changes/undo') { changeUndone = true; return json(200, { ok: true, notified: 1 }); }
        // Акциски план (061): the record, „Врати" and „Премести кај друг ученик".
        if (p === '/api/plan-changes') return json(200, { year: YEAR, authors: [{ employeeId: 7, name: 'Ана Измислена' }], categories: [{ code: 'logoped', name: 'Логопед' }],
            pupils: [{ publicId: 'p1', name: 'Ученик Измислен', class: 'II-б' }, { publicId: 'p2', name: 'Ученичка Измислена', class: 'II-б' }], changes: planMoved ? [] : [
            { id: 12, at: '2026-10-14T09:00:00Z', author: 'Ана Измислена', kind: 'write', part: 'marks:logoped:1', pupil: { publicId: 'p1', name: 'Ученик Измислен', class: 'II-б' },
              before: null, after: { data: { rows: [{ label: 'Артикулација', level: 2 }], note: '' }, by: 'Ана Измислена', confirmed: null }, undoOf: null, undoneAt: null, canUndo: true, canMove: true },
            { id: 11, at: '2026-10-14T08:00:00Z', author: 'Ана Измислена', kind: 'confirm', part: 'iop', pupil: { publicId: 'p2', name: 'Ученичка Измислена', class: 'II-б' },
              before: { data: { goals: 'Цел' }, by: 'Ана Измислена', confirmed: null },
              after: { data: { goals: 'Цел' }, by: 'Ана Измислена', confirmed: { by: 'Ана Измислена', employeeId: 7, at: '2026-10-14T08:00:00Z' } }, undoOf: null, undoneAt: null, canUndo: false, canMove: false }
        ] });
        if (p === '/api/plan-changes/move') { planMoved = true; return json(200, { ok: true, pupil: 'Ученик Измислен', part: 'marks:logoped:1', movedTo: 'Ученичка Измислена' }); }
        if (p === '/api/staff-accounts/7/reset') return json(200, { ok: true });
        if (p === '/api/staff-accounts/7/open') return json(200, { url: '/Kolega.html#as=' + LOOK, name: 'Ана Измислена', hours: 2 });
        if (p === '/api/portal/me') return req.headers()['x-mtb-portal-token'] === LOOK
            ? json(200, { person: { employeeId: 7, name: 'Ана Измислена' }, acting: true, usernames: { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' },
                initialPassword: false, year: YEAR, roles: ['teacher'], teacher: { id: 3 }, therapist: null })
            : json(401, { error: 'no' });
        if (p === '/api/portal/week') return json(200, { year: YEAR, days: ['понеделник'], periods: [{ ordinal: 1, label: '1', startsAt: '08:00' }],
            me: { teacherId: 3, therapistId: null, homeroom: [], subject: null }, classes: [], teachers: [], lessons: [], clashes: [], notices: [], cabinet: null });
        return json(404, { error: 'not in this test' });
    }
    const file = p === '/kolegi' ? 'Kolega.html' : decodeURIComponent(p.replace(/^\//, ''));
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('Podatoci: ' + e.message));
page.on('dialog', (d) => d.accept());

console.log('Податоци → Колеги');
await page.goto(`${ORIGIN}/Podatoci.html?tab=colleagues`);
await page.waitForSelector('#colleaguesAccounts table', { timeout: 8000 });
check('the link to hand out', (await page.textContent('#colleaguesLink')) === `${ORIGIN}/kolegi`, await page.textContent('#colleaguesLink'));
check('the ordinary and duty-administrator links are separate controls', await page.isVisible('#copyColleaguesLink')
    && await page.isVisible('#copyDutyAdmin') && /Нема активен/.test(await page.textContent('#dutyAdminState')));
check('the clashes standing now', /Колега Бе/.test(await page.textContent('#colleaguesClashes')));
const noticesText = await page.textContent('#colleaguesNotices');
check('the notices, to whom and whether still open', /Ана Измислена/.test(noticesText) && /отворено/.test(noticesText), noticesText);
const accountsText = await page.textContent('#colleaguesAccounts');
check('every account with its username in both scripts', /AnaIzmislena/.test(accountsText) && /АнаИзмислена/.test(accountsText));
check('and which still use the initial password', /почетна/.test(accountsText) && /своја/.test(accountsText));
check('a name two people share is marked', /исто име/.test(accountsText));

console.log('\nизмени од колегите — the safety net');
await page.waitForSelector('#colleaguesChanges table');
const changesText = await page.innerText('#colleaguesChanges');
check('a change says who, where, what stood there and what was written', /Двојно Име/.test(changesText) && /понеделник · 08:45–09:25/.test(changesText)
    && /слободен/.test(changesText) && /Ученик Измислен/.test(changesText), changesText);
check('one written over a clash says so', /и покрај судир/.test(changesText));
check('a pupil who held only half of the term is shown with those minutes', /Ученичка Измислена \(08:20–08:40\)/.test(changesText) && !/Ученик Измислен \(/.test(changesText), changesText);
check('only a change the term still holds offers „Врати"', await page.locator('[data-undo-change]').count() === 1
    && /сменето потоа/.test(await page.innerText('[data-change="2"]')));
check('the comparison waits for a cabinet to be chosen', await page.isDisabled('#changesBaseline'));
await page.click('[data-undo-change="3"]');
await page.waitForFunction(() => /Вратено/.test(document.getElementById('changesMsg').textContent));
check('„Врати" asks, then sends that change and nothing else', writes.some((w) => w.path === '/api/portal-changes/undo' && w.body === '{"id":3}'), JSON.stringify(writes.at(-1)));
check('and says the colleague was told', /Колегата е известен/.test(await page.textContent('#changesMsg')) && /вратено/.test(await page.innerText('[data-change="3"]')));
await page.selectOption('#changesTherapist', '5');
await page.waitForFunction(() => !document.getElementById('changesBaseline').disabled);
await page.click('#changesBaseline');
await page.waitForSelector('#changesBaselineBox table');
const baseText = await page.innerText('#changesBaselineBox');
check('the comparison shows what stood at the start beside what stands now', /вторник · 08:00–08:40/.test(baseText)
    && /Ученичка Измислена/.test(baseText) && /Ученик Измислен/.test(baseText) && /Уште 1 менуван термин е/.test(baseText), baseText);
await page.locator('#changesTitle').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(ROOT, 'backups/test-artifacts/kolegi-changes.png') });
await page.click('[data-undo-baseline="0"]');
await page.waitForFunction(() => !document.querySelector('#changesBaselineBox table'));
check('putting a term back to the start sends what the screen showed as standing now',
    writes.some((w) => w.path === '/api/portal-changes/undo' && w.body === '{"id":2,"baseline":{"ids":["p1"],"times":["08:00-08:40"]}}'), JSON.stringify(writes.at(-1)));
const planText = await page.innerText('#planChanges');
check('the record of the plans says who wrote which part for which pupil', /Ана Измислена/.test(planText) && /Ученик Измислен/.test(planText)
    && /Логопед · оцени, квартал 1/.test(planText) && /Артикулација 2/.test(planText) && /потврдил.а Ана/.test(planText), planText);
check('only the last word on a part offers „Врати", and only written content can be moved', await page.locator('[data-plan-undo]').count() === 1
    && await page.locator('[data-plan-move]').count() === 1 && /сменето потоа/.test(await page.innerText('[data-plan-change="11"]')));
await page.click('[data-plan-move="12"]');
check('the pupil it belongs to is chosen in the row, never the one it stands on', await page.locator('[data-plan-move-to] option').count() === 2
    && !/Ученик Измислен/.test(await page.innerText('[data-plan-move-to]')));
await page.click('[data-plan-move-go="12"]');
check('nothing moves until a pupil is chosen', !writes.some((w) => w.path === '/api/plan-changes/move') && /Изберете/.test(await page.textContent('#planChangesMsg')));
await page.selectOption('[data-plan-move-to]', 'p2');
await page.click('[data-plan-move-go="12"]');
await page.waitForFunction(() => /Преместено/.test(document.getElementById('planChangesMsg').textContent));
check('„Премести" asks, then sends the change and the pupil', writes.some((w) => w.path === '/api/plan-changes/move' && w.body === '{"id":12,"toPublicId":"p2"}'), JSON.stringify(writes.at(-1)));
await page.click('[data-reset-colleague="7"]');
await page.waitForTimeout(300);
check('„Врати почетна лозинка" asks, then resets', writes.some((w) => w.path === '/api/staff-accounts/7/reset'));

check('new reader form starts closed', !(await page.isVisible('#newReaderForm')));
await page.click('#newReaderToggle');await page.fill('#newReaderName','Измислен Читател');
await page.click('#newReaderForm button[type="submit"]');
await page.waitForSelector('[data-remove-reader="9"]');
check('new administration profile receives read-only access', readerEnabled && /Само преглед/.test(await page.textContent('[data-account="9"]')));
await page.click('[data-remove-reader="9"]');
await page.waitForFunction(()=>!document.querySelector('[data-account="9"]'));
check('removing a staff-only reader preserves them in the employee picker', await page.locator('#readOnlyEmployee option[value="9"]').count()===1);
await page.selectOption('#readOnlyEmployee','9');await page.click('#readOnlyGrant button[type="submit"]');
await page.waitForSelector('[data-remove-reader="9"]');
check('existing administrative employee can be granted again', readerEnabled && writes.filter(w=>w.path==='/api/workspace/employees').length===1);
// Owner, 5 Oct 2026: one link for everybody, the account decides; the owner needs none.
check('the access cards say who each kind of access is for', await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#tab-colleagues .access-card h4')].map((h) => h.textContent);
    return cards.length === 3 && /сите колеги/.test(cards[0]) && /без линк/.test(cards[1]) && /Дежурства/.test(cards[2]);
}));
check('an account says what it may do', /👁 Само преглед/.test(await page.textContent('[data-account="9"]'))
    && /Што смее/.test(await page.textContent('#colleaguesAccounts thead')));
if (process.env.SHOT) await page.screenshot({ path: join(process.env.SHOT, 'kolegi-access.png'), fullPage: true });

console.log('\nthe duty-only administrator link');
check('new links are permanent by default', await page.inputValue('#dutyAdminHours') === '0');
const [dutyPopup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#openDutyAdmin')
]);
dutyPopup.on('pageerror', (e) => errors.push('Duty link: ' + e.message));
await dutyPopup.waitForSelector('#login:not([hidden])', { timeout: 8000 });
check('creating it sends the chosen lifetime', writes.some((w) => w.path === '/api/duty/delegations'
    && w.method === 'POST' && JSON.parse(writes.find((x) => x.path === '/api/duty/delegations' && x.method === 'POST').body || '{}').hours === null));
check('the link requires the recipient to sign in normally', await dutyPopup.isVisible('#login'));
check('its capability is taken out of the address and kept only in that tab', !dutyPopup.url().includes(DUTY_ADMIN)
    && await dutyPopup.evaluate((t) => sessionStorage.getItem('mtb_duty_admin_v1') === t, DUTY_ADMIN));
check('Податоци reports the permanent link without inventing an expiry', /Активни администраторски линкови: 1\. Без рок: 1/.test(await page.textContent('#dutyAdminState')));
await page.click('#revokeDutyAdmins');
await page.waitForTimeout(200);
check('the owner can revoke the shared link', writes.some((w) => w.path === '/api/duty/delegations' && w.method === 'DELETE')
    && /Нема активен/.test(await page.textContent('#dutyAdminState')));
await dutyPopup.close();
await page.setViewportSize({ width: 400, height: 800 });
await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text) => { window.copiedDutyLink = text; } }
}));
await page.click('#copyDutyAdmin');
await page.waitForFunction(() => Boolean(window.copiedDutyLink));
check('the separate copy button shares the admin link, not the ordinary one',
    await page.evaluate((t) => window.copiedDutyLink.endsWith('#duty-admin=' + t), DUTY_ADMIN));
check('the administrator entry and displayed link fit a phone', await page.evaluate(() =>
    ['openDutyAdmin', 'copyDutyAdmin', 'revokeDutyAdmins', 'dutyAdminLink'].every((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth;
    })));
await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable'); }; });
await page.click('#copyDutyAdmin');
await page.waitForTimeout(200);
check('a blocked clipboard leaves a visible link for manual copying', await page.isVisible('#dutyAdminLink')
    && (await page.textContent('#dutyAdminLink')).endsWith('#duty-admin=' + DUTY_ADMIN));
await page.setViewportSize({ width: 1400, height: 1000 });

console.log('\nthe administrator\'s look');
const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('[data-open-colleague="7"]')
]);
popup.on('pageerror', (e) => errors.push('Kolega: ' + e.message));
await popup.waitForSelector('#home:not([hidden])', { timeout: 8000 });
check('it opens that colleague\'s form in a new tab', (await popup.textContent('#homeName')) === 'Ана Измислена');
check('the banner says it is the administrator\'s look', await popup.isVisible('#actingBanner'));
check('no password change and no sign-out are offered', !(await popup.isVisible('#openPassword')) && !(await popup.isVisible('#logout')));
check('the look is taken out of the address at once', !popup.url().includes(LOOK), popup.url());
check('and stays in that tab only', await popup.evaluate((t) => sessionStorage.getItem('mtb_portal_acting_v1') === t
    && localStorage.getItem('mtb_portal_token_v1') === null, LOOK));
check('no page errors', errors.length === 0, errors.join('\n       '));

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
