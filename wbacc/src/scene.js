import { convertToExcalidrawElements } from '@excalidraw/excalidraw';

// Putting things into the drawing, where the person is looking: the middle
// of the visible canvas, never somewhere off-screen.
function centre(api) {
    const { scrollX, scrollY, zoom, width, height } = api.getAppState();
    return { x: -scrollX + width / 2 / zoom.value, y: -scrollY + height / 2 / zoom.value };
}

function add(api, skeletons) {
    const elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
    api.updateScene({ elements: [...api.getSceneElements(), ...elements] });
    api.selectElements?.(elements);
    return elements;
}

export function readAsDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * A card, as in ComuniBoard: a pictogram with its word above or below, one
 * group, so it moves as one. The picture is stored IN the drawing (as
 * Excalidraw stores any image), so the card still shows without the Internet.
 */
export function insertCard(api, { dataURL, mimeType, label, labelOnTop, size = 200 }) {
    const fileId = 'picto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    api.addFiles([{ id: fileId, dataURL, mimeType, created: Date.now() }]);
    const { x, y } = centre(api);
    const group = 'card-' + fileId;
    const text = String(label || '').trim();
    const fontSize = Math.round(size / 7);
    const imageY = labelOnTop && text ? y - size / 2 + fontSize : y - size / 2;
    const skeletons = [{ type: 'image', fileId, status: 'saved', x: x - size / 2, y: imageY, width: size, height: size, groupIds: [group] }];
    if (text) {
        skeletons.push({
            type: 'text', text, fontSize, textAlign: 'center', groupIds: [group],
            x: x - size / 2, y: labelOnTop ? imageY - fontSize * 1.6 : imageY + size + fontSize * 0.4
        });
    }
    const elements = add(api, skeletons);
    // Centre the word under (or over) the picture now that its width is known.
    const word = elements.find((e) => e.type === 'text');
    if (word) {
        api.updateScene({ elements: api.getSceneElements().map((e) =>
            e.id === word.id ? { ...e, x: x - e.width / 2 } : e) });
    }
}

const YOUTUBE = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;

/** A bookmark in the drawing: a video plays in place, any other link is a clickable label. */
export function insertLink(api, { url, title }) {
    const { x, y } = centre(api);
    if (YOUTUBE.test(url)) {
        add(api, [{ type: 'embeddable', link: url, x: x - 280, y: y - 158, width: 560, height: 315 }]);
        return;
    }
    add(api, [{ type: 'text', text: '🔗 ' + (title || url), link: url, x: x - 120, y, fontSize: 24 }]);
}

/** The words to read aloud: what is selected, or else every word on the canvas. */
export function wordsToSpeak(api) {
    const selected = api.getAppState().selectedElementIds || {};
    const texts = api.getSceneElements().filter((e) => e.type === 'text' && !e.isDeleted);
    const chosen = texts.filter((e) => selected[e.id] || (e.groupIds || []).some((g) =>
        api.getSceneElements().some((o) => selected[o.id] && (o.groupIds || []).includes(g))));
    return (chosen.length ? chosen : texts).sort((a, b) => a.y - b.y || a.x - b.x).map((e) => e.text).join('. ');
}
