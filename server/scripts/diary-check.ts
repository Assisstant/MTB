/**
 * Does the diary document still agree with the tables? Read only, numbers only.
 *
 *   npm run diary:check
 *   npm run diary:check -- --expect 1788281068996 --mark 2026-09-22:1788281068983:tuesday-2
 *
 * The question after `diary:merge` and a deploy: did a browser holding the
 * diary from before the merge save over it? It prints who last wrote the
 * document and when, the same agreement `diary:merge` checks (pupils linked,
 * terms, marks), any pupil the document holds under number 0 or twice, and —
 * with --expect / --mark — whether given diary numbers and marks are there.
 * No name is printed: the output is meant to be pasted.
 *
 * The whole run is one READ ONLY transaction. Reads DATABASE_URL like every
 * script here; for the cloud, pass its address for this one command.
 */
import { pool } from '../src/db.js';
import { diaryAgreement } from '../src/lib/merge-diary-pupils.js';

const argv = process.argv.slice(2);
const all = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const expect = all('expect');
const marks = all('mark').map((m) => {
    const p = /^(\d{4}-\d{2}-\d{2}):(\d+):([a-z]+-\d+)$/.exec(m);
    if (!p) { console.error(`"${m}" is not <date>:<diary id>:<slot key>`); process.exit(1); }
    return { date: p[1], sid: p[2], slot: p[3] };
});
const list = (v: any): any[] => (Array.isArray(v) ? v : []);
const statusOf = (r: any) => (typeof r === 'string' ? r : r?.status ?? '');

const client = await pool.connect();
let code = 0;
try {
    await client.query('BEGIN READ ONLY');
    const where = (await client.query('SELECT current_database() AS db, inet_server_addr()::text AS host')).rows[0];
    console.log(`database ${where.db} @ ${where.host ?? 'local socket'}  (read only)\n`);
    const state = (await client.query(
        `SELECT version, payload, updated_at, updated_by FROM app_state WHERE app = 'sdnevnik'`)).rows[0];
    if (!state) throw new Error('the database holds no diary document');
    const doc = state.payload;
    console.log(`  document version ${state.version}, last written ${new Date(state.updated_at).toISOString()} by ${state.updated_by ?? '(unknown)'}`);
    console.log(`  saved by the diary at ${doc?._meta?.savedAt ?? '(no time)'}${doc?._meta?.reason ? ` (${doc._meta.reason})` : ''}`);

    const pupils = list(doc.students);
    const ids = pupils.map((s) => String(s?.id ?? ''));
    const zero = ids.filter((id) => id === '0' || id === '').length;
    const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    const former = list(doc.archivedStudents).length + list(doc.formerCaseloadStudents).length;
    console.log(`  pupils in the diary: ${pupils.length} active, ${former} former · under number 0: ${zero} · numbers held twice: ${twice.length ? twice.join(', ') : 'none'}`);

    const a = await diaryAgreement(client, doc);
    console.log(`  agreement: ${a.linked}/${a.pupils} pupils linked · ${a.terms - a.termsDifferent.length}/${a.terms} terms the same` +
        ` · marks: ${a.marksAgree} agree, ${a.marksOnlyInDocument.length} only in the diary, ${a.marksDifferent.length} differ, ${a.marksOnlyInTable.length} only in the table`);
    if (a.termsDifferent.length) console.log('  terms different: ' + a.termsDifferent.join(', '));
    a.marksOnlyInDocument.concat(a.marksDifferent).slice(0, 20).forEach((k) => console.log('  mark not agreed: ' + k));
    a.marksOnlyInTable.slice(0, 20).forEach((k) => console.log('  only in the table: ' + k));

    for (const id of expect) {
        const active = ids.includes(id);
        const linked = (await client.query('SELECT 1 FROM students WHERE sdnevnik_id::text = $1', [id])).rowCount;
        console.log(`  number ${id}: ${active ? 'an active pupil in the diary' : 'NOT among the active pupils'} · ${linked ? 'linked to a roster row' : 'NOT linked to any roster row'}`);
        if (!active || !linked) code = 2;
    }
    for (const m of marks) {
        const inDoc = statusOf(doc.attendance?.[m.date]?.[m.sid]?.[m.slot]);
        const inTable = (await client.query(
            `SELECT a.status FROM attendance a JOIN students s ON s.id = a.student_id
              WHERE a.date = $1 AND s.sdnevnik_id::text = $2 AND a.slot_key = $3`, [m.date, m.sid, m.slot])).rows[0]?.status ?? '';
        console.log(`  mark ${m.date} ${m.sid} ${m.slot}: diary „${inDoc || '—'}", table „${inTable || '—'}"`);
        if (!inDoc || inDoc !== inTable) code = 2;
    }
    const agrees = a.linked === a.pupils && !a.termsDifferent.length && !a.marksOnlyInDocument.length && !a.marksDifferent.length && !zero && !twice.length;
    if (!agrees) code = 2;
    console.log(`\n${code === 0 ? 'The diary and the tables agree.' : 'NOT all agree — see the lines above.'}`);
    await client.query('ROLLBACK');
} catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    code = 1;
} finally {
    client.release();
    await pool.end();
}
process.exit(code);
