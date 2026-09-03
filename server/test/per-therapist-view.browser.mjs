import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

let failures = 0;
const check = (label, condition, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else {
        failures++;
        console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
    }
};

const fixture = {
    students: ['Избери Ученик', 'Ученик Алфа', 'Ученик Бета', 'Ученик Гама'],
    therapists: ['Терапевт Север', 'Терапевт Југ'],
    therapistStudents: {
        'Терапевт Север': ['Ученик Алфа', 'Ученик Бета', 'Ученик Гама'],
        'Терапевт Југ': ['Ученик Гама']
    },
    studentMeta: {
        'Ученик Алфа': { grade: 'I-а', category: '', school: '', studentId: 'PTV-A' },
        'Ученик Бета': { grade: 'II', category: '', school: '', studentId: 'PTV-B' },
        'Ученик Гама': { grade: '', category: 'other', school: 'Пример училиште', studentId: 'PTV-C' }
    },
    customGrades: ['I-а', 'II'],
    schedule: [
        { day: 'понеделник', time: '08:00-08:20', assignments: { 'Терапевт Север': 'Ученик Алфа' } },
        { day: 'понеделник', time: '08:20-08:40', assignments: { 'Терапевт Север': 'Ученик Алфа' } },
        { day: 'вторник', time: '08:00-08:20', assignments: { 'Терапевт Север': 'Ученик Бета' } },
        { day: 'вторник', time: '08:20-08:40', assignments: { 'Терапевт Север': 'Ученик Гама' } },
        { day: 'среда', time: '08:00-08:20', assignments: { 'Терапевт Југ': 'Ученик Гама' } },
        { day: 'среда', time: '08:20-08:40', assignments: { 'Терапевт Југ': 'Ученик Гама' } }
    ]
};

const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
        if (pathname === '/blank') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><title>blank</title>');
            return;
        }
        const relative = pathname === '/' ? 'Rasporedi.html' : pathname.replace(/^\/+/, '');
        const full = resolve(ROOT, relative);
        if (!full.startsWith(ROOT)) throw new Error('outside test root');
        const body = await readFile(full);
        res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream' });
        res.end(body);
    } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(error));
    }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

try {
    await page.goto(base + '/blank');
    await page.evaluate((state) => {
        localStorage.clear();
        localStorage.setItem('therapistScheduleData_v2', JSON.stringify(state));
    }, fixture);
    await page.goto(base + '/Rasporedi.html');
    await page.waitForTimeout(180); // allow the app's saved-tab restoration to settle
    await page.locator('.tab-btn[data-tab="per-therapist"]').click();
    await page.waitForTimeout(100);
    const tabState = await page.evaluate(() => ({
        active: document.getElementById('panel-per-therapist')?.classList.contains('active'),
        selected: document.querySelector('.tab-btn[data-tab="per-therapist"]')?.getAttribute('aria-selected'),
        switchType: typeof switchTab
    }));
    if (!tabState.active) throw new Error(`Per-therapist tab did not activate: ${JSON.stringify(tabState)}; page errors: ${pageErrors.join(' | ')}`);
    await page.locator('.pt-all-section').first().waitFor({ state: 'attached' });

    const viewState = await page.evaluate(() => {
        const panel = document.getElementById('panel-per-therapist');
        const card = document.getElementById('perTherapistCard');
        const all = document.getElementById('allTherapistSchedules');
        return {
            panel: { className: panel?.className, display: panel ? getComputedStyle(panel).display : '' },
            card: { inline: card?.style.display, display: card ? getComputedStyle(card).display : '' },
            all: { hidden: all?.hidden, display: all ? getComputedStyle(all).display : '' }
        };
    });

    console.log('\nall therapists view');
    check('the all-schedules surface is visible', await page.locator('#allTherapistSchedules').isVisible(), JSON.stringify(viewState));
    check('all schedules is the default mode', await page.locator('#ptModeAll').getAttribute('aria-pressed') === 'true');
    check('the selected-therapist print action stays hidden in all mode', !(await page.locator('#printCurrentTherapistBtn').isVisible()));
    check('one schedule section is rendered per therapist', await page.locator('.pt-all-section').count() === 2);
    check('each weekly grid has six periods', await page.locator('.pt-all-section').first().locator('tbody tr').count() === 6);
    check('the grid has time plus five day columns', await page.locator('.pt-all-section').first().locator('thead th').count() === 6);

    const allText = await page.locator('#allTherapistSchedules').innerText();
    check('grade and pupil are shown in the slot', allText.includes('I-а - Ученик Алфа'));
    check('external pupils carry the external marker', allText.includes('(над.) - Ученик Гама'));
    check('the all-schedules overview is read-only', await page.locator('#allTherapistSchedules [data-action="candidate-selector"]').count() === 0);

    const printAction = page.locator('.pt-all-section').first().locator('button[title="Печати го овој распоред"]');
    const printActionState = await printAction.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { display: style.display, visibility: style.visibility, opacity: style.opacity, width: rect.width, height: rect.height, hidden: element.hidden };
    });
    check('the individual print action is visible', await printAction.isVisible(), JSON.stringify(printActionState));
    await printAction.click();
    await page.locator('#printCenterBackdrop.show').waitFor();
    const picked = await page.locator('.print-check input[data-t]:checked').evaluateAll((nodes) => nodes.map((node) => node.dataset.t));
    check('individual print selects only that therapist', picked.length === 1 && picked[0] === 'Терапевт Север', picked.join(', '));
    await page.evaluate(() => closePrintCenter());

    console.log('\nsingle therapist view');
    await page.locator('#ptModeSingle').click();
    check('single mode exposes the therapist selector', await page.locator('#perTherapistSelectorGroup').isVisible());
    check('single mode exposes its direct print action', await page.locator('#printCurrentTherapistBtn').isVisible());
    check('single mode keeps an editable weekly grid', await page.locator('#perTherapistContainer [data-action="candidate-selector"]').count() > 0);
    check('comparison is available only in single mode', await page.locator('#therapistCompareCard').isVisible());

    await page.setViewportSize({ width: 390, height: 844 });
    check('mobile layout does not widen the page', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    check('no page errors', pageErrors.length === 0, pageErrors.join('\n       '));
} finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall assertions held\n');
process.exit(failures ? 1 : 0);
