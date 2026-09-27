// The drawing is kept in THIS browser's IndexedDB, not localStorage: a board
// with pictures outgrows localStorage's ~5 MB, and ComuniBoard's board silently
// stopped saving exactly there. Nothing here goes to any server.
const DB = 'wbacc-studio';
const STORE = 'kv';

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function run(mode, work) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = work(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

export const load = (key) => run('readonly', (s) => s.get(key));
export const save = (key, value) => run('readwrite', (s) => s.put(value, key));
