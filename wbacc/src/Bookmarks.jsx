import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api as call, people, signIn } from './api.js';
import { load, save } from './store.js';
import { insertLink } from './scene.js';

/**
 * The administrator's bookmarks (BookmarksPlus, now in the MTB database, 047).
 *
 * The browser keeps a copy — the panel works with no server — and says which
 * server revision that copy started from. A save names that revision; when
 * another computer saved in between, the server refuses and the PERSON
 * chooses: take the server's, or overwrite it with this one. Never a merge,
 * never a silent overwrite (CLAUDE.md, „Sync decides direction").
 */
const LOCAL_KEY = 'bookmarks-v1';
const PUSH_DELAY = 1500;
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function emptyDoc() {
    const board = rid();
    const now = Date.now();
    return { boards: [{ id: board, name: 'Мои обележувачи', order: now }], columnsByBoard: { [board]: [{ id: rid(), name: 'Општо', order: now }] }, cards: [] };
}

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const safeUrl = (v) => {
    let u = String(v || '').trim();
    if (u && !/^[a-z]+:/i.test(u)) u = 'https://' + u;
    return /^https?:\/\//i.test(u) ? u.slice(0, 2000) : '';
};

/** A BookmarksPlus export (or our own), reduced to what the server stores. */
export function fromExport(raw) {
    if (!raw || !Array.isArray(raw.boards) || !raw.boards.length) throw new Error('Ова не е извоз од BookmarksPlus.');
    const ids = new Map();
    const id = (old) => {
        const key = String(old);
        if (!ids.has(key)) ids.set(key, (key.replace(/[^\w-]/g, '-').slice(0, 64)) || rid());
        return ids.get(key);
    };
    const now = Date.now();
    const boards = raw.boards.slice(0, 100).map((b, i) => ({ id: id(b.id), name: clip(b.name, 120), order: Number(b.order) || now + i }));
    const known = new Set(boards.map((b) => b.id));
    const columnsByBoard = {};
    Object.entries(raw.columnsByBoard || {}).forEach(([board, cols]) => {
        if (!known.has(id(board))) return;
        columnsByBoard[id(board)] = (Array.isArray(cols) ? cols : []).slice(0, 100)
            .map((c, i) => ({ id: id(c.id), name: clip(c.name, 120), order: Number(c.order) || now + i }));
    });
    boards.forEach((b) => { if (!columnsByBoard[b.id] || !columnsByBoard[b.id].length) columnsByBoard[b.id] = [{ id: rid(), name: 'Општо', order: now }]; });
    const columns = new Map(Object.entries(columnsByBoard).flatMap(([b, cols]) => cols.map((c) => [c.id, b])));
    const cards = (Array.isArray(raw.cards) ? raw.cards : []).slice(0, 5000).flatMap((c, i) => {
        const board = id(c.boardId);
        let column = id(c.columnId);
        if (!known.has(board)) return [];
        if (columns.get(column) !== board) column = columnsByBoard[board][0].id;
        // A file kept in BookmarksPlus lives in that browser only: its name
        // travels as a note, the file itself does not.
        const file = c.kind === 'file' && c.fileName ? '📎 ' + c.fileName : '';
        return [{
            id: id(c.id), boardId: board, columnId: column, url: safeUrl(c.url), title: clip(c.title || c.fileName, 300),
            tags: (Array.isArray(c.tags) ? c.tags : []).slice(0, 30).map((t) => clip(t, 60)),
            notes: clip([c.notes, file].filter(Boolean).join('\n'), 5000), pinned: Boolean(c.pinned),
            order: Number(c.order) || now + i, createdAt: Number(c.createdAt) || now, updatedAt: Number(c.updatedAt) || now
        }];
    });
    return { boards, columnsByBoard, cards };
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const youtubeId = (u) => (String(u).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];

export default function Bookmarks({ api, onClose }) {
    const [local, setLocal] = useState(null);          // { doc, revision, dirty }
    const [sync, setSync] = useState({ state: 'loading', text: 'Вчитувам…' });
    const [conflict, setConflict] = useState(null);    // { doc, revision } from the server
    const [gate, setGate] = useState(null);            // people to sign in as, when asked
    const [boardId, setBoardId] = useState('');
    const [filter, setFilter] = useState('');
    const [editing, setEditing] = useState(null);      // a card being added or changed
    const timer = useRef(null);
    const latest = useRef(null);

    const keep = useCallback((next) => {
        latest.current = next;
        setLocal(next);
        save(LOCAL_KEY, next).catch(() => setSync({ state: 'warn', text: 'Копијата во прелистувачот не се зачува.' }));
    }, []);

    const needSignIn = useCallback(async (err) => {
        if (err.body && err.body.noAdmin) { setSync({ state: 'warn', text: err.message }); return; }
        let list = [];
        try { list = await people(); } catch { /* the form still says what is needed */ }
        setGate(list);
        setSync({ state: 'warn', text: 'Обележувачите на серверот ги гледа само администраторот — најави се.' });
    }, []);

    const push = useCallback(async (copy, expected) => {
        try {
            const saved = await call('PUT', '/api/bookmarks', { doc: copy.doc, expected });
            const next = { doc: copy.doc, revision: saved.revision, dirty: false };
            if (latest.current === copy) keep(next); else keep({ ...latest.current, revision: saved.revision });
            setConflict(null);
            setSync({ state: 'ok', text: '✓ На серверот · верзија ' + saved.revision });
        } catch (err) {
            if (err.status === 409 && err.body.reason === 'stale') {
                const server = await call('GET', '/api/bookmarks').catch(() => null);
                if (server) setConflict(server);
                setSync({ state: 'bad', text: '⚠ ' + err.message });
            } else if (err.status === 401 || err.status === 403) await needSignIn(err);
            else if (err.status === 0) setSync({ state: 'wait', text: '⏳ Зачувано во прелистувачот · чека сервер' });
            else setSync({ state: 'bad', text: err.message });
        }
    }, [keep, needSignIn]);

    // Open: the browser's copy at once, then the server decides the direction.
    const refresh = useCallback(async () => {
        const mine = latest.current || (await load(LOCAL_KEY).catch(() => null)) || { doc: emptyDoc(), revision: 0, dirty: false };
        if (!latest.current) keep(mine);
        let server;
        try { server = await call('GET', '/api/bookmarks'); }
        catch (err) {
            if (err.status === 401 || err.status === 403) return needSignIn(err);
            return setSync({ state: 'wait', text: err.status === 0 ? '⏳ Без сервер — работиш на копијата во прелистувачот' : err.message });
        }
        setGate(null);
        if (!mine.dirty) {
            if (server.doc) keep({ doc: server.doc, revision: server.revision, dirty: false });
            else if (mine.doc.cards.length) return push(mine, server.revision);   // first time: this browser's become the server's
            return setSync({ state: 'ok', text: server.revision ? '✓ На серверот · верзија ' + server.revision : '✓ Поврзано — уште нема обележувачи' });
        }
        if (mine.revision === server.revision) return push(mine, server.revision);
        setConflict(server);
        setSync({ state: 'bad', text: '⚠ И тука и на серверот има промени. Одлучи која верзија важи.' });
    }, [keep, needSignIn, push]);

    useEffect(() => { refresh(); }, [refresh]);

    const change = (mutate) => {
        const base = latest.current;
        const doc = structuredClone(base.doc);
        mutate(doc);
        const next = { doc, revision: base.revision, dirty: true };
        keep(next);
        setSync({ state: 'wait', text: '⏳ Се зачувува…' });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { if (!conflict) push(next, next.revision); }, PUSH_DELAY);
    };

    const doc = local && local.doc;
    const board = doc && (doc.boards.find((b) => b.id === boardId) || [...doc.boards].sort((a, b) => a.order - b.order)[0]);
    const columns = useMemo(() => (doc && board ? [...(doc.columnsByBoard[board.id] || [])].sort((a, b) => a.order - b.order) : []), [doc, board]);
    const shown = useMemo(() => {
        if (!doc || !board) return [];
        const q = filter.trim().toLocaleLowerCase('mk-MK');
        return doc.cards.filter((c) => c.boardId === board.id)
            .filter((c) => !q || [c.title, c.url, c.notes, ...c.tags].join(' ').toLocaleLowerCase('mk-MK').includes(q))
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    }, [doc, board, filter]);

    if (!doc) return <div className="wbacc-panel__body"><p className="wbacc-status">Вчитувам…</p></div>;

    const addBoard = () => {
        const name = prompt('Име на новата табла:');
        if (!name || !name.trim()) return;
        const id = rid();
        change((d) => { d.boards.push({ id, name: clip(name.trim(), 120), order: Date.now() }); d.columnsByBoard[id] = [{ id: rid(), name: 'Општо', order: Date.now() }]; });
        setBoardId(id);
    };
    const renameBoard = () => {
        const name = prompt('Ново име на таблата:', board.name);
        if (name && name.trim()) change((d) => { d.boards.find((b) => b.id === board.id).name = clip(name.trim(), 120); });
    };
    const deleteBoard = () => {
        if (doc.boards.length < 2) return alert('Ова е единствената табла.');
        if (doc.cards.some((c) => c.boardId === board.id)) return alert('Таблата има картички — прво премести ги или избриши ги.');
        if (!confirm('Да се избрише таблата „' + board.name + '“?')) return;
        change((d) => { d.boards = d.boards.filter((b) => b.id !== board.id); delete d.columnsByBoard[board.id]; });
        setBoardId('');
    };
    const addColumn = () => {
        const name = prompt('Име на новата колона:');
        if (name && name.trim()) change((d) => { d.columnsByBoard[board.id].push({ id: rid(), name: clip(name.trim(), 120), order: Date.now() }); });
    };
    const renameColumn = (col) => {
        const name = prompt('Ново име на колоната:', col.name);
        if (name && name.trim()) change((d) => { d.columnsByBoard[board.id].find((c) => c.id === col.id).name = clip(name.trim(), 120); });
    };
    const deleteColumn = (col) => {
        if (columns.length < 2) return alert('Таблата мора да има барем една колона.');
        if (doc.cards.some((c) => c.columnId === col.id)) return alert('Колоната има картички — прво премести ги или избриши ги.');
        change((d) => { d.columnsByBoard[board.id] = d.columnsByBoard[board.id].filter((c) => c.id !== col.id); });
    };
    const saveCard = (e) => {
        e.preventDefault();
        const url = safeUrl(editing.url);
        if (editing.url.trim() && !url) return alert('Линкот мора да почнува со http или https.');
        const now = Date.now();
        const fields = {
            url, title: clip(editing.title.trim() || host(url), 300), columnId: editing.columnId,
            tags: editing.tags.split(',').map((t) => clip(t.trim(), 60)).filter(Boolean).slice(0, 30),
            notes: clip(editing.notes, 5000), pinned: editing.pinned, updatedAt: now
        };
        change((d) => {
            const card = d.cards.find((c) => c.id === editing.id);
            if (card) Object.assign(card, fields);
            else d.cards.push({ id: rid(), boardId: board.id, order: now, createdAt: now, ...fields });
        });
        setEditing(null);
    };
    const deleteCard = (card) => {
        if (confirm('Да се избрише „' + (card.title || card.url) + '“?')) change((d) => { d.cards = d.cards.filter((c) => c.id !== card.id); });
    };
    const importFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const next = fromExport(JSON.parse(await file.text()));
            if (!confirm('Увоз: ' + next.boards.length + ' табли, ' + next.cards.length + ' картички.\nОвие ги ЗАМЕНУВААТ сегашните обележувачи. Продолжи?')) return;
            change((d) => { d.boards = next.boards; d.columnsByBoard = next.columnsByBoard; d.cards = next.cards; });
            setBoardId('');
        } catch (err) { alert(err.message || 'Датотеката не може да се прочита.'); }
    };
    const exportFile = () => {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'obelezuvaci-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const takeServer = () => { keep({ doc: conflict.doc || emptyDoc(), revision: conflict.revision, dirty: false }); setConflict(null); setSync({ state: 'ok', text: '✓ Земени од серверот · верзија ' + conflict.revision }); };
    const overwriteServer = () => { if (confirm('Верзијата на серверот ќе биде заменета со оваа. Продолжи?')) push(latest.current, conflict.revision); };

    const doSignIn = async (e) => {
        e.preventDefault();
        const form = e.target;
        const [kind, id] = form.who.value.split(':');
        try { await signIn(kind, id, form.pin.value.trim()); setGate(null); refresh(); }
        catch (err) { alert(err.message); }
    };

    return (
        <div className="wbacc-panel__body">
            <div className="wbacc-panel__head">
                <strong>🔖 Обележувачи</strong>
                <button type="button" className="wbacc-x" onClick={onClose} aria-label="Затвори">✕</button>
            </div>
            <p className={'wbacc-status ' + sync.state}>{sync.text}</p>
            {gate && (
                <form className="wbacc-gate" onSubmit={doSignIn}>
                    <select name="who" aria-label="Кој си">{gate.map((p) => <option key={p.kind + p.id} value={p.kind + ':' + p.id}>{p.name}</option>)}</select>
                    <input name="pin" type="password" inputMode="numeric" maxLength={4} placeholder="PIN" aria-label="PIN" />
                    <button type="submit">Најави се</button>
                </form>
            )}
            {conflict && (
                <div className="wbacc-conflict">
                    <button type="button" onClick={takeServer}>⬇ Земи ги од серверот</button>
                    <button type="button" onClick={overwriteServer}>⬆ Препиши го серверот</button>
                </div>
            )}
            <div className="wbacc-row">
                <select value={board.id} onChange={(e) => setBoardId(e.target.value)} aria-label="Табла">
                    {[...doc.boards].sort((a, b) => a.order - b.order).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button type="button" onClick={addBoard} title="Нова табла">➕</button>
                <button type="button" onClick={renameBoard} title="Преименувај">✏️</button>
                <button type="button" onClick={deleteBoard} title="Избриши празна табла">🗑</button>
            </div>
            <input type="search" className="wbacc-filter" placeholder="барај по наслов, линк, ознака…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="wbacc-cols">
                {columns.map((col) => {
                    const cards = shown.filter((c) => c.columnId === col.id);
                    return (
                        <section key={col.id} className="wbacc-col">
                            <header>
                                <span>{col.name} <small>{cards.length}</small></span>
                                <span>
                                    <button type="button" onClick={() => setEditing({ id: '', url: '', title: '', tags: '', notes: '', pinned: false, columnId: col.id })} title="Нова картичка">➕</button>
                                    <button type="button" onClick={() => renameColumn(col)} title="Преименувај">✏️</button>
                                    <button type="button" onClick={() => deleteColumn(col)} title="Избриши празна колона">🗑</button>
                                </span>
                            </header>
                            {cards.map((c) => (
                                <article key={c.id} className="wbacc-bm">
                                    {youtubeId(c.url) && <img className="wbacc-thumb" src={`https://img.youtube.com/vi/${youtubeId(c.url)}/mqdefault.jpg`} alt="" loading="lazy" />}
                                    <div className="wbacc-bm__text">
                                        {c.pinned && <span title="Закачено">📌 </span>}
                                        {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title || c.url}</a> : <b>{c.title}</b>}
                                        {c.url && <small className="wbacc-host">{host(c.url)}</small>}
                                        {c.tags.length > 0 && <small className="wbacc-tags">{c.tags.map((t) => '#' + t).join(' ')}</small>}
                                        {c.notes && <small className="wbacc-notes">{c.notes}</small>}
                                    </div>
                                    <div className="wbacc-bm__acts">
                                        {c.url && <button type="button" onClick={() => api && insertLink(api, c)} title="Во цртежот">↘</button>}
                                        <button type="button" onClick={() => setEditing({ ...c, tags: c.tags.join(', ') })} title="Измени">✏️</button>
                                        <button type="button" onClick={() => deleteCard(c)} title="Избриши">🗑</button>
                                    </div>
                                </article>
                            ))}
                        </section>
                    );
                })}
            </div>
            <button type="button" className="wbacc-add-col" onClick={addColumn}>➕ Колона</button>
            {editing && (
                <form className="wbacc-edit" onSubmit={saveCard}>
                    <label>Линк<input value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://…" autoFocus /></label>
                    <label>Наслов<input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
                    <label>Ознаки (со запирка)<input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></label>
                    <label>Белешка<textarea rows={3} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></label>
                    <label>Колона<select value={editing.columnId} onChange={(e) => setEditing({ ...editing, columnId: e.target.value })}>
                        {columns.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
                    </select></label>
                    <label className="wbacc-check"><input type="checkbox" checked={editing.pinned} onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })} /> 📌 закачи горе</label>
                    <div className="wbacc-row"><button type="submit" className="wbacc-primary">💾 Зачувај</button><button type="button" onClick={() => setEditing(null)}>Откажи</button></div>
                </form>
            )}
            <div className="wbacc-row wbacc-foot">
                <label className="wbacc-file">📥 Увези од BookmarksPlus<input type="file" accept=".json,application/json" onChange={importFile} hidden /></label>
                <button type="button" onClick={exportFile}>📤 Извези</button>
            </div>
        </div>
    );
}
