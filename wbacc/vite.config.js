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

export default defineConfig({
    plugins: [inlineFonts(), react(), viteSingleFile()],
    define: { 'process.env.IS_PREACT': JSON.stringify('false') },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 20000 }
});
