/**
 * From the centre's cabinet workbook to `schedule_slots`: resolving, and then
 * writing through the endpoint that owns a block.
 *
 * The reading is `cabinet-sheet.ts` and is pure. This half needs the database,
 * because everything it decides is a question about the YEAR: which therapist
 * is that column, which child is that name, when does the third period ring.
 *
 * It is a library rather than the script's own body for one reason: the script
 * begins with `XLSX.read`, and that dependency cannot be installed everywhere
 * this is tested. Splitting at the GRID lets the resolution and the writing be
 * tested against a real database with a grid written by hand, which is the
 * half that can actually be wrong.
 */

import { parseCabinetGrid, clashingPupils } from './cabinet-sheet.js';
import { bareName } from './import-core.js';
import { nearestNames, clearlyNearest, type NameCandidate } from './name-match.js';

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export type CabinetBlock = {
    day: string; time: string;
    therapistId: number; therapist: string; cabinet: string;
    pupilIds: string[]; pupilNames: string[];
};

export type CabinetPlan = {
    year: { id: number; label: string };
    cabinets: number;
    cells: number;
    blocks: CabinetBlock[];
    /** A column nobody could be matched to — the whole column is skipped. */
    unresolvedCabinets: string[];
    /** Matched because the heading is the start of one category name. Say it out loud. */
    byPrefix: string[];
    unknownPupils: string[];
    /**
     * For a name nothing matched: the nearest spellings on the year's list.
     * Offered, never taken — see `name-match.ts`. The report prints them as a
     * line the caller can paste into the `--names` file, so the same reading
     * is done once rather than every time the sheet is imported.
     */
    suggestions: { pupil: string; sure: boolean; candidates: { name: string; publicId: string; distance: number }[] }[];
    ambiguousPupils: string[];
    dropped: string[];
    sheetProblems: string[];
    clashes: string[];
    /**
     * (therapist, pupil) pairs the sheet books together while this year's
     * caseload does not hold them. `PUT /api/schedule/block` refuses those —
     * correctly: the caseload is who a therapist works with, and a timetable
     * cell is not authority to decide it. Reported BEFORE the write so it is
     * not learnt as two hundred identical refusals, and added only when the
     * caller says `--caseload` in as many words.
     */
    missingCaseload: { therapist: string; therapistName: string; pupil: string; publicId: string }[];
};

export async function planCabinetImport(
    db: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
    grid: unknown[][],
    opts: { year?: string; map?: Record<string, string>; names?: Record<string, string> } = {}
): Promise<CabinetPlan> {
    const sheet = parseCabinetGrid(grid);
    const clashes = clashingPupils(sheet.cells);

    const years = (await db.query(
        opts.year ? 'SELECT id, label FROM school_years WHERE label = $1'
                  : 'SELECT id, label FROM school_years WHERE is_current',
        opts.year ? [opts.year] : []
    )).rows;
    if (!years.length) {
        throw new Error(opts.year ? `Нема учебна година „${opts.year}".` : 'Ниту една година не е тековна.');
    }
    const year = years[0] as { id: number; label: string };

    // The bells belong to the year (migration 020), so a block label is asked
    // of the database rather than assumed — 2025/2026 rings differently.
    const bells = (await db.query(
        `SELECT b.ordinal,
                to_char(coalesce(o.starts_at, b.starts_at), 'HH24:MI') AS starts_at,
                coalesce(o.minutes, b.minutes) AS minutes
           FROM bell_periods b
           LEFT JOIN bell_period_overrides o
             ON o.bell_period_id = b.id AND o.school_year_id = $1
          WHERE b.schedule = 'kabinet'
          ORDER BY b.ordinal`,
        [year.id]
    )).rows;
    const blockOf = new Map<number, string>();
    for (const b of bells) {
        const [h, m] = String(b.starts_at).split(':').map(Number);
        const end = h * 60 + m + Number(b.minutes);
        blockOf.set(Number(b.ordinal),
            `${b.starts_at}-${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`);
    }

    const stated = new Map<string, string>();
    for (const [column, therapist] of Object.entries(opts.map ?? {})) stated.set(norm(column), String(therapist));

    const therapists = (await db.query(
        `SELECT t.id, t.name, c.name AS category
           FROM therapists t
           JOIN therapist_years ty ON ty.therapist_id = t.id AND ty.school_year_id = $1 AND ty.active
           LEFT JOIN specialist_categories c ON c.id = ty.category_id
          ORDER BY t.name`,
        [year.id]
    )).rows;
    const byName = new Map<string, any>();
    for (const t of therapists) byName.set(norm(t.name), t);
    const byCategory = new Map<string, any[]>();
    for (const t of therapists) {
        if (!t.category) continue;
        const key = norm(t.category);
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(t);
    }

    const cabinetOf = new Map<string, any>();
    const unresolvedCabinets: string[] = [];
    const byPrefix: string[] = [];
    for (const cab of sheet.cabinets) {
        const said = stated.get(norm(cab.label));
        if (said) {
            const t = byName.get(norm(said));
            if (t) { cabinetOf.set(cab.label, t); continue; }
            unresolvedCabinets.push(`„${cab.label}" → „${said}" од мапата не е активен стручен работник оваа година.`);
            continue;
        }
        const holders = byCategory.get(norm(cab.label)) ?? [];
        if (holders.length === 1) { cabinetOf.set(cab.label, holders[0]); continue; }
        if (holders.length) {
            unresolvedCabinets.push(`„${cab.label}" — ${holders.length} лица ја држат таа категорија, не одлучувам сам.`);
            continue;
        }
        // „Сензорна" against „Сензорна интеграција": the sheet abbreviates what
        // the систематизација spells out. Taken only when the short form begins
        // EXACTLY ONE category held by EXACTLY ONE person, and reported — an
        // inference nobody is shown is a guess.
        const starts = [...byCategory.entries()].filter(([key]) => key.startsWith(norm(cab.label)));
        if (starts.length === 1 && starts[0][1].length === 1) {
            cabinetOf.set(cab.label, starts[0][1][0]);
            byPrefix.push(`„${cab.label}" → ${starts[0][1][0].name} (категорија „${starts[0][1][0].category}")`);
            continue;
        }
        unresolvedCabinets.push(`„${cab.label}" — ниту во мапата, ниту како стручна категорија оваа година.`);
    }

    const caseload = new Set<string>((await db.query(
        `SELECT ts.therapist_id || '|' || s.public_id AS pair
           FROM therapist_students ts JOIN students s ON s.id = ts.student_id
          WHERE ts.school_year_id = $1`,
        [year.id]
    )).rows.map((r: any) => r.pair));

    const pupils = (await db.query(
        `SELECT s.public_id, s.name
           FROM student_enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.school_year_id = $1 AND e.active AND s.active`,
        [year.id]
    )).rows;
    const exact = new Map<string, string[]>();
    const bare = new Map<string, string[]>();
    for (const p of pupils) {
        const e = norm(p.name), b = norm(bareName(p.name));
        if (!exact.has(e)) exact.set(e, []);
        exact.get(e)!.push(p.public_id);
        if (!bare.has(b)) bare.set(b, []);
        bare.get(b)!.push(p.public_id);
    }
    // A spelling a PERSON has already tied to a pupil, once, in a file they
    // keep. By public_id, or by the pupil's exact name in the database — the
    // id is what is stored either way, so the tie survives a later rename.
    const byPublicId = new Set<string>(pupils.map((p: any) => p.public_id));
    const said = new Map<string, string>();
    const badlyStated: string[] = [];
    for (const [spelling, target] of Object.entries(opts.names ?? {})) {
        const t = String(target).trim();
        if (byPublicId.has(t)) { said.set(norm(spelling), t); continue; }
        const hit = exact.get(norm(t));
        if (hit && hit.length === 1) { said.set(norm(spelling), hit[0]); continue; }
        badlyStated.push(hit && hit.length > 1
            ? `„${spelling}" → „${t}": тоа име го носат ${hit.length} деца — напиши public_id.`
            : `„${spelling}" → „${t}": ни public_id, ни име на годишниот список.`);
    }

    const unknown = new Set<string>();
    const ambiguous = new Set<string>();
    const resolvePupil = (name: string): string | null => {
        const stated = said.get(norm(name));
        if (stated) return stated;
        const hit = exact.get(norm(name)) ?? bare.get(norm(bareName(name)));
        if (!hit) { unknown.add(name); return null; }
        // The sheet writes a name, and a name is not an identity here: two
        // children really do share one (rule 2). Reported, never picked.
        if (hit.length > 1) { ambiguous.add(name); return null; }
        return hit[0];
    };

    const blocks: CabinetBlock[] = [];
    const dropped: string[] = [];
    for (const cell of sheet.cells) {
        const t = cabinetOf.get(cell.cabinet);
        if (!t) continue;                                   // the column is already reported
        const time = blockOf.get(cell.period);
        if (!time) { dropped.push(`${cell.day}, ${cell.period}. час — нема ѕвоно за тој час во ${year.label}.`); continue; }
        const ids = cell.pupils.map(resolvePupil);
        if (ids.some((x) => x === null)) { dropped.push(`${cell.day}, ${time}, ${cell.cabinet}: „${cell.raw}".`); continue; }
        blocks.push({
            day: cell.day, time, therapistId: t.id, therapist: t.name, cabinet: cell.cabinet,
            pupilIds: ids as string[], pupilNames: cell.pupils
        });
    }

    const missing = new Map<string, { therapist: string; therapistName: string; pupil: string; publicId: string }>();
    for (const b of blocks) {
        b.pupilIds.forEach((publicId, index) => {
            const key = `${b.therapistId}|${publicId}`;
            if (caseload.has(key) || missing.has(key)) return;
            missing.set(key, {
                therapist: b.therapist, therapistName: b.therapist,
                pupil: b.pupilNames[index], publicId
            });
        });
    }

    // Nothing here changes a single decision above: the plan is already fixed
    // by the time this runs. It exists so the person reading the report is
    // shown three names instead of eighty.
    const suggestions = [...unknown].map((pupil) => {
        const list: NameCandidate<any>[] = nearestNames(pupil, pupils, (p: any) => p.name);
        return {
            pupil,
            sure: clearlyNearest(list),
            candidates: list.map((c) => ({ name: c.row.name, publicId: c.row.public_id, distance: c.distance }))
        };
    }).filter((s) => s.candidates.length > 0);

    return {
        year, cabinets: sheet.cabinets.length, cells: sheet.cells.length, blocks,
        unresolvedCabinets, byPrefix, suggestions,
        unknownPupils: [...unknown], ambiguousPupils: [...ambiguous],
        dropped: dropped.concat(badlyStated), sheetProblems: sheet.problems, clashes,
        missingCaseload: [...missing.values()]
    };
}

/**
 * Writes through `PUT /api/schedule/block`, one call per cell of the sheet.
 *
 * Never with its own INSERT. That endpoint already owns a block of the cabinet
 * week — it refuses a therapist booked twice in one period, refuses a pupil in
 * two places at once, splits a block into its two halves itself and serialises
 * the therapist's day. A second writer with none of that is the failure this
 * project keeps paying for, so a refusal here is the server protecting the
 * week and is reported as such rather than retried.
 */
export async function applyCabinetPlan(
    plan: CabinetPlan,
    base: string,
    fetchImpl: typeof fetch = fetch
): Promise<{ written: number; refused: string[] }> {
    let written = 0;
    const refused: string[] = [];
    for (const b of plan.blocks) {
        const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/schedule/block`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                year: plan.year.label, day: b.day, time: b.time,
                therapistId: b.therapistId, studentPublicIds: b.pupilIds
            })
        });
        if (res.ok) { written++; continue; }
        const body: any = await res.json().catch(() => ({}));
        refused.push(`${b.day} ${b.time} ${b.cabinet} (${b.pupilNames.join(' / ')}): ${body.error || res.status}`);
    }
    return { written, refused };
}

/**
 * Put the missing (therapist, pupil) pairs on this year's caseload.
 *
 * Through `PUT /api/therapists/:name/students/:publicId`, which owns that fact
 * — it refuses a child archived in S-Dnevnik, and it is the same call the tick
 * box in Fusion makes. Never an INSERT of our own, and never without the
 * caller having asked: a timetable cell is evidence that somebody intends the
 * session, not a decision that the child is on that caseload.
 */
export async function linkCaseload(
    plan: CabinetPlan,
    base: string,
    fetchImpl: typeof fetch = fetch
): Promise<{ linked: number; refused: string[] }> {
    let linked = 0;
    const refused: string[] = [];
    for (const pair of plan.missingCaseload) {
        const url = `${base.replace(/\/+$/, '')}/api/therapists/${encodeURIComponent(pair.therapistName)}`
            + `/students/${encodeURIComponent(pair.publicId)}?year=${encodeURIComponent(plan.year.label)}`;
        const res = await fetchImpl(url, { method: 'PUT' });
        if (res.ok) { linked++; continue; }
        const body: any = await res.json().catch(() => ({}));
        refused.push(`${pair.therapistName} → ${pair.pupil}: ${body.error || res.status}`);
    }
    return { linked, refused };
}
