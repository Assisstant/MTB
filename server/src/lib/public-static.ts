import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Files the local/Tailscale HTTP server is allowed to publish.
 *
 * The server root is the repository root because the applications are kept as
 * single-file HTML documents there.  Without an allowlist, a wildcard static
 * route also publishes `server/.env`, `.git/`, migrations, scripts and ignored
 * local handoff files.  Keep this list explicit: adding a new public screen is
 * a deliberate server change, while adding a private file to the repository is
 * safe by default.
 */
const PUBLIC_FILES = new Set([
    'AkciskiPlan.html',
    'BookmarksPlus.html',
    'ComuniBoard.html',
    'Dnevnik-Rasporedi-SafeSync.html',
    'Nastava.html',
    'NastavaUredi.html',
    'Podatoci.html',
    'Pregled-Baza.html',
    'Rasporedi-Unified-Sync-v5.0.html',
    'Rasporedi.html',
    'RasporediFusion.html',
    'S-Dnevnik-Unified-Sync-v4.html',
    'S-Dnevnik.html',
    'ScanArtisAtelierSolak.html',
    'TabelaSoDokazi_.html',
    'index.html',
    'start.html',
    'РаспоредТерапевти.html',
    'app-navigation.js',
    'home-button.js',
    'logo.png'
]);

export function isPublicStaticPath(pathName: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(String(pathName || ''));
    } catch {
        return false;
    }
    decoded = decoded.replace(/\\/g, '/');
    if (decoded === '/' || decoded === '') return true; // root resolves to index.html
    if (!decoded.startsWith('/') || decoded.includes('\0')) return false;
    const relative = decoded.slice(1);
    // No directories, dot segments, alternate separators, or case-folding.
    // Windows would resolve those permissively; the HTTP boundary must not.
    if (!relative || relative.includes('/') || relative.includes('\\') ||
        relative === '.' || relative === '..') return false;
    return PUBLIC_FILES.has(relative);
}

export const publicStaticFiles = Object.freeze([...PUBLIC_FILES]);

export function installPublicStatic(server: FastifyInstance, root: string): void {
    server.register(fastifyStatic, {
        root,
        dotfiles: 'deny',
        serveDotFiles: false,
        allowedPath: isPublicStaticPath
    });
}
