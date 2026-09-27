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
