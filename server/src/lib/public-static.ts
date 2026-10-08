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
    'Kolega.html',
    'BookmarksPlus.html',
    'ComuniBoard.html',
    'Dnevnik-Rasporedi-SafeSync.html',
    'MTB-Workspace.html',
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
    'Sinhronizacija.html',
    'TabelaSoDokazi_.html',
    // WBACC Studio, built from wbacc/ into this one file; wbacc/ itself stays private.
    'WBACC.html',
    'index.html',
    'start.html',
    'РаспоредТерапевти.html',
    'app-navigation.js',
    // Pin and fold for every strip, table head and section; app-navigation.js loads it.
    'mtb-layout.js',
    'mtb-theme.js',
    'mtb-document.js',
    'mtb-look.css',
    'mtb-schedule-form.js',
    'mtb-class-form.js',
    'mtb-forms.js',
    // One teacher's week, read or edited in the cell: Настава and Податоци.
    'mtb-teacher-week.js',
    // A PDF made by the page itself, the same whatever printer is installed.
    'mtb-pdf.js',
    'workspace-admin.js',
    'workspace-admin.css',
    'mtb-runtime.js',
    'home-button.js',
    'logo.png',
    // Вежби за изговор (docs/VEZBI.md): one page, its three tile pictures and
    // one data file per sound. No database and no sign-in of its own; it frames
    // ComuniBoard.html and WBACC.html from the list above. A folder is still
    // never published as a folder: each file in it is named here.
    'vezbi/index.html',
    'vezbi/vezbi.jpg',
    'vezbi/tabla.jpg',
    'vezbi/crtanje.jpg',
    ...['b', 'c', 'ch', 'd', 'dz', 'dzh', 'f', 'g', 'gj', 'h', 'j', 'k', 'kj', 'l', 'lj', 'm', 'n',
        'nj', 'p', 'r', 's', 'sh', 't', 'v', 'z', 'zh'].map((sound) => `vezbi/glasovi/${sound}.js`)
]);

// The one folder address that answers: it resolves to its own index.html.
const PUBLIC_FOLDERS = new Set(['vezbi/']);

export function isPublicStaticPath(pathName: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(String(pathName || ''));
    } catch {
        return false;
    }
    if (decoded === '/' || decoded === '') return true; // root resolves to index.html
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return false;
    const relative = decoded.slice(1);
    // No dot segments, empty segments, alternate separators, or case-folding.
    // Windows would resolve those permissively; the HTTP boundary must not.
    // A path below the root passes only as one of the exact names listed.
    if (!relative || relative.split('/').some((part, i, all) =>
        part === '.' || part === '..' || (part === '' && i < all.length - 1))) return false;
    return PUBLIC_FILES.has(relative) || PUBLIC_FOLDERS.has(relative);
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
