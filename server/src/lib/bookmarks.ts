import { z } from 'zod';
import { pool } from '../db.js';

/**
 * The administrator's bookmarks (047): boards → columns → cards, the shape
 * BookmarksPlus exports, so its export is also a valid import. One document
 * with a revision — see the migration for why not rows.
 *
 * Checked strictly and bounded, because a browser sends it whole: an id is a
 * short token, a link is http(s), and nothing beyond these keys is kept.
 */
const Id = z.string().min(1).max(64).regex(/^[\w-]+$/);
const Text = (max: number) => z.string().max(max);
const Url = z.string().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'a link is http(s)');

const Board = z.object({ id: Id, name: Text(120), order: z.number().finite() });
const Column = z.object({ id: Id, name: Text(120), order: z.number().finite() });
const Card = z.object({
    id: Id,
    boardId: Id,
    columnId: Id,
    url: Url,
    title: Text(300),
    tags: z.array(Text(60)).max(30),
    notes: Text(5000),
    pinned: z.boolean(),
    order: z.number().finite(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
});
const Doc = z.object({
    boards: z.array(Board).max(100),
    columnsByBoard: z.record(Id, z.array(Column).max(100)),
    cards: z.array(Card).max(5000)
});
export type BookmarkDoc = z.infer<typeof Doc>;

/** Only the known keys of a well-formed document, or null. */
export function normalizeBookmarks(input: unknown): BookmarkDoc | null {
    const parsed = Doc.safeParse(input);
    if (!parsed.success) return null;
    const doc = parsed.data;
    const boards = new Set(doc.boards.map((b) => b.id));
    // A column list for a board that does not exist, or a card in a column
    // that does not exist, is a document that disagrees with itself.
    if (Object.keys(doc.columnsByBoard).some((b) => !boards.has(b))) return null;
    const columns = new Set(Object.values(doc.columnsByBoard).flat().map((c) => c.id));
    if (doc.cards.some((c) => !boards.has(c.boardId) || !columns.has(c.columnId))) return null;
    return doc;
}

export const isEmpty = (doc: BookmarkDoc) => doc.cards.length === 0;

export async function readBookmarks(): Promise<{ doc: BookmarkDoc | null; revision: number; updatedAt: string | null }> {
    const { rows } = await pool.query('SELECT doc, revision, updated_at FROM bookmark_state WHERE id');
    if (!rows[0]) return { doc: null, revision: 0, updatedAt: null };
    return { doc: normalizeBookmarks(rows[0].doc), revision: rows[0].revision, updatedAt: rows[0].updated_at };
}

export type SaveOutcome =
    | { ok: true; revision: number }
    | { ok: false; status: 409; reason: 'stale' | 'empty'; revision: number };

/**
 * Save only over the revision the browser started from. The row is locked for
 * the check, so two computers saving at once cannot both pass it.
 */
export async function saveBookmarks(doc: BookmarkDoc, expected: number, by: string): Promise<SaveOutcome> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT doc, revision FROM bookmark_state WHERE id FOR UPDATE');
        const current = rows[0] ? rows[0].revision as number : 0;
        if (current !== expected) {
            await client.query('ROLLBACK');
            return { ok: false, status: 409, reason: 'stale', revision: current };
        }
        // Rule 3: a browser that has not pulled holds nothing — saving that
        // would erase every bookmark. Empty never overwrites full.
        const stored = rows[0] ? normalizeBookmarks(rows[0].doc) : null;
        if (isEmpty(doc) && stored && !isEmpty(stored)) {
            await client.query('ROLLBACK');
            return { ok: false, status: 409, reason: 'empty', revision: current };
        }
        const revision = current + 1;
        await client.query(
            `INSERT INTO bookmark_state (id, doc, revision, updated_at, updated_by) VALUES (true, $1, $2, now(), $3)
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
