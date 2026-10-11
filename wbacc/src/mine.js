// „Мои печати": cards the therapist made, kept in THIS browser beside the
// drawing (the same IndexedDB as store.js) and nowhere else. Each stamp is its
// own record, `stamp:<id>`, so two open pages never overwrite each other's
// list. ComuniBoard's „Креирај картичка" writes the same record with a few
// lines of its own (it is one hand-written file and loads no module): the
// shape below is the contract between the two, and `clean` is its only judge.
//
// Another computer, another address or the offline folder is another browser
// store. The way across is the file: „Извези" here, „Увези" there.
const DB = 'wbacc-studio';
const STORE = 'kv';
const PREFIX = 'stamp:';
export const FORMAT = 'mtb-stamps';
export const WIDTHS = [0, 2, 4, 8];             // 0 is „без рамка"
export const COLOURS = ['#a8d4ff', '#000000', '#2563eb', '#16a34a', '#dc2626', '#9333ea', '#f59e0b', '#ec4899'];
const MAX_IMAGE = 3 * 1024 * 1024;              // one picture, as text
const MAX_STAMPS = 500;
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const HEX = /^#[0-9a-f]{6}$/i;

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx(mode, work) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const out = work(t.objectStore(STORE));
            t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    } finally { db.close(); }
}

export const newId = () => 'mine-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * One stamp as this page accepts it, or null. Nothing from a file or from
 * another page is stored before it has been through here: a picture is PNG,
 * JPEG or WebP as data (never SVG, which can carry script), a colour is a hex
 * colour, a width is one of ours.
 */
export function clean(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const image = typeof raw.image === 'string' ? raw.image : '';
    if (!IMAGE.test(image) || image.length > MAX_IMAGE) return null;
    const id = typeof raw.id === 'string' && /^[a-z0-9-]{4,60}$/i.test(raw.id) ? raw.id : newId();
    const hex = (value, fallback) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback);
    const frame = raw.frame && typeof raw.frame === 'object' ? raw.frame : {};
    return {
        id, v: 1,
        text: String(raw.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        image,
        frame: { width: WIDTHS.includes(Number(frame.width)) ? Number(frame.width) : 0, color: hex(frame.color, COLOURS[0]) },
        textColor: hex(raw.textColor, '#1e1e1e'),
        labelOnTop: raw.labelOnTop === true,
        created: Number.isFinite(Number(raw.created)) ? Number(raw.created) : Date.now()
    };
}

/** Every stamp of this browser, the newest first. A damaged record is left out, not thrown. */
export async function listMine() {
    const rows = await tx('readonly', (s) => s.getAll(IDBKeyRange.bound(PREFIX, PREFIX + '￿')));
    return (rows || []).map(clean).filter(Boolean).sort((a, b) => b.created - a.created);
}

export async function saveMine(raw) {
    const stamp = clean(raw);
    if (!stamp) throw new Error('bad stamp');
    await tx('readwrite', (s) => s.put(stamp, PREFIX + stamp.id));
    return stamp;
}

export const removeMine = (id) => tx('readwrite', (s) => s.delete(PREFIX + id));

export function exportPack(stamps) {
    return JSON.stringify({ format: FORMAT, version: 1, exported: new Date().toISOString(), stamps }, null, 1);
}

const same = (a, b) => a.text === b.text && a.image === b.image && a.frame.width === b.frame.width
    && a.frame.color === b.frame.color && a.textColor === b.textColor && a.labelOnTop === b.labelOnTop;

/**
 * A file into the library. The whole file is judged before anything is
 * written, and what is written goes in ONE transaction: a broken or empty
 * file changes nothing. A stamp already here, unchanged, is skipped; a stamp
 * with a known id and different content comes in as a COPY — an import never
 * replaces what the therapist has.
 */
export async function importPack(text) {
    let pack;
    try { pack = JSON.parse(text); } catch { throw new Error('not-json'); }
    if (!pack || pack.format !== FORMAT || pack.version !== 1 || !Array.isArray(pack.stamps)) throw new Error('not-a-pack');
    if (!pack.stamps.length) throw new Error('empty');
    if (pack.stamps.length > MAX_STAMPS) throw new Error('too-many');
    const incoming = pack.stamps.map(clean);
    if (incoming.some((s) => !s)) throw new Error('bad-stamp');
    const have = new Map((await listMine()).map((s) => [s.id, s]));
    const write = [];
    let skipped = 0, copies = 0;
    for (const stamp of incoming) {
        const mine = have.get(stamp.id);
        if (mine && same(mine, stamp)) { skipped++; continue; }
        if (mine || write.some((w) => w.id === stamp.id)) { stamp.id = newId(); copies++; }
        write.push(stamp);
    }
    if (write.length) await tx('readwrite', (s) => { write.forEach((stamp) => s.put(stamp, PREFIX + stamp.id)); });
    return { added: write.length, skipped, copies };
}
