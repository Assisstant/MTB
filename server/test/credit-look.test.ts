/**
 * The watermark's look (046): what the administrator may store, and the CSS
 * values every screen is handed. Pure — no database, no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOK, lookCss, normalizeLook } from '../src/lib/author.js';

test('the defaults are the look the screens had before the setting existed', () => {
    // app-navigation.js, Kolega.html and ComuniBoard.html carry these same
    // values as their CSS fallbacks; a database without the row looks the same.
    assert.deepEqual(lookCss(DEFAULT_LOOK), {
        size: '11px',
        lightText: 'rgba(79, 91, 213, 0.5)',
        lightHalo: 'rgba(255, 255, 255, 0.68)',
        darkText: 'rgba(165, 180, 252, 0.48)',
        darkHalo: 'rgba(10, 12, 30, 0.68)'
    });
});

test('a look within the limits is stored as given, colour in lower case', () => {
    const look = { size: 14, light: { color: '#AA0011', text: 80, halo: 20 }, dark: { color: '#ffffff', text: 100, halo: 0 } };
    assert.deepEqual(normalizeLook(look), { ...look, light: { ...look.light, color: '#aa0011' } });
    assert.equal(lookCss(normalizeLook(look)!).lightText, 'rgba(170, 0, 17, 0.8)');
    assert.equal(lookCss(normalizeLook(look)!).darkHalo, 'rgba(10, 12, 30, 0)');
});

test('anything outside the limits is refused, not clipped', () => {
    const ok = structuredClone(DEFAULT_LOOK);
    const bad = (change: (l: any) => void) => { const l: any = structuredClone(ok); change(l); return normalizeLook(l); };
    assert.equal(bad((l) => { l.size = 8; }), null, 'too small to read');
    assert.equal(bad((l) => { l.size = 17; }), null, 'no longer a watermark');
    assert.equal(bad((l) => { l.light.text = 9; }), null, 'letters that cannot be seen are not a credit');
    assert.equal(bad((l) => { l.dark.halo = 101; }), null);
    assert.equal(bad((l) => { l.light.text = 50.5; }), null, 'whole percent only');
    assert.equal(bad((l) => { l.light.color = 'red'; }), null, 'a colour is #rrggbb');
    assert.equal(bad((l) => { l.light.color = '#fff'; }), null);
    assert.equal(bad((l) => { l.dark.color = '#00000g'; }), null);
    // A value that reaches a style attribute is a value that could carry CSS.
    assert.equal(bad((l) => { l.light.color = '#000000; background: red'; }), null);
    assert.equal(bad((l) => { l.extra = true; }), null, 'nothing beyond the known keys');
    assert.equal(normalizeLook(null), null);
    assert.equal(normalizeLook('{}'), null);
});
