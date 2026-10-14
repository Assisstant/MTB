/**
 * The bank of suggestions for Колега → „Акциски план", phase 1: content only.
 *
 *     npm run banka:pregled              the review documents, one per domain (Word)
 *     npm run banka:pregled -- --dump    every source item with its id, as text
 *     npm run banka:pregled -- --out D   write the documents into folder D
 *
 * WHY THREE FILES. `docs/akciski-banka/izvor.md` is the owner's proposal exactly
 * as written and is never edited: it is what „nothing was lost" is checked
 * against. `predlozi.json` holds everything said ABOUT a source item — a
 * proposed wording, the items of the евидентен лист it belongs with, the
 * reviewer's decision — keyed by the item's id. The review documents are
 * derived from the two, so a correction is an edit of predlozi.json and a new
 * run, and the original wording stays beside every change.
 *
 * WHY IDS FROM THE POSITION. An id is domain + kind + place in the source
 * (`IV-C03`: third proposed goal of domain IV). The source does not move, so
 * the id does not either; content added later gets its own id in `dodadeni`.
 *
 * The application never invents clinical content (APP-CONTRACT). A wording
 * proposed here is a proposal: only an item marked „odobreno" may reach Колега.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
export const SOURCE = 'docs/akciski-banka/izvor.md';
export const OVERLAY = 'docs/akciski-banka/predlozi.json';
export const CATALOGUE = 'database/migrations/022_evidence_sheets.sql';

/** C goal · P sub-area · A activity · I indicator · S starting state · R accommodation · N a sentence outside a list */
export type Kind = 'C' | 'P' | 'A' | 'I' | 'S' | 'R' | 'N';
export type Item = {
    id: string; domain: string | null; kind: Kind; section: number; heading: string;
    /** The line as the source has it, without its bullet. */
    original: string;
    /** The same without the list's trailing „;". */
    text: string;
    parent?: string;
};
export type Domain = { code: string; title: string; section: number };
export type Status = 'pregled' | 'odobreno' | 'dorabotka';
export type Note = { predlog?: string; odnesuvanje?: string; proverka?: string; list?: string[]; status?: Status; odobreno?: string; beleska?: string };
export type Overlay = {
    izdanie: number;
    termini: [string, string][];
    stavki: Record<string, Note>;
    dodadeni: { id: string; domain: string; kind: Kind; text: string; beleska?: string }[];
};
export type SheetItem = { key: string; section: string; label: string; group: string | null };

export const KINDS: Record<Kind, string> = { P: 'Подобласти', C: 'Цели', A: 'Активности', I: 'Индикатори', S: 'Почетна состојба', R: 'Прилагодувања', N: 'Напомени во изворот' };
export const STATUS: Record<Status, string> = { pregled: 'За преглед', odobreno: 'Одобрено', dorabotka: 'За доработка' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];

function kindOf(heading: string): Kind {
    if (/цели/i.test(heading)) return 'C';
    if (/приоритети|подобласти|вештини/i.test(heading)) return 'P';
    if (/активности/i.test(heading)) return 'A';
    if (/индикатори/i.test(heading)) return 'I';
    if (/почетна состојба/i.test(heading)) return 'S';
    if (/прилагодувања/i.test(heading)) return 'R';
    return 'N';
}

/** Every list item and every sentence of the source, in order, each with a stable id. */
export function parseSource(text: string): { items: Item[]; domains: Domain[] } {
    const items: Item[] = [], domains: Domain[] = [], counts = new Map<string, number>();
    let section = 0, h2 = '', h3 = '', domain: string | null = null, last: Item | null = null;
    const next = (key: string) => { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return String(n).padStart(2, '0'); };
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trimEnd();
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^# (?:(\d+)\. )?(.*)$/))) { section = Number(m[1] || 0); h2 = ''; h3 = ''; domain = null; last = null; continue; }
        if ((m = line.match(/^## (.*)$/))) {
            h2 = m[1]; h3 = ''; last = null;
            const d = h2.match(/^([IVX]+)\. (.+)$/);
            domain = d && ROMAN.includes(d[1]) && (section === 4 || section === 5) ? d[1] : null;
            if (domain) domains.push({ code: domain, title: d![2], section });
            continue;
        }
        if ((m = line.match(/^### (.*)$/))) { h3 = m[1]; last = null; continue; }
        if (!line.trim() || /^-{3,}$/.test(line.trim()) || !section) continue;
        const bullet = line.match(/^(\s*)(?:-|\d+\.)\s+(.*)$/);
        const original = (bullet ? bullet[2] : line.trim().replace(/^>\s*/, '')).trim();
        const kind: Kind = bullet && domain ? kindOf(h3) : bullet ? 'P' : 'N';
        const id = domain ? `${domain}-${kind}${next(domain + kind)}` : `G${section}-${next('G' + section)}`;
        const item: Item = { id, domain, kind: domain ? kind : bullet ? 'P' : 'N', section, heading: [h2, h3].filter(Boolean).join(' › '), original, text: original.replace(/;$/, '') };
        if (bullet && bullet[1].length >= 2 && last) item.parent = last.id; else if (bullet) last = item;
        items.push(item);
    }
    return { items, domains };
}

/** The items of the prescribed sheet as migration 022 seeded them, keyed the way the old app keyed its scores (`s6_3`). */
export function sheetItems(sql: string): SheetItem[] {
    const groups = new Map<string, string>();
    for (const m of sql.matchAll(/INSERT INTO evidence_groups .*? SELECT id, '((?:[^']|'')*)', (\d+) FROM evidence_sections WHERE code = '(s\d+)'/g)) groups.set(`${m[3]}:${m[2]}`, m[1]);
    return [...sql.matchAll(/INSERT INTO evidence_items .*? SELECT (?:s\.)?id(?:, g\.id)?, '((?:[^']|'')*)', (\d+) FROM evidence_sections(?: s JOIN evidence_groups g ON g\.section_id = s\.id AND g\.ord = (\d+))? WHERE (?:s\.)?code = '(s\d+)'/g)]
        .map((m) => ({ key: `${m[4]}_${m[2]}`, section: m[4], label: m[1].replace(/''/g, "'"), group: m[3] ? groups.get(`${m[4]}:${m[3]}`) || null : null }));
}
/** The sheet's section of a domain: I–XI are s1–s11; XII–XV are panels of free text, with no items to link. */
export const sheetSection = (domain: string) => { const n = ROMAN.indexOf(domain) + 1; return n >= 1 && n <= 11 ? 's' + n : null; };

export function withTerms(text: string, terms: [string, string][]) {
    return terms.reduce((out, [from, to]) => out.split(from).join(to), text);
}
/** What is proposed in place of the source wording, and who proposed it — or nothing, when the source stands as written. */
export function proposal(item: Item, overlay: Overlay): { text: string; by: string } | null {
    const note = overlay.stavki[item.id] || {};
    if (note.predlog) return { text: note.predlog, by: 'предлог' };
    const translated = withTerms(item.text, overlay.termini);
    return translated !== item.text ? { text: translated, by: 'превод на термин' } : null;
}
/** The measurable form of a goal: the behaviour is proposed, every value is the specialist's to fill in. */
export const SLOTS = '[во каква ситуација], [со колкава помош], [со кој критериум], [до кога]';
export const CHECK = 'Проверка: [колку успешни обиди] од [колку обиди], во [колку набљудувања]';
export function measurable(item: Item, overlay: Overlay) {
    const b = (overlay.stavki[item.id] || {}).odnesuvanje;
    return b ? `Ученикот ${b} ${SLOTS}.` : null;
}
/** The wording that may reach Колега: only what a person approved. */
export function approved(item: Item, overlay: Overlay) {
    const note = overlay.stavki[item.id] || {};
    if (note.status !== 'odobreno') return null;
    return note.odobreno || measurable(item, overlay) || (proposal(item, overlay) || { text: item.text }).text;
}

export function problems(items: Item[], overlay: Overlay, sheet: SheetItem[]): string[] {
    const errors: string[] = [], ids = new Set(items.map((i) => i.id)), keys = new Set(sheet.map((s) => s.key));
    if (ids.size !== items.length) errors.push('Два изворни реда имаат ист ID.');
    if (!Number.isInteger(overlay.izdanie) || overlay.izdanie < 0) errors.push('Изданието мора да биде цел ненегативен број.');
    for (const added of overlay.dodadeni) {
        if (ids.has(added.id) || !ROMAN.includes(added.domain) || !Object.hasOwn(KINDS, added.kind)
            || !new RegExp('^' + added.domain + '-' + added.kind + '\\d{2,}$').test(added.id) || !added.text.trim()) {
            errors.push(`dodadeni: „${added.id}" се судира со изворот или нема валидно подрачје, вид и текст.`);
        }
        ids.add(added.id);
    }
    for (const [id, note] of Object.entries(overlay.stavki)) {
        if (!ids.has(id)) errors.push(`predlozi.json: „${id}" не постои во изворот.`);
        if (note.status && !Object.hasOwn(STATUS, note.status)) errors.push(`${id}: непознат статус „${note.status}".`);
        for (const key of note.list || []) if (!keys.has(key)) errors.push(`${id}: „${key}" не е ставка од евидентниот лист.`);
        if (note.status === 'odobreno' && overlay.izdanie < 1) errors.push(`${id}: одобрена ставка бара издание 1 или поголемо.`);
        if (note.odnesuvanje && !id.includes('-C')) errors.push(`${id}: „odnesuvanje" е само за цели.`);
        if (note.proverka && !id.includes('-C')) errors.push(`${id}: „proverka" е само за цели.`);
        for (const field of ['predlog', 'odnesuvanje', 'proverka', 'odobreno'] as const) {
            if (note[field] !== undefined && (typeof note[field] !== 'string' || !note[field]!.trim())) errors.push(`${id}: „${field}" мора да има текст.`);
        }
    }
    for (const [from] of overlay.termini) if (!items.some((i) => i.text.includes(from))) errors.push(`Терминот „${from}" го нема во изворот.`);
    return errors;
}

// ── the review documents ──────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const CSS = '@page{size:A4 landscape;margin:12mm 12mm;}body{font-family:Calibri,Arial,sans-serif;font-size:10.5pt;color:#111;}'
    + 'h1{font-size:17pt;margin:0 0 2pt;color:#1f3a5f;}h2{font-size:13pt;margin:14pt 0 4pt;color:#1f3a5f;}p{margin:3pt 0;}'
    + 'table{width:100%;border-collapse:collapse;}th,td{border:1px solid #8a94a3;padding:3pt 5pt;vertical-align:top;}'
    + 'th{background:#e6ecf4;text-align:left;font-size:9.5pt;}td.id{white-space:nowrap;font-size:9pt;color:#444;}'
    + '.by{font-size:8.5pt;color:#8a5a00;}.muted{color:#555;font-size:9.5pt;}.box{border:1px solid #8a94a3;padding:5pt 8pt;margin:6pt 0;background:#f7f9fc;}';
const DECIDE = '☐ Одобрено<br>☐ За доработка';

function page(title: string, body: string) {
    return '﻿<!DOCTYPE html><html lang="mk"><head><meta charset="UTF-8"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}
function head(title: string, overlay: Overlay, today: string) {
    return `<h1>${esc(title)}</h1><p class="muted">Банка на предлози за „Акциски план" во Колега · издание ${overlay.izdanie} (${overlay.izdanie ? 'одлуката е означена кај секоја ставка' : 'нацрт — ништо уште не е одобрено'}) · ${today}</p>`
        + '<p>Прегледал/а: ______________________________ &nbsp; Датум: ______________</p>'
        + '<div class="box"><b>Како се прегледува.</b> Секој ред е една ставка од изворниот предлог, со својот ID. Во „Корекција" допишете како треба да гласи; '
        + 'во „Одлука" штиклирајте. Празно „Корекција" + „Одобрено" значи: останува како што е предложено (или како во изворот, ако нема предлог). '
        + 'Ставка што недостига допишете ја на крајот. Во Колега влегува само она што е одобрено, и секогаш како предлог што колегата го менува.</div>';
}
function rows(list: Item[], overlay: Overlay, sheet: Map<string, SheetItem>, linked: boolean) {
    return list.map((item) => {
        const note = overlay.stavki[item.id] || {}, prop = proposal(item, overlay), goal = measurable(item, overlay);
        const proposed = [prop ? `${esc(prop.text)} <span class="by">(${prop.by})</span>` : '', goal ? `${esc(goal)}<br>${esc(note.proverka || CHECK)}. <span class="by">(предлог за мерлива цел)</span>` : ''].filter(Boolean).join('<br><br>');
        const links = (note.list || []).map((key) => esc(sentence(sheet.get(key)!.label))).join('; ');
        return `<tr><td class="id">${item.id}</td><td>${item.parent ? '&nbsp;&nbsp;– ' : ''}${esc(item.original)}</td><td>${proposed || '<span class="muted">— без промена —</span>'}`
            + (note.beleska ? `<br><span class="by">${esc(note.beleska)}</span>` : '') + '</td>'
            + (linked ? `<td>${links || '<span class="muted">—</span>'}</td>` : '')
            + `<td>${esc(note.odobreno || '')}</td><td>${note.status && note.status !== 'pregled' ? esc(STATUS[note.status]) : DECIDE}</td></tr>`;
    }).join('');
}
function table(list: Item[], overlay: Overlay, sheet: Map<string, SheetItem>, linked: boolean) {
    return '<table><tr><th style="width:6%">ID</th><th style="width:' + (linked ? 22 : 27) + '%">Изворен текст</th><th style="width:' + (linked ? 28 : 33) + '%">Предлог</th>'
        + (linked ? '<th style="width:14%">Ставки од евидентниот лист</th>' : '') + '<th style="width:' + (linked ? 20 : 24) + '%">Корекција</th><th style="width:10%">Одлука</th></tr>' + rows(list, overlay, sheet, linked) + '</table>';
}

export function domainDocument(domain: Domain, items: Item[], overlay: Overlay, sheetList: SheetItem[], today: string) {
    const sheet = new Map(sheetList.map((s) => [s.key, s])), mine = items.filter((i) => i.domain === domain.code), section = sheetSection(domain.code);
    let body = head(`${domain.code}. ${domain.title}`, overlay, today);
    for (const kind of Object.keys(KINDS) as Kind[]) {
        const list = mine.filter((i) => i.kind === kind);
        if (!list.length) continue;
        body += `<h2>${KINDS[kind]} (${list.length})</h2>`;
        if (kind === 'C') body += '<p class="muted">Формула: Ученикот + ќе изведе што + во каква ситуација + со колкава помош + со кој критериум + до кога. '
            + 'Вредностите во заградите ги избира стручниот работник; банката не задава праг. Цел со договорена помош може да биде постигната и без оценка 4.</p>';
        body += table(list, overlay, sheet, Boolean(section) && (kind === 'C' || kind === 'P'));
        if (kind === 'P' && section) {
            const used = new Set(mine.flatMap((i) => (overlay.stavki[i.id] || {}).list || []));
            const free = sheetList.filter((s) => s.section === section && !used.has(s.key));
            body += `<p class="muted"><b>Ставки од евидентниот лист што не се поврзани со ниедна подобласт или цел погоре:</b> ${free.length ? free.map((s) => esc((s.group ? s.group.replace(/:$/, '') + ' — ' : '') + sentence(s.label))).join('; ') : 'нема'}.</p>`;
        }
    }
    const added = overlay.dodadeni.filter((a) => a.domain === domain.code);
    if (added.length) body += '<h2>Додадено по прегледот</h2>'
        + table(added.map((a) => ({ ...a, original: a.text, heading: '', section: domain.section })), overlay, sheet, Boolean(section));
    body += '<h2>Што недостига</h2><p class="muted">Цел, активност или индикатор што треба да се додаде во ова подрачје:</p><p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p>'
        + '<p class="muted">Скала во Колега: 0 не реагира · 1 целосна помош · 2 делумна помош · 3 минимална помош · 4 самостојно. Непополнета оценка значи „не е проценето", не 0.</p>';
    return page(`${domain.code}. ${domain.title}`, body);
}
/** The lists that belong to no single domain: criteria, ways of following, accommodations, ААК, the review's outcomes, kinds of goal, the formula. */
export const GENERAL = [3, 6, 7, 8, 11, 14, 15];
export function generalDocument(items: Item[], overlay: Overlay, today: string, title: (n: number) => string) {
    let body = head('Општи листи', overlay, today);
    for (const n of GENERAL) {
        const list = items.filter((i) => !i.domain && i.section === n);
        if (!list.length) continue;
        body += `<h2>${n}. ${esc(title(n))} (${list.length})</h2>`;
        // One table for the section; a heading of the source is a band across it, not a table of its own.
        body += '<table><tr><th style="width:6%">ID</th><th style="width:27%">Изворен текст</th><th style="width:33%">Предлог</th><th style="width:24%">Корекција</th><th style="width:10%">Одлука</th></tr>'
            + [...new Set(list.map((i) => i.heading))].map((heading) => (heading ? `<tr><td colspan="5" style="background:#f1f4f9"><b>${esc(heading)}</b></td></tr>` : '')
                + rows(list.filter((i) => i.heading === heading), overlay, new Map(), false)).join('') + '</table>';
    }
    return page('Општи листи', body);
}

export function load() {
    const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');
    const source = read(SOURCE), parsed = parseSource(source);
    const titles = new Map([...source.matchAll(/^# (\d+)\. (.*)$/gm)].map((m) => [Number(m[1]), m[2].trim()]));
    return { ...parsed, overlay: JSON.parse(read(OVERLAY)) as Overlay, sheet: sheetItems(read(CATALOGUE)), title: (n: number) => titles.get(n) || '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { items, domains, overlay, sheet, title } = load(), args = process.argv.slice(2);
    const errors = problems(items, overlay, sheet);
    if (args.includes('--dump')) { for (const i of items) console.log(`${i.id}\t${i.domain ? KINDS[i.kind] : i.heading}\t${i.parent ? '  – ' : ''}${i.original}`); process.exit(0); }
    if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
    const out = resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'backups/akciski-banka');
    mkdirSync(out, { recursive: true });
    const today = new Date().toLocaleDateString('mk-MK');
    writeFileSync(resolve(out, '00-Opsti-listi.doc'), generalDocument(items, overlay, today, title));
    domains.forEach((d, n) => writeFileSync(resolve(out, `${String(n + 1).padStart(2, '0')}-${d.code}.doc`), domainDocument(d, items, overlay, sheet, today)));
    const bank = items.filter((i) => i.domain || GENERAL.includes(i.section));
    const count = (status: Status) => bank.filter((i) => ((overlay.stavki[i.id] || {}).status || 'pregled') === status).length;
    console.log(`Издание ${overlay.izdanie}: ${items.filter((i) => i.domain).length} ставки во ${domains.length} подрачја, ${items.filter((i) => !i.domain && GENERAL.includes(i.section)).length} во општите листи.`);
    console.log(`За преглед ${count('pregled')} · одобрено ${count('odobreno')} · за доработка ${count('dorabotka')}`);
    console.log(`Документи: ${out}`);
}
