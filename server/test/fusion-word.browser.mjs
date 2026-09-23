/**
 * „📄 Word" in RasporediFusion: the week of the chosen therapist, or of every
 * therapist on a page of their own, as a document Word opens.
 *
 * Self-contained: the page and its scripts are read from disk on a fake
 * localhost origin and every API call is answered here with invented data.
 * Nothing reaches a real server; any write is refused and fails the test.
 * CHROME can select an installed browser.
 *
 *   node test/fusion-word.browser.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://localhost:3997';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const year = '2026/2027';
const students = [
    { public_id: 'word-a', name: 'Пробно Име', grade: 'III', active: true },
    { public_id: 'word-b', name: 'Пробно Име', grade: 'IV', active: true },
    { public_id: 'word-c', name: 'Друго Пробно', grade: 'V', active: true }
];
const therapists = [
    { id: 1, name: 'Терапевт Пример А', students: ['word-a', 'word-b', 'word-c'] },
    { id: 2, name: 'Терапевт Пример Б', students: ['word-a'] },
    { id: 3, name: 'Терапевт Без Посети', students: [] }
];
const session = (day, time, therapist_id, student_public_id) => ({ day, time, therapist_id, student_public_id });
const sessions = [
    // Two 20-minute halves of one pupil are one 40-minute term.
    session('понеделник', '08:00-08:20', 1, 'word-a'), session('понеделник', '08:20-08:40', 1, 'word-a'),
    // Two pupils share a block, one half each.
    session('вторник', '08:45-09:05', 1, 'word-b'), session('вторник', '09:05-09:25', 1, 'word-c'),
    session('среда', '08:00-08:40', 2, 'word-a')
];
const bells = [{ label: 'I', startsAt: '08:00', minutes: 40 }, { label: 'II', startsAt: '08:45', minutes: 40 }];

let fails = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
const errors = [], writes = [];
await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 405 }); }
        const data = {
            '/api/health': { ok: true, server: { label: 'Пробна база' } },
            '/api/years': [{ id: 1, label: year, is_current: true }],
            '/api/roster': { year, students, therapists, teachers: [] },
            '/api/schedule/sessions': { sessions },
            '/api/teaching/timetable': { bells: { kabinet: bells } },
            '/api/teaching/crossing': { cells: [] }
        }[url.pathname];
        return route.fulfill({ status: data ? 200 : 401, contentType: 'application/json', body: JSON.stringify(data || {}) });
    }
    const file = url.pathname.replace(/^\//, '');
    const path = join(ROOT, file);
    if (!file || file.includes('..') || file.includes('/') || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: await readFile(path) });
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(ORIGIN + '/RasporediFusion.html');
await page.locator('#scheduleGrid .schedule-grid').waitFor();

async function exportWord() {
    const waiting = page.waitForEvent('download');
    await page.click('#exportWord');
    const download = await waiting;
    const bytes = await readFile(await download.path());
    // WORD_OUT=<dir> keeps the files, to open them in real Word by hand.
    if (process.env.WORD_OUT) await download.saveAs(join(process.env.WORD_OUT, download.suggestedFilename()));
    return { name: download.suggestedFilename(), text: bytes.toString('utf8') };
}
const PAGE_BREAK = '<br clear="all" style="page-break-before:always">';
const pagesOf = (text) => text.split(PAGE_BREAK);
const count = (text, needle) => text.split(needle).length - 1;

try {
    console.log('\nall therapists');
    const all = await exportWord();
    const pages = pagesOf(all.text);
    check('the file is named for everyone and the year', all.name === 'Распоред_сите_терапевти_2026-2027.doc', all.name);
    check('it starts with a byte-order mark, so Word reads Cyrillic', all.text.charCodeAt(0) === 0xfeff);
    check('Word opens it in print layout', all.text.includes('<w:View>Print</w:View>'));
    check('the page is landscape the way Word reads it', all.text.includes('mso-page-orientation:landscape') && all.text.includes('div.Sheet{page:Sheet;}'));
    check('one page per therapist', pages.length === 3, String(pages.length));
    check('each page names its therapist, in roster order',
        pages[0].includes('Неделен распоред — Терапевт Пример А') && pages[1].includes('Неделен распоред — Терапевт Пример Б') &&
        pages[2].includes('Неделен распоред — Терапевт Без Посети'));
    check('each page carries the school and the year', pages.every((p) => p.includes('Кочо Рацин') && p.includes(year)));
    check('all five days are columns on every page',
        pages.every((p) => ['Понеделник', 'Вторник', 'Среда', 'Четврток', 'Петок'].every((d) => p.includes('<th>' + d + '</th>'))));
    check('every bell is a row on every page', pages.every((p) => count(p, 'class="slot"><b class="roman">') === 2));
    check('two halves of one pupil are ONE 40-minute term', count(pages[0], '<b>III - Пробно Име</b>') === 1 && pages[0].includes('>40′</span> <b>III - Пробно Име</b>'));
    check('two pupils sharing a block are both there, first and second half',
        pages[0].includes('>1/2</span> <b>IV - Пробно Име</b>') && pages[0].includes('>2/2</span> <b>V - Друго Пробно</b>'));
    check('same-name pupils stay apart by class', pages[0].includes('III - Пробно Име') && pages[0].includes('IV - Пробно Име'));
    check('a term is on its therapist\'s page only', pages[1].includes('III - Пробно Име') && !pages[1].includes('IV - Пробно Име'));
    check('a therapist with no terms still gets a page, all free', count(pages[2], '<td class="free">') === 10 && !pages[2].includes('class="pupil"'));
    check('each half carries its own time', pages[0].includes('08:45 - 09:05') && pages[0].includes('09:05 - 09:25'));
    check('nothing executable in the document', !/<script/i.test(all.text));

    console.log('\none therapist');
    await page.selectOption('#focus', '1');
    const one = await exportWord();
    check('the file is named for that therapist', one.name === 'Распоред_Терапевт_Пример_А_2026-2027.doc', one.name);
    check('it has exactly one page', pagesOf(one.text).length === 1);
    check('it is that therapist and no one else',
        one.text.includes('Терапевт Пример А') && !one.text.includes('Терапевт Пример Б') && !one.text.includes('Терапевт Без Посети'));
    check('it is the same page as in the all-therapists file', pagesOf(one.text)[0].includes(pages[0].split('<h1>')[1].split('</table>')[0]));

    console.log('\nsafety');
    check('no API writes', writes.length === 0, writes.join(', '));
    check('no page errors', errors.length === 0, errors.join('\n'));
} finally {
    await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
