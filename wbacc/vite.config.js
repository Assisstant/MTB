// WBACC Studio is built into ONE file, ../WBACC.html, that works with no
// Internet at all (owner, 27 Sep 2026): on GitHub Pages, on the local server,
// in the cloud, and opened straight from the disk.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXCALIDRAW = join(process.cwd(), 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');

/**
 * Excalidraw names each font by an address ("./fonts/Excalifont/…woff2") and
 * loads it from EXCALIDRAW_ASSET_PATH or, failing that, from a CDN — neither
 * exists offline. Its loader also accepts the font itself as a `data:` URL, so
 * the address is replaced by the font at build time. Latin and Cyrillic only
 * (~0.5 MB); the Chinese Xiaolai family is 13 MB and keeps its address — online
 * it still comes from the CDN, offline its characters fall back.
 */
function inlineFonts() {
    return {
        name: 'wbacc-inline-fonts',
        enforce: 'pre',
        transform(code, id) {
            if (!id.replace(/\\/g, '/').includes('/@excalidraw/excalidraw/dist/prod/')) return null;
            if (!code.includes('./fonts/')) return null;
            return code.replace(/"\.\/fonts\/((?!Xiaolai\/)[A-Za-z]+\/[^"]+\.woff2)"/g, (_, file) =>
                JSON.stringify('data:font/woff2;base64,' + readFileSync(join(EXCALIDRAW, 'fonts', file)).toString('base64')));
        }
    };
}

/**
 * Macedonian for Excalidraw's own menus (owner, 28 Sep 2026: English for him,
 * Macedonian as a switch, „not perfect is ok"). Excalidraw offers no way to add
 * a language from outside, so its list and its loader get one entry each:
 * `mk-MK`, whose strings are src/mk-MK.json. Anything not translated there
 * falls back to English, as Excalidraw does for every language.
 */
const MK = 'virtual:wbacc-mk';
function macedonian() {
    return {
        name: 'wbacc-macedonian',
        enforce: 'pre',
        resolveId: (id) => (id === MK ? '\0' + MK : null),
        // Excalidraw reads a language's groups as NAMED exports (toolBar,
        // labels…), as its own locale files provide them, not from `default`.
        load(id) {
            if (id !== '\0' + MK) return null;
            const mk = JSON.parse(readFileSync(join(process.cwd(), 'src', 'mk-MK.json'), 'utf8'));
            return Object.keys(mk).map((group) => `export const ${group} = ${JSON.stringify(mk[group])};`).join('\n')
                + `\nexport default { ${Object.keys(mk).join(', ')} };`;
        },
        transform(code, id) {
            if (!id.replace(/\\/g, '/').endsWith('/@excalidraw/excalidraw/dist/prod/index.js')) return null;
            const loader = '({"./locales/ar-SA.json":';
            const listed = '{code:"bg-BG",label:';
            // Excalidraw lists only languages translated past 85 %; ours is
            // partial on purpose, so it passes by name.
            const kept = /\.filter\(e=>(\w+)\[e\.code\]>=VT\)/;
            if (!code.includes(loader) || !code.includes(listed) || !kept.test(code)) {
                throw new Error('WBACC: Excalidraw\'s language list changed shape; the Macedonian entry needs updating.');
            }
            return code
                .replace(loader, `({"./locales/mk-MK.json":()=>import(${JSON.stringify(MK)}),"./locales/ar-SA.json":`)
                .replace(listed, `{code:"mk-MK",label:"Македонски"},${listed}`)
                .replace(kept, (all, pct) => `.filter(e=>e.code==="mk-MK"||${pct}[e.code]>=VT)`);
        }
    };
}

export default defineConfig({
    plugins: [inlineFonts(), macedonian(), react(), viteSingleFile()],
    define: { 'process.env.IS_PREACT': JSON.stringify('false') },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 20000 }
});
