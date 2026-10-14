/**
 * Акциски план, phase 5 (owner, 14 Oct 2026): priorities SUGGESTED from the
 * pupil's евидентен лист. The owner chose that everybody in Kolega sees them,
 * as everybody sees the plan; so only the suggested items leave the server,
 * each with its own marks, never the whole sheet.
 *
 * What may be said, and no more (PLAN-akciski-banka.md, phase 5; source § 13):
 *  - LOW: the item's latest assessed level is 1 („недоволно ниво").
 *  - DECLINE: the same item, on the same `level` scale, in two periods of the
 *    same school year, assessed lower in the later one. Periods of another
 *    year are another set of columns and are never compared.
 *  - CHANGED: on a `mark` section (VII, VIII) √ and X are not levels, so a
 *    changed mark is a reason to look again, never a decline.
 * Empty is „not yet assessed" and `/` is „does not apply" (routes/evidence.ts):
 * neither is a mark, so both are passed over. Nothing here decides anything:
 * a suggestion is copied into a draft by a person, or ignored.
 */

export type Why = 'low' | 'decline' | 'changed';
export type Period = { id: number; ord: number; label: string; short: string };
export type EvidenceItem = {
    id: number; label: string; group: string | null;
    section: { code: string; title: string; scale: 'level' | 'mark' };
};
export type Suggestion = EvidenceItem & { why: Why[]; marks: { period: string; value: string }[] };

/** The marks of each item in period order: `values.get(itemId).get(periodId)`. */
export function prioritiesOf(items: EvidenceItem[], periods: Period[], values: Map<number, Map<number, string>>): Suggestion[] {
    const order = [...periods].sort((a, b) => a.ord - b.ord);
    return items.flatMap((item) => {
        const own = values.get(item.id);
        if (!own) return [];
        const marks = order.map((p) => ({ period: p.short || p.label, value: own.get(p.id) ?? '' })).filter((m) => m.value !== '' && m.value !== '/');
        if (!marks.length) return [];
        const why: Why[] = [];
        const [before, last] = [marks.at(-2), marks.at(-1)!];
        if (item.section.scale === 'level') {
            if (before && Number(last.value) < Number(before.value)) why.push('decline');
            if (last.value === '1') why.push('low');
        } else if (before && last.value !== before.value) why.push('changed');
        return why.length ? [{ ...item, why, marks }] : [];
    });
}
