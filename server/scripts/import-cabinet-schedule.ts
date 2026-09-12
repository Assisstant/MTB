/**
 * Import the centre's own cabinet timetable — a column per кабинет, a pupil in
 * each cell — into `schedule_slots`.
 *
 *   npm run import:cabinets -- "C:\Users\...\Raspored kabineti.xlsx"
 *   npm run import:cabinets -- ../private/kabineti.xlsx --map ../private/kabineti-map.json
 *   npm run import:cabinets -- ../private/kabineti.xlsx --year 2026/2027 --apply
 *   npm run import:cabinets -- ../private/kabineti.xlsx --apply --caseload
 *
 * DRY RUN BY DEFAULT: it parses, resolves every column and every name against
 * the database, prints what it would write and what it could not make sense
 * of, and touches nothing. `--apply` then writes, through the running server.
 *
 * The workbook stays OUTSIDE this repository — it carries real pupil names and
 * the repository is public (rules 1 and 6). So does the mapping file.
 *
 * The reading is `lib/cabinet-sheet.ts` (pure), the deciding and the writing
 * are `lib/cabinet-import.ts` (tested against a real database). This file is
 * the workbook, the flags and the report.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { pool } from '../src/db.js';
import { planCabinetImport, applyCabinetPlan, linkCaseload } from '../src/lib/cabinet-import.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};
const apply = argv.includes('--apply');
const caseload = argv.includes('--caseload');
const mapArg = flag('map');
const yearArg = flag('year');
const sheetArg = flag('sheet');
const BASE = (process.env.API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const files = argv.filter((a) => !a.startsWith('--') && a !== mapArg && a !== yearArg && a !== sheetArg);

if (files.length !== 1) {
    console.error('Употреба: npm run import:cabinets -- <workbook.xlsx> [--sheet Име] [--year 2026/2027] [--map map.json] [--apply]');
    process.exit(1);
}

function gridOf(path: string): unknown[][] {
    const book = XLSX.read(readFileSync(resolve(path)), { type: 'buffer' });
    const name = sheetArg ?? book.SheetNames[0];
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error(`Работната книга нема лист „${name}". Има: ${book.SheetNames.join(', ')}`);
    // `defval` keeps an empty cell as a column instead of collapsing the row —
    // without it every cabinet after a blank one shifts one column left.
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][];
}

const list = (title: string, lines: string[], limit = 20) => {
    if (!lines.length) return;
    console.log(`\n  ${title} (${lines.length}):`);
    lines.slice(0, limit).forEach((l) => console.log(`      ${l}`));
    if (lines.length > limit) console.log(`      … и уште ${lines.length - limit}`);
};

try {
    const map = mapArg ? JSON.parse(readFileSync(resolve(mapArg), 'utf8')) : undefined;
    const plan = await planCabinetImport(pool, gridOf(files[0]), { year: yearArg, map });

    console.log(`\n════ РАСПОРЕД НА КАБИНЕТИ · ${plan.year.label} ════`);
    console.log(`  ${files[0]}`);
    console.log(`\n  прочитани: ${plan.cabinets} кабинети · ${plan.cells} пополнети ќелии`);
    console.log(`  за запишување: ${plan.blocks.length} блока`);

    list('· Кабинет поврзан по СКРАТЕНО име на категорија — провери', plan.byPrefix);
    list('✗ Кабинет без стручен работник — целата колона се прескокнува', plan.unresolvedCabinets);
    if (plan.unresolvedCabinets.length) {
        console.log('      Направи мапа: { "Логопед": "Име Презиме", … } и додади --map <патека>.');
    }
    list('✗ Имиња што ги нема на годишниот список', plan.unknownPupils);
    if (plan.unknownPupils.length) {
        console.log('      Додади ги во Податоци; оваа скрипта намерно не создава ученици.');
    }
    list('✗ Име што значи повеќе од едно дете — не погодувам (правило 2)', plan.ambiguousPupils);
    list('· Ќелии испуштени поради горното', plan.dropped);
    list('· Работната книга', plan.sheetProblems);
    list('· Исто дете во два кабинета истовремено — серверот ќе го одбие вториот', plan.clashes);
    if (plan.missingCaseload.length) {
        list('✗ Детето не е во каталогот на тој кабинет — блокот ќе биде одбиен',
            plan.missingCaseload.map((m) => `${m.therapistName} → ${m.pupil} (${m.publicId})`));
        console.log('      Или чекни ги во Fusion/Податоци, или додади --caseload за да ги запише сега.');
    }

    if (!apply) {
        console.log('\n  Проба. Ништо не е запишано. Додади --apply за да се запише.\n');
    } else {
        if (caseload && plan.missingCaseload.length) {
            const link = await linkCaseload(plan, BASE);
            console.log(`\n  Каталог: запишани ${link.linked} од ${plan.missingCaseload.length} врски.`);
            list('✗ Одбиени врски', link.refused);
        }
        console.log(`\n  Запишувам преку ${BASE} …`);
        const out = await applyCabinetPlan(plan, BASE);
        console.log(`  Запишани ${out.written} од ${plan.blocks.length}.`);
        list('✗ Одбиени од серверот — тоа се неговите заштити, не дефект', out.refused);
        console.log('');
    }
    const clean = !plan.unresolvedCabinets.length && !plan.unknownPupils.length && !plan.ambiguousPupils.length;
    process.exit(clean ? 0 : 1);
} catch (error) {
    console.error('\n' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(2);
} finally {
    await pool.end();
}
