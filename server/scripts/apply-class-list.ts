/**
 * A year's паралелки from the school's own table: for each row the homeroom
 * teacher, the name the паралелка is shown by, and the teacher's kind — and
 * how many паралелки the year has (lib/class-list.ts says how rows are matched).
 *
 *   npm run classes:apply -- --file ../backups/paralelki-2026-2027.json            dry run
 *   npm run classes:apply -- --file ../backups/paralelki-2026-2027.json --apply
 *   npm run classes:apply -- --file <list.json> --year 2026/2027 --apply
 *
 * The file:
 *   { "year": "2026/2027", "count": 17, "classes": [
 *       { "homeroom": "Име Презиме", "alias": "I-а – ученици со аутизам", "kind": "odd" },
 *       { "homeroom": "Име Презиме", "alias": "подготвителна", "label": "подготвителна" },
 *       { "homeroom": "Име Презиме", "alias": "Комбинирана паралелка", "label": "Комбинирана паралелка", "create": true } ] }
 * The order of the rows is the order of the list on every screen.
 *
 * THE FILE NAMES PEOPLE, so it is refused from anywhere inside the repository
 * that Git would commit: keep it in `backups/` or outside the repository.
 * Dry run by default; one row that cannot be matched and nothing is written.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { applyClassList, type ClassListPlan } from '../src/lib/class-list.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};
const file = flag('file');
const year = flag('year');
const apply = argv.includes('--apply');
if (!file) {
    console.error('Usage: npm run classes:apply -- --file <list.json> [--year 2026/2027] [--apply]');
    process.exit(1);
}

const path = resolve(file);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const inside = !relative(repo, path).startsWith('..');
if (inside) {
    let ignored = false;
    try { execFileSync('git', ['check-ignore', '-q', path], { cwd: repo }); ignored = true; } catch { /* not ignored */ }
    if (!ignored) {
        console.error(`Refused: ${relative(repo, path)} is inside the repository and Git would commit it.`);
        console.error('The list names people (rule 1). Keep it in backups/ or outside the repository.');
        process.exit(1);
    }
}

const plan = JSON.parse(readFileSync(path, 'utf8')) as ClassListPlan;
const client = await pool.connect();
try {
    const report = await applyClassList(client, plan, { apply, year });
    console.log(`${report.year}: ${report.lines.length} паралелки во листата${apply ? '' : ' (проба — ништо не е запишано)'}\n`);
    for (const line of report.lines) {
        const what = line.problem ? `✖ ${line.problem}` : (line.done.length ? line.done.join(', ') : 'без промена');
        console.log(`${String(line.position).padStart(2)}. ${line.alias}\n     ${line.homeroom} · ознака ${line.label ?? '—'} · ${what}`);
    }
    const { was, now, entered } = report.count;
    console.log(`\nБрој по Годишна програма: ${now ?? 'не е внесен'}${was !== now ? ` (беше ${was ?? 'не е внесен'})` : ''} · внесени: ${entered}`);
    if (report.unlisted.length) {
        console.log('\nНе се во листата (остануваат какви што се):');
        report.unlisted.forEach((u) => console.log(`   ${u.alias || u.label} · ${u.homeroom || 'без раководител'} · ${u.pupils} ученици`));
    }
    if (report.withoutClass) console.log(`\n⚠ ${report.withoutClass} интерни ученици без паралелка`);
    if (report.problems) {
        console.log(`\n${report.problems} ред(ови) не може да се поврзат — ништо не е запишано. Поправи ја листата или базата и пробај пак.`);
        process.exitCode = 2;
    } else if (report.applied) console.log('\nЗапишано.');
    else console.log('\nСè е во ред. Со --apply ќе се запише.');
} finally {
    client.release();
    await pool.end();
}
