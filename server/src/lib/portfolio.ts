import { z } from 'zod';
import { pool } from '../db.js';

/**
 * The owner's evidence for the title of mentor (059): each piece of evidence
 * exists ONCE, and a link ties it to an indicator of the standards and carries
 * the explanation for that indicator. The table, the folders and the coverage
 * are read from the links; nothing is typed twice. One document with a
 * revision — see the migration for why not rows.
 *
 * Checked strictly and bounded, because a browser sends it whole. The files
 * themselves stay in a folder on the owner's computer: a part names one by a
 * relative path, never an address on a disk.
 */
const Id = z.string().min(1).max(64).regex(/^[\w-]+$/);
const Text = (max: number) => z.string().max(max);
const Url = z.string().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'a link is http(s)');
// area.section.row of the standards, as the page's template numbers them.
const Indicator = z.string().regex(/^[1-9]\d?\.[1-9]\d?\.[1-9]\d?$/);
// Inside the chosen folder: no drive, no leading slash, no step upwards.
const RelativePath = z.string().max(500).refine((v) => v === ''
    || (!/^([a-z]:|[\\/])/i.test(v) && !v.includes('\\') && !v.includes('\0')
        && v.split('/').every((part) => part !== '' && part !== '.' && part !== '..')), 'a path inside the folder');

const Part = z.object({
    id: Id,
    kind: z.enum(['file', 'link']),
    path: RelativePath,
    url: Url,
    label: Text(300),
    note: Text(2000)
}).refine((p) => (p.kind === 'file' ? p.path !== '' && p.url === '' : p.url !== '' && p.path === ''),
    'a file has a path, a link has an address');

const Item = z.object({
    id: Id,
    no: z.number().int().min(1).max(9999),
    title: Text(500),
    summary: Text(20000),
    parts: z.array(Part).max(80),
    order: z.number().finite(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
});
const Link = z.object({
    id: Id,
    itemId: Id,
    indicator: Indicator,
    why: Text(20000),
    // Which of the evidence's parts are shown for this indicator; none named means all.
    parts: z.array(Id).max(80)
});
const Doc = z.object({
    title: Text(300),
    subtitle: Text(500),
    items: z.array(Item).max(400),
    links: z.array(Link).max(3000)
});
export type PortfolioDoc = z.infer<typeof Doc>;

/** Only the known keys of a well-formed document, or null. */
export function normalizePortfolio(input: unknown): PortfolioDoc | null {
    const parsed = Doc.safeParse(input);
    if (!parsed.success) return null;
    const doc = parsed.data;
    const parts = new Map<string, Set<string>>();
    for (const item of doc.items) {
        // Two items, or two parts of one item, under one id is a document that disagrees with itself.
        if (parts.has(item.id)) return null;
        const own = new Set(item.parts.map((p) => p.id));
        if (own.size !== item.parts.length) return null;
        parts.set(item.id, own);
    }
    const ids = new Set<string>(), pairs = new Set<string>();
    for (const link of doc.links) {
        const own = parts.get(link.itemId);
        // A link to evidence that does not exist, a part the evidence does not have,
        // or the same evidence twice under one indicator.
        if (!own || ids.has(link.id) || link.parts.some((p) => !own.has(p))) return null;
        const pair = link.itemId + '\n' + link.indicator;
        if (pairs.has(pair)) return null;
        ids.add(link.id);
        pairs.add(pair);
    }
    return doc;
}

export const isEmpty = (doc: PortfolioDoc) => doc.items.length === 0;

export async function readPortfolio(): Promise<{ doc: PortfolioDoc | null; revision: number; updatedAt: string | null }> {
    const { rows } = await pool.query('SELECT doc, revision, updated_at FROM portfolio_state WHERE id');
    if (!rows[0]) return { doc: null, revision: 0, updatedAt: null };
    return { doc: normalizePortfolio(rows[0].doc), revision: rows[0].revision, updatedAt: rows[0].updated_at };
}

export type SaveOutcome =
    | { ok: true; revision: number }
    | { ok: false; status: 409; reason: 'stale' | 'empty'; revision: number };

/**
 * Save only over the revision the browser started from. The row is locked for
 * the check, so two computers saving at once cannot both pass it.
 */
export async function savePortfolio(doc: PortfolioDoc, expected: number, by: string): Promise<SaveOutcome> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT doc, revision FROM portfolio_state WHERE id FOR UPDATE');
        const current = rows[0] ? rows[0].revision as number : 0;
        if (current !== expected) {
            await client.query('ROLLBACK');
            return { ok: false, status: 409, reason: 'stale', revision: current };
        }
        // Rule 3: a browser that has not pulled holds nothing — saving that
        // would erase every piece of evidence. Empty never overwrites full.
        const stored = rows[0] ? normalizePortfolio(rows[0].doc) : null;
        if (isEmpty(doc) && stored && !isEmpty(stored)) {
            await client.query('ROLLBACK');
            return { ok: false, status: 409, reason: 'empty', revision: current };
        }
        const revision = current + 1;
        await client.query(
            `INSERT INTO portfolio_state (id, doc, revision, updated_at, updated_by) VALUES (true, $1, $2, now(), $3)
             ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, revision = EXCLUDED.revision,
                                            updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [JSON.stringify(doc), revision, by]);
        await client.query('COMMIT');
        return { ok: true, revision };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
