import { useEffect, useState } from 'react';

// „изработил …", as on every MTB screen (app-navigation.js `.mtb-credit`).
// This file loads nothing shared, so it reads what the other screens remember
// on this origin, and asks its own server when there is one. The name is
// never in this public file; the look is the administrator's (046).
const VARS = {
    size: '--mtb-credit-size', lightText: '--mtb-credit-light-text', lightHalo: '--mtb-credit-light-halo',
    darkText: '--mtb-credit-dark-text', darkHalo: '--mtb-credit-dark-halo'
};

function cleanLook(css) {
    if (!css || typeof css !== 'object') return null;
    const out = {};
    for (const key of Object.keys(VARS)) {
        const value = String(css[key] || '');
        const ok = key === 'size' ? /^\d{1,2}px$/.test(value)
            : /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0?\.\d+)\)$/.test(value);
        if (!ok) return null;
        out[VARS[key]] = value;
    }
    return out;
}

function remembered() {
    try {
        return {
            name: String(localStorage.getItem('mtb_author_v1') || '').trim(),
            look: cleanLook(JSON.parse(localStorage.getItem('mtb_author_look_v1') || 'null'))
        };
    } catch { return { name: '', look: null }; }
}

export default function Credit({ dark }) {
    const [credit, setCredit] = useState(remembered);
    useEffect(() => {
        if (!/^https?:$/.test(location.protocol)) return;
        fetch('/api/health', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((body) => {
                if (!body || body.ok !== true) return;
                const name = String(body.author || '').replace(/\s+/g, ' ').trim();
                const look = cleanLook(body.authorLook);
                try {
                    if (name) localStorage.setItem('mtb_author_v1', name); else localStorage.removeItem('mtb_author_v1');
                    if (look) localStorage.setItem('mtb_author_look_v1', JSON.stringify(body.authorLook));
                    else localStorage.removeItem('mtb_author_look_v1');
                } catch { /* a per-browser nicety */ }
                setCredit({ name, look });
            })
            .catch(() => { /* a published copy has no server: the remembered name stays */ });
    }, []);
    if (!credit.name) return null;
    return (
        <div className={'mtb-credit' + (dark ? ' dark' : '')} style={credit.look || undefined}>
            изработил {credit.name}
        </div>
    );
}
