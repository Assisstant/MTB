/**
 * The school's other two documents, read against the database. Nothing else.
 *
 *   npm run check:lists -- --staff "список со вработени.docx"
 *   npm run check:lists -- --programme "Табела по одд МКФ и програма.docx"
 *
 * **This script writes nothing at all, and has no --apply.** It exists to
 * answer "how far apart are these?" before anybody decides what the database
 * should hold. The pupil list has its own script (`npm run import:roster`),
 * whose dry run is the same kind of report.
 *
 * WHAT THE TWO DOCUMENTS ARE
 *
 *   список со вработени   34 names and nothing else. No post, no subject — so
 *                         it can say who the school employs and not what they
 *                         do. наставник / специјален едукатор / помошен кадар
 *                         is typed in `Podatoci.html`, by a person who can see
 *                         the whole list while deciding.
 *
 *   Табела по одд МКФ     per PUPIL: попреченост, програма, class + teaching
 *                         plan, and the одделенски раководител by name. Two
 *                         sections, одделенска and предметна настава. It is
 *                         the only place the комбинирани паралелки are
 *                         written down („1-ва комб. 2 и 3"), and the only
 *                         place a homeroom teacher is stated per child.
 *
 * TWO THINGS IT WILL TELL YOU AND WILL NOT FIX
 *
 *   · The class labels are ARABIC here („4-а") and ROMAN in the pupil list
 *     („IV-а"). `romanClassLabel` pairs them for the report and
 *     `normalizeClassLabel` — the one copy every read path depends on — is
 *     deliberately left alone. Deciding what the database should hold is a
 *     change of its own, with its own tests.
 *   · Staff names are spelt differently across the documents and the
 *     database. Every mismatch is listed and none is merged: two people who
 *     look alike are exactly what rule 2 exists for.
 */

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import {
    docxTables, docxParagraphs, parseStaffList, parseProgrammeGrid, romanClassLabel
} from '../src/lib/roster-doc.js';
import { bareName, norm, personName } from '../src/lib/import-core.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};
const staffFile = flag('staff');
const programmeFile = flag('programme');
if (!staffFile && !programmeFile) {
    console.error('Usage: npm run check:lists -- [--staff <employees.docx>] [--programme <table.docx>]');
    process.exit(1);
}

const say = (s = '') => console.log(s);
const tally = <T>(items: T[], key: (t: T) => string) => {
    const out = new Map<string, number>();
    for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
    return out;
};

const { rows: teachers } = await pool.query('SELECT id, name, kind, subject FROM teachers');
const { rows: therapists } = await pool.query('SELECT id, name FROM therapists');
const { rows: students } = await pool.query('SELECT public_id, name FROM students');
const staffByName = new Map<string, { what: string; name: string }>();
for (const t of teachers) staffByName.set(norm(t.name), { what: 'наставник', name: t.name });
for (const t of therapists) staffByName.set(norm(t.name), { what: 'терапевт', name: t.name });
const studentsByName = new Map<string, string[]>();
for (const s of students) {
    const key = bareName(s.name);
    if (!studentsByName.has(key)) studentsByName.set(key, []);
    studentsByName.get(key)!.push(s.public_id);
}

if (staffFile) {
    const list = parseStaffList(docxParagraphs(readFileSync(staffFile)));
    say(`\n${staffFile}`);
    say(`  ${list.names.length} names`);
    for (const line of list.skipped) say(`  (not read as a person: ${line})`);

    const seen = new Set(list.names.map(norm));
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of list.names) {
        const hit = staffByName.get(norm(name));
        if (hit) found.push(`  ${hit.what.padEnd(10)} ${personName(name)}`);
        else missing.push(`  ${personName(name)}`);
    }
    say(`\n  ${found.length} are already in the database`);
    found.sort().forEach(say);
    say(`\n  ${missing.length} are on the list and NOT in the database`);
    say('     add them in Податоци, where the post is chosen at the same time');
    missing.sort().forEach(say);

    const extra = [...staffByName.entries()].filter(([key]) => !seen.has(key));
    say(`\n  ${extra.length} in the database and not on this list`);
    say('     the list is dated 08.2024 — somebody hired since is expected here');
    extra.map(([, v]) => `  ${v.what.padEnd(10)} ${v.name}`).sort().forEach(say);
}

if (programmeFile) {
    const tables = docxTables(readFileSync(programmeFile));
    if (!tables.length) throw new Error('no table in that document');
    const grid = tables.reduce((a, b) => (b.length > a.length ? b : a));
    const { rows, problems } = parseProgrammeGrid(grid);

    say(`\n${programmeFile}`);
    say(`  ${rows.length} pupils`);
    for (const [section, n] of tally(rows, (r) => r.section)) say(`    ${section}: ${n}`);
    problems.forEach((p) => say(`  ! ${p}`));

    say('\n  classes, as this document writes them');
    const combined: string[] = [];
    const other: string[] = [];
    for (const [label, n] of [...tally(rows, (r) => r.classLabel)].sort()) {
        const roman = romanClassLabel(label);
        if (roman) say(`    ${label.padEnd(20)} ${String(n).padStart(2)}  = ${roman}`);
        else if (/комб/i.test(label)) { combined.push(`    ${label.padEnd(20)} ${String(n).padStart(2)}`); }
        else other.push(`    ${label.padEnd(20)} ${String(n).padStart(2)}`);
    }
    if (combined.length) {
        say('\n  комбинирани паралелки — one group taught as one, which no single');
        say('  class label can say and which the lesson model does not hold yet');
        combined.forEach(say);
    }
    if (other.length) {
        say('\n  not a numbered class at all');
        other.forEach(say);
    }

    say('\n  teaching plan and programme');
    for (const [plan, n] of [...tally(rows, (r) => r.plan || '(none)')].sort()) say(`    план ${plan.padEnd(14)} ${n}`);
    for (const [prog, n] of [...tally(rows, (r) => r.programme || '(none)')].sort()) say(`    прог. ${prog.padEnd(14)} ${n}`);

    const homerooms = [...new Set(rows.map((r) => r.homeroom).filter(Boolean))];
    const knownHomeroom = homerooms.filter((h) => staffByName.has(norm(h)));
    say(`\n  ${homerooms.length} одделенски раководители named, ${knownHomeroom.length} of them in the database`);
    for (const h of homerooms.filter((x) => !staffByName.has(norm(x))).sort()) {
        say(`    not in the database: ${h}`);
    }

    let matched = 0; const unknown: string[] = []; const ambiguous: string[] = [];
    for (const row of rows) {
        const hits = studentsByName.get(bareName(row.name)) ?? [];
        if (hits.length === 1) matched++;
        else if (hits.length > 1) ambiguous.push(`    ${row.classLabel.padEnd(20)} ${row.name}  -> ${hits.join(', ')}`);
        else unknown.push(`    ${row.classLabel.padEnd(20)} ${row.name}`);
    }
    say(`\n  ${matched} of the pupils are in the database, ${unknown.length} are not, ${ambiguous.length} match more than one`);
    if (ambiguous.length) { say('  the same name means two children — never merged (rule 2)'); ambiguous.forEach(say); }
    if (unknown.length) {
        say('  not in the database — this table is older than the current roster,');
        say('  so most of these will have finished rather than be missing');
        unknown.forEach(say);
    }
}

say('\nNothing was written. This script has no --apply.');
await pool.end();
