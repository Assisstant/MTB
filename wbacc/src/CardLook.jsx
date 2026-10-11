import { useState } from 'react';
import { useT } from './i18n.js';
import { COLOURS, WIDTHS } from './mine.js';

// The look of a card before it is placed: no frame, or a frame of one of
// three thicknesses in the colours of ComuniBoard's „Креирај картичка". One
// control for „Печати" and „Пиктограми", so the two cannot offer different
// frames. The last choice is remembered on this browser only.
const KEY = 'wbacc-frame-v1';
const WIDTH_NAMES = { 0: 'Без рамка', 2: 'Тенка', 4: 'Средна', 8: 'Дебела' };
const COLOUR_NAMES = ['светлосина', 'црна', 'сина', 'зелена', 'црвена', 'виолетова', 'портокалова', 'розова'];

// Any colour is kept: a card from „Креирај картичка" may carry a Fitzgerald
// key colour that is not among the eight. It is then offered as a ninth.
const valid = (look) => look && WIDTHS.includes(look.width) && /^#[0-9a-f]{6}$/i.test(look.color || '');

export function useLook() {
    const [look, set] = useState(() => {
        try { const kept = JSON.parse(localStorage.getItem(KEY)); if (valid(kept)) return kept; } catch { /* the default */ }
        return { width: 0, color: COLOURS[0] };
    });
    const setLook = (next) => {
        const value = valid(next) ? { width: next.width, color: next.color } : { width: 0, color: COLOURS[0] };
        set(value);
        try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* this visit only */ }
    };
    return [look, setLook];
}

export default function CardLook({ look, setLook }) {
    const t = useT();
    const colours = COLOURS.includes(look.color) ? COLOURS : [look.color, ...COLOURS];
    const name = (c) => t(COLOURS.includes(c) ? COLOUR_NAMES[COLOURS.indexOf(c)] : 'бојата на картичката');
    return <div className="wbacc-look">
        <span className="wbacc-look__name">{t('Рамка')}</span>
        <div className="wbacc-row" role="group" aria-label={t('Рамка')}>
            {WIDTHS.map((w) => <button type="button" key={w} data-frame={w} aria-pressed={look.width === w}
                onClick={() => setLook({ ...look, width: w })}>{t(WIDTH_NAMES[w])}</button>)}
        </div>
        {look.width > 0 && <div className="wbacc-swatches" role="group" aria-label={t('Боја на рамката')}>
            {colours.map((c) => <button type="button" key={c} className="wbacc-swatch" data-colour={c} style={{ background: c }}
                aria-pressed={look.color === c} aria-label={name(c)} title={name(c)}
                onClick={() => setLook({ ...look, color: c })} />)}
        </div>}
    </div>;
}
