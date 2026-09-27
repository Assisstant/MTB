// The MTB server, when there is one. WBACC works without it: only the
// bookmarks (the administrator's, 047) and the watermark ask it anything.
//
// Served by an MTB server, that server is the page's own origin. Opened from
// GitHub Pages it is the server the other MTB screens chose (the same key
// app-navigation.js keeps), so the whole suite looks at one database.
const TOKEN_KEY = 'evidence_token_v1';          // the shared sign-in of every MTB screen
const CHOSEN_KEY = 'mtb_podatoci_server_v1';
const TIMEOUT = 4000;

let found = null;

function candidates() {
    const list = [];
    if (/^https?:$/.test(location.protocol) && location.hostname !== 'assisstant.github.io') list.push(location.origin);
    try {
        const chosen = localStorage.getItem(CHOSEN_KEY);
        if (chosen && /^https?:\/\//.test(chosen)) list.push(chosen.replace(/\/+$/, ''));
    } catch { /* no storage: the page's own origin only */ }
    return [...new Set(list)];
}

async function answers(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
        const r = await fetch(base + '/api/health', { cache: 'no-store', signal: controller.signal });
        const body = r.ok ? await r.json().catch(() => null) : null;
        return Boolean(body && body.ok === true);
    } catch { return false; } finally { clearTimeout(timer); }
}

/** The first server that answers, or '' — asked again when asked again. */
export async function server() {
    if (found && await answers(found)) return found;
    found = null;
    for (const base of candidates()) {
        if (await answers(base)) { found = base; return base; }
    }
    return '';
}

function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export class ApiError extends Error {
    constructor(status, body) {
        super((body && body.error) || (status ? 'HTTP ' + status : 'Серверот не одговара.'));
        this.status = status;
        this.body = body || {};
    }
}

export async function api(method, path, body) {
    const base = await server();
    if (!base) throw new ApiError(0, null);
    let r;
    try {
        r = await fetch(base + path, {
            method,
            cache: 'no-store',
            headers: { 'content-type': 'application/json', 'x-mtb-evidence-token': token() },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch { throw new ApiError(0, null); }
    const answer = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, answer);
    return answer;
}

/** The administrator's PIN sign-in, the same one Податоци and Евидентен лист use. */
export async function people() {
    return ((await api('GET', '/api/evidence/people')) || {}).people || [];
}

export async function signIn(kind, personId, pin) {
    const res = await api('POST', '/api/evidence/login', { kind, personId: Number(personId), pin });
    try { localStorage.setItem(TOKEN_KEY, res.token); } catch { /* this visit only */ }
    return res;
}
