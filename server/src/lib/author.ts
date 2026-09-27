import { z } from 'zod';
import { pool } from '../db.js';

/**
 * „изработил …" — the author's credit, the watermark on every screen
 * (owner, 25 and 27 Sep 2026).
 *
 * The NAME is each installation's (`MTB_AUTHOR` in server/.env, and in
 * Render's dashboard), never the code's: this repository is public and
 * `check:names` refuses every real name in it, the author's own included —
 * which is the guard working, not in the way.
 *
 * One copy, because two routes hand it out: `/api/health` for the screens
 * that share app-navigation.js, and `/api/portal/me` for Kolega.html, whose
 * colleagues in the cloud cannot ask /api/health at all. Read on every call,
 * so a changed .env needs only the restart it already needs.
 */
export function authorName(): string {
    return String(process.env.MTB_AUTHOR || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ── how it looks (046) ──────────────────────────────────────────────────────
/**
 * The watermark's look, set by the administrator once for everybody (owner,
 * 27 Sep 2026) in Податоци → „🎨 Изглед". Per theme: the colour of the letters,
 * how opaque the letters are and how opaque the halo around them is, in
 * percent; and one size. The halo's own colour follows the theme (white on
 * light, near-black on dark) — it is there to keep the letters legible over a
 * table or a gradient, and a halo in any other colour stops doing that.
 *
 * The defaults are exactly the look the screens had before this setting
 * existed, so a database without the row — or before 046 — looks the same.
 */
const Side = z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    text: z.number().int().min(10).max(100),
    halo: z.number().int().min(0).max(100)
}).strict();
const Look = z.object({ size: z.number().int().min(9).max(16), light: Side, dark: Side }).strict();
export type CreditLook = z.infer<typeof Look>;

export const DEFAULT_LOOK: CreditLook = {
    size: 11,
    light: { color: '#4f5bd5', text: 50, halo: 68 },
    dark: { color: '#a5b4fc', text: 48, halo: 68 }
};

/** A look the server will store and hand out, or null for anything else. */
export function normalizeLook(input: unknown): CreditLook | null {
    const parsed = Look.safeParse(input);
    if (!parsed.success) return null;
    const side = (s: CreditLook['light']) => ({ color: s.color.toLowerCase(), text: s.text, halo: s.halo });
    return { size: parsed.data.size, light: side(parsed.data.light), dark: side(parsed.data.dark) };
}

const HALO = { light: [255, 255, 255], dark: [10, 12, 30] } as const;
const rgba = (rgb: readonly number[], percent: number) => `rgba(${rgb.join(', ')}, ${percent / 100})`;
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * The same look as the values a screen sets on the watermark (CSS custom
 * properties), so no screen converts colours for itself.
 */
export function lookCss(look: CreditLook) {
    return {
        size: `${look.size}px`,
        lightText: rgba(rgbOf(look.light.color), look.light.text),
        lightHalo: rgba(HALO.light, look.light.halo),
        darkText: rgba(rgbOf(look.dark.color), look.dark.text),
        darkHalo: rgba(HALO.dark, look.dark.halo)
    };
}

// /api/health answers every open page every few seconds; the look changes
// rarely and only through this module, so a minute's memory is plenty. Another
// process (the read-only mirror server) sees a change within that minute.
let remembered: { look: CreditLook; at: number } | null = null;

export async function creditLook(): Promise<CreditLook> {
    if (remembered && Date.now() - remembered.at < 60_000) return remembered.look;
    let look = DEFAULT_LOOK;
    try {
        const { rows } = await pool.query('SELECT look FROM credit_look WHERE id');
        look = normalizeLook(rows[0]?.look) ?? DEFAULT_LOOK;
    } catch {
        // Before 046 there is no table: the screens keep the look they had.
    }
    remembered = { look, at: Date.now() };
    return look;
}

export async function saveCreditLook(look: CreditLook, by: string): Promise<void> {
    await pool.query(
        `INSERT INTO credit_look (id, look, updated_at, updated_by) VALUES (true, $1, now(), $2)
         ON CONFLICT (id) DO UPDATE SET look = EXCLUDED.look, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [JSON.stringify(look), by]);
    remembered = { look, at: Date.now() };
}
