import { exportToBlob, THEME } from '@excalidraw/excalidraw';

/**
 * „📷 Слика“ — the drawing as a PNG, in one click (owner, 5 Oct 2026: „да има
 * export слика на површината“). Excalidraw's own „Export image“ sits in the ☰
 * menu, behind a dialog; this is the button beside Pictograms and Bookmarks.
 *
 * What is selected, or else the whole drawing — the same rule as „🔊“. A
 * selected shape takes its own text with it, and an arrow its label.
 *
 * Twice the screen's size, with the background, in the theme on screen, so it
 * prints and projects sharply. An embedded web page cannot be drawn into a
 * picture by any browser (its content belongs to another page); Excalidraw
 * draws its frame, and the person is told so rather than surprised later.
 */
const MAX_SIDE = 8000;

export async function exportDrawingImage(api) {
    const all = api.getSceneElements().filter((e) => !e.isDeleted);
    if (!all.length) return { empty: true };

    const appState = api.getAppState();
    const selected = appState.selectedElementIds || {};
    let elements = all.filter((e) => selected[e.id]);
    const partial = elements.length > 0;
    if (partial) {
        const chosen = new Set(elements.map((e) => e.id));
        elements = all.filter((e) => chosen.has(e.id) || (e.containerId && chosen.has(e.containerId)));
    } else {
        elements = all;
    }

    const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        mimeType: 'image/png',
        exportPadding: 24,
        // Twice the size, but never past what a browser canvas can hold: a
        // large board at 2× would come back as an empty picture.
        getDimensions: (width, height) => {
            const scale = Math.min(2, MAX_SIDE / Math.max(width, height, 1));
            return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
        },
        appState: {
            ...appState,
            exportBackground: true,
            exportWithDarkMode: appState.theme === THEME.DARK
        }
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'WBACC-' + stamp(new Date()) + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    return { partial, count: elements.length, embeds: elements.some((e) => e.type === 'embeddable' || e.type === 'iframe') };
}

function stamp(d) {
    const two = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
}
