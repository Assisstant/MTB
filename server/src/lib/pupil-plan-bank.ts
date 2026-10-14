/** The reviewed repository content is the only owner of suggestions. No pupil
 * data or catalogue writes belong here; inserting a suggestion copies text. */
import { load, problems, approved, CHECK, type Item } from '../../scripts/akciski-banka.js';

export type Use = 'area' | 'goal' | 'activity' | 'criterion' | 'baseline' | 'adaptation' | 'communication' | 'outcome' | 'decision';

function useOf(item: Item): Use | null {
    if (item.domain) return ({ P: 'area', C: 'goal', A: 'activity', I: 'criterion', S: 'baseline', R: 'adaptation', N: null } as const)[item.kind];
    if (item.kind === 'N') return null;
    if (item.section === 6) return 'adaptation';
    if (item.section === 7) return 'communication';
    if (item.section === 3 && item.heading === 'Критериум за успех') return 'criterion';
    if (item.section === 11 && item.heading === 'Исход') return 'outcome';
    if (item.section === 11 && item.heading === 'Одлука') return 'decision';
    return null;
}

export function buildPlanBank(source: ReturnType<typeof load>) {
    const { items, domains, overlay, sheet } = source;
    const errors = problems(items, overlay, sheet);
    if (errors.length) throw new Error('Invalid action-plan bank: ' + errors.join('\n'));
    const additions: Item[] = overlay.dodadeni.map((item) => ({ ...item, original: item.text, section: 0, heading: '' }));
    const order = (item: Item) => item.domain ? domains.findIndex((d) => d.code === item.domain) : domains.length;
    const suggestions = [...items, ...additions].sort((a, b) => order(a) - order(b)).flatMap((item) => {
        const use = useOf(item), text = approved(item, overlay);
        if (!use || !text) return [];
        const note = overlay.stavki[item.id];
        // Review approves the goal together with its check, as printed in the
        // review document. A corrected check can be supplied beside the wording.
        const check = use === 'goal' ? (note?.proverka || CHECK) : '';
        return [{ id: item.id, domain: item.domain, use, text: text + (check ? '\n' + check : ''), heading: item.heading }];
    });
    return { edition: overlay.izdanie, domains: domains.map(({ code, title }) => ({ code, title })), items: suggestions };
}

export const readPlanBank = () => buildPlanBank(load());
