/**
 * One child held as two roster rows: hand the diary number, and everything the
 * diary owns, to the row that is on this year's list (lib/merge-diary-pupils.ts
 * says exactly what moves and what does not).
 *
 *   npm run diary:merge -- --pair 53:1464 --pair 9:1433                 dry run
 *   npm run diary:merge -- --pair 53:1464 --mark 2026-09-22:1788281068983:tuesday-2
 *   npm run diary:merge -- --pair 53:1464 --apply
 *
 *   --pair <old row id>:<current row id>   which two `students` rows are one child.
 *                                          Row ids, never names: that they are the
 *                                          same child is the owner's decision, made
 *                                          before this is run, and is not checked here.
 *   --bridged                              also every pair the DIARY points at: an active
 *                                          pupil whose bridge names one row while its
 *                                          diary number sits on another. No name is compared.
 *   --mark <date>:<diary id>:<slot key>    a mark the table has and the diary lost:
 *                                          the table's status is put back in the diary.
 *
 * Dry run by default, and the dry run does the whole thing inside a transaction
 * and rolls it back -- so what it prints is what --apply would do, not a guess.
 * --apply first writes the previous document and every row it touches to
 * backups/ (ignored by Git; it holds real people), and commits only if
 * afterwards the diary's document and the tables agree: every pupil linked,
 * every term the same, no mark of a linked pupil that the table lacks, and no
 * pupil left pointing at two rows.
 *
 * Reads DATABASE_URL like every script here. For the cloud, pass its address
 * for this one command; nothing in this file knows where the cloud is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { isRefusal, mergeDiaryPupils, type DiaryAgreement, type MergePlan } from '../src/lib/merge-diary-pupils.js';

const argv = process.argv.slice(2);
const all = (name: string) => argv.flatMap((a, i) =>
    a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : a.startsWith(`--${name}=`) ? [a.slice(name.length + 3)] : []);
const apply = argv.includes('--apply');
const usage = (why: string): never => {
    console.error(`${why}\nUsage: npm run diary:merge -- --pair <old row>:<current row> [--pair …] [--bridged] [--mark <date>:<diary id>:<slot key>] [--apply]`);
    process.exit(1);
};

const plan: MergePlan = {
    pairs: all('pair').map((p) => {
        const m = /^(\d+):(\d+)$/.exec(p) ?? usage(`"${p}" is not <old row>:<current row>`);
        return { oldRow: Number(m[1]), newRow: Number(m[2]) };
    }),
    marks: all('mark').map((p) => {
        const m = /^(\d{4}-\d{2}-\d{2}):(\d+):([a-z]+-\d+)$/.exec(p) ?? usage(`"${p}" is not <date>:<diary id>:<slot key>`);
        return { date: m[1], sdnevnikId: m[2], slotKey: m[3] };
    }),
    bridged: argv.includes('--bridged'),
    updatedBy: 'merge-diary-pupils'
};
if (!plan.pairs.length && !plan.marks.length && !plan.bridged) usage('Nothing to do.');

const show = (label: string, a: DiaryAgreement) => {
    console.log(`  ${label}: ${a.linked}/${a.pupils} pupils linked · ${a.terms - a.termsDifferent.length}/${a.terms} terms the same` +
        ` · marks: ${a.marksAgree} agree, ${a.marksOnlyInDocument.length} only in the diary, ${a.marksDifferent.length} differ, ${a.marksOnlyInTable.length} only in the table` +
        (a.marksOfUnknownPupils ? ` · ${a.marksOfUnknownPupils} under numbers no roster row carries (not counted)` : ''));
};
// A pupil whose bridge and number still name two rows is the thing this run exists to end.
const twoRows = (problems: string[]) => problems.filter((p) => /a human has to say which is which/.test(p)).length;
const agrees = (a: DiaryAgreement, problems: string[]) =>
    a.linked === a.pupils && !a.termsDifferent.length && !a.marksOnlyInDocument.length && !a.marksDifferent.length && !twoRows(problems);

const client = await pool.connect();
let code = 0;
try {
    const where = (await client.query('SELECT current_database() AS db, inet_server_addr()::text AS host')).rows[0];
    console.log(`database ${where.db} @ ${where.host ?? 'local socket'}${apply ? '' : '  (dry run — nothing is kept)'}\n`);
    await client.query('BEGIN');
    const result = await mergeDiaryPupils(client, plan);
    result.lines.forEach((l) => console.log('  ' + l));
    console.log('');
    show('before', result.before);
    show('after ', result.after);
    console.log(`  the document becomes version ${result.version}; the projection left ${result.projection.notes.length} note(s)`);
    result.projection.problems.forEach((p) => console.log('  problem: ' + p));
    if (result.after.termsDifferent.length) console.log('  terms still different: ' + result.after.termsDifferent.join(', '));
    result.after.marksOnlyInDocument.concat(result.after.marksDifferent).slice(0, 20).forEach((k) => console.log('  mark still not agreed: ' + k));
    result.after.marksOnlyInTable.slice(0, 20).forEach((k) => console.log('  only in the table (the diary cleared it, or never had it): ' + k));

    if (!apply) {
        await client.query('ROLLBACK');
        console.log(`\nDry run. ${agrees(result.after, result.projection.problems) ? 'With --apply this would be committed.' : 'With --apply this would be REFUSED: the document and the tables would still disagree.'}`);
    } else if (!agrees(result.after, result.projection.problems)) {
        await client.query('ROLLBACK');
        console.error('\nRefused, nothing changed: after the merge the document and the tables would still disagree.');
        code = 2;
    } else {
        const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backups');
        mkdirSync(dir, { recursive: true });
        const file = resolve(dir, `diary-before-merge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(file, JSON.stringify(result.backup, null, 1));
        await client.query('COMMIT');
        console.log(`\nApplied. The previous document and the rows it touched are in ${file}`);
    }
} catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isRefusal(err)) { console.error(`Refused, nothing changed: ${err.message}`); code = 2; }
    else { console.error(err); code = 1; }
} finally {
    client.release();
    await pool.end();
}
process.exit(code);
