/**
 * Take a school year's timetable out, and put the same one back.
 *
 *   npm run timetable:snapshot                       save this year's timetable
 *   npm run timetable:snapshot -- --year 2025/2026   save a named year
 *   npm run timetable:list                           what has been saved
 *   npm run timetable:restore                        dry run, newest snapshot
 *   npm run timetable:restore -- --apply             put it back
 *   npm run timetable:restore -- --file <path>       a particular one
 *
 * It exists so the DEMO timetable can be looked at on a machine that holds the
 * real one. `npm run demo:teaching -- --apply --replace` deletes the year's
 * lessons before writing its own, and „Испразни ја годината" cannot undo that:
 * emptying a year is not the same as putting yesterday's back.
 *
 * ONLY `lessons`, and only for ONE year. That is not a simplification — it is
 * measured: `demo-timetable.ts` writes nothing else, so a snapshot of anything
 * more would claim to protect what was never at risk, and a restore of it would
 * be free to undo an unrelated correction made in the meantime.
 *
 * Ids are not preserved, because nothing in this schema points at a lesson. The
 * script does not take that on trust — it asks `pg_constraint` on every restore
 * and refuses if something has started referencing `lessons` since this was
 * written. The day that happens, an id IS identity and content is no longer a
 * complete restore.
 *
 * The file goes to `backups/timetable/`, which is gitignored: it carries the
 * school's real teacher names (rules 1 and 6).
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pool } from '../src/db.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : undefined;
};

const action = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'save') as 'save' | 'list' | 'restore';
const apply = argv.includes('--apply');
const yearLabel = flag('year');

const DIR = fileURLToPath(new URL('../../backups/timetable/', import.meta.url));

type Row = {
    day: string; day_order: number; ordinal: number;
    class_id: number; class_label: string;
    teacher_id: number | null; teacher_name: string | null;
    subject: string | null;
};
type Snapshot = {
    kind: 'mtb-timetable-snapshot';
    version: 1;
    year: string;
    takenAt: string;
    count: number;
    lessons: Row[];
};

const slug = (s: string) => s.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function resolveYear(client: any, label?: string) {
    const { rows } = label
        ? await client.query('SELECT id, label FROM school_years WHERE label = $1', [label])
        : await client.query('SELECT id, label FROM school_years WHERE is_current');
    if (!rows.length) throw new Error(label ? `Нема учебна година „${label}".` : 'Ниту една година не е означена како тековна.');
    return rows[0] as { id: number; label: string };
}

async function readLessons(client: any, yearId: number): Promise<Row[]> {
    const { rows } = await client.query(
        `SELECT l.day, l.day_order, l.ordinal,
                l.class_id, c.label AS class_label,
                l.teacher_id, t.name AS teacher_name,
                l.subject
           FROM lessons l
           JOIN school_classes c ON c.id = l.class_id
           LEFT JOIN teachers   t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1
          ORDER BY l.day_order, l.ordinal, c.label, l.id`,
        [yearId]
    );
    return rows as Row[];
}

function describe(rows: Row[]) {
    const classes = new Set(rows.map((r) => r.class_label));
    const teachers = new Set(rows.filter((r) => r.teacher_id !== null).map((r) => r.teacher_id));
    const unstaffed = rows.filter((r) => r.teacher_id === null).length;
    return `${rows.length} часа · ${classes.size} паралелки · ${teachers.size} наставници` +
        (unstaffed ? ` · ${unstaffed} без наставник` : '');
}

/**
 * Nothing may point at a lesson, or a content restore is not a restore.
 *
 * Derived from the catalogue rather than from this file's own memory, exactly
 * as `roster-purge.ts` derives its blockers: a list written down here would
 * still say "nothing references lessons" the day after something does.
 */
async function assertNothingReferencesLessons(client: any) {
    const { rows } = await client.query(
        `SELECT conrelid::regclass::text AS referencing, conname
           FROM pg_constraint
          WHERE contype = 'f' AND confrelid = to_regclass('lessons')`
    );
    if (rows.length) {
        const who = rows.map((r: any) => `${r.referencing} (${r.conname})`).join(', ');
        throw new Error(
            `Нешто веќе се повикува на „lessons": ${who}.\n` +
            '  Тогаш id-то Е идентитет и враќање по содржина не е целосно враќање.\n' +
            '  Врати од целосен бекап (scripts\\backup-db.ps1) наместо од оваа снимка.'
        );
    }
}

function newestFor(year: string | undefined) {
    if (!existsSync(DIR)) return undefined;
    const files = readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .filter((f) => !year || f.startsWith(slug(year) + '-'))
        .sort();
    return files.length ? join(DIR, files[files.length - 1]) : undefined;
}

const client = await pool.connect();
try {
    if (action === 'list') {
        if (!existsSync(DIR) || !readdirSync(DIR).some((f) => f.endsWith('.json'))) {
            console.log(`\nНема ниту една снимка во ${DIR}\n`);
        } else {
            console.log(`\nСнимки во ${DIR}:\n`);
            for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
                try {
                    const s = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Snapshot;
                    console.log(`  ${f}\n      ${s.year} · ${s.count} часа · земена ${s.takenAt}`);
                } catch {
                    console.log(`  ${f}\n      (нечитлива)`);
                }
            }
            console.log('');
        }
    } else if (action === 'save') {
        const year = await resolveYear(client, yearLabel);
        const lessons = await readLessons(client, year.id);
        const snap: Snapshot = {
            kind: 'mtb-timetable-snapshot',
            version: 1,
            year: year.label,
            takenAt: new Date().toISOString(),
            count: lessons.length,
            lessons
        };
        mkdirSync(DIR, { recursive: true });
        const path = join(DIR, `${slug(year.label)}-${stamp()}.json`);
        writeFileSync(path, JSON.stringify(snap, null, 1), 'utf8');
        console.log(`\nСнимен распоредот на ${year.label}: ${describe(lessons)}`);
        console.log(`  ${path}`);
        if (!lessons.length) {
            console.log('\n  Годината е ПРАЗНА, и снимката го запишува тоа.');
            console.log('  Враќањето потоа значи „избриши сè што е внесено во меѓувреме".');
        }
        console.log('\n  Враќање:  npm run timetable:restore            (проба)');
        console.log('            npm run timetable:restore -- --apply\n');
    } else if (action === 'restore') {
        const path = flag('file') ?? newestFor(yearLabel);
        if (!path) throw new Error(`Нема снимка во ${DIR}. Прво: npm run timetable:snapshot`);
        if (!existsSync(path)) throw new Error(`Ја нема датотеката: ${path}`);

        const snap = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
        if (snap.kind !== 'mtb-timetable-snapshot') throw new Error('Ова не е снимка од распоред.');
        if (!Array.isArray(snap.lessons)) throw new Error('Снимката нема список часови.');
        // An empty snapshot is a legitimate fact — the year really was empty
        // before the demo. A TRUNCATED file looks exactly the same, and the
        // difference decides whether a restore is a restore or an erasure.
        if (snap.count !== snap.lessons.length) {
            throw new Error(`Снимката вели ${snap.count} часа, а носи ${snap.lessons.length}. Скратена датотека — не враќам ништо.`);
        }

        const year = await resolveYear(client, snap.year);
        const current = await readLessons(client, year.id);
        await assertNothingReferencesLessons(client);

        const missingClass = [...new Set(snap.lessons.map((l) => l.class_id))];
        const missingTeacher = [...new Set(snap.lessons.map((l) => l.teacher_id).filter((x): x is number => x !== null))];
        const { rows: haveC } = await client.query('SELECT id FROM school_classes WHERE id = ANY($1::int[])', [missingClass]);
        const { rows: haveT } = await client.query('SELECT id FROM teachers WHERE id = ANY($1::int[])', [missingTeacher]);
        const goneC = missingClass.filter((id) => !haveC.some((r: any) => r.id === id));
        const goneT = missingTeacher.filter((id) => !haveT.some((r: any) => r.id === id));
        if (goneC.length || goneT.length) {
            // Matched per column, never "is this id in the list": a class id and
            // a teacher id are both plain integers and 7 is a valid value of each.
            const classNames = [...new Set(snap.lessons.filter((r) => goneC.includes(r.class_id)).map((r) => r.class_label))];
            const teacherNames = [...new Set(snap.lessons.filter((r) => r.teacher_id !== null && goneT.includes(r.teacher_id)).map((r) => r.teacher_name ?? '—'))];
            throw new Error(
                'Снимката се повикува на редови што ги нема повеќе:\n' +
                (goneC.length ? `  паралелки: ${classNames.join(', ')}\n` : '') +
                (goneT.length ? `  наставници: ${teacherNames.join(', ')}\n` : '') +
                '  Делумно враќање би било полошо од ништо — не враќам.'
            );
        }

        console.log(`\nСнимка: ${path}`);
        console.log(`  земена ${snap.takenAt}`);
        console.log(`\n  ${year.label} СЕГА:    ${describe(current)}`);
        console.log(`  ${year.label} ПО ВРАЌАЊЕ: ${describe(snap.lessons)}`);

        if (!apply) {
            console.log('\n  Проба. Ништо не е запишано. Додади --apply за да се врати.\n');
        } else {
            await client.query('BEGIN');
            const gone = await client.query('DELETE FROM lessons WHERE school_year_id = $1', [year.id]);
            let written = 0;
            for (const l of snap.lessons) {
                const r = await client.query(
                    `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (school_year_id, day, ordinal, class_id, teacher_id) DO NOTHING`,
                    [year.id, l.day, l.day_order, l.ordinal, l.class_id, l.teacher_id, l.subject]
                );
                written += r.rowCount ?? 0;
            }
            // The snapshot came out of this same table, so every row must go
            // back in. One that does not means the snapshot and the schema
            // disagree, and half a timetable is the worst of the three outcomes.
            if (written !== snap.lessons.length) {
                await client.query('ROLLBACK');
                throw new Error(`Требаше да вратам ${snap.lessons.length}, а влегоа ${written}. Ништо не е променето.`);
            }
            await client.query('COMMIT');
            console.log(`\n  Избришани ${gone.rowCount}, вратени ${written}. ${year.label} е како во снимката.\n`);
        }
    } else {
        throw new Error(`Непозната наредба „${action}". Има: save, list, restore.`);
    }
} catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(1);
} finally {
    client.release();
    await pool.end();
}
