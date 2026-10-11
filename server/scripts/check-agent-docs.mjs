/** Small entry points and complete routes, without loading every reference on startup. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const budgets = { 'AGENTS.md': 24 * 1024, 'CLAUDE.md': 1024, 'SOSTOJBA.md': 32 * 1024 };
const flat = text => text.replace(/\s+/g, ' ').trim().replace(/\.$/, '');

// Export the pure check so a negative control can prove each guard rejects drift.
export function checkAgentDocs(read, exists) {
    const errors = [];
    const docs = Object.fromEntries(Object.keys(budgets).map(file => [file, read(file)]));
    for (const [file, max] of Object.entries(budgets)) {
        const bytes = Buffer.byteLength(docs[file], 'utf8');
        if (bytes > max) errors.push(`${file}: ${bytes} bytes exceeds the ${max}-byte repository budget; move detail into a linked reference.`);
    }
    const imports = [...docs['CLAUDE.md'].matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m => m[1]);
    if (imports.length !== 1 || imports[0] !== 'AGENTS.md' || !/^@AGENTS\.md\s*$/m.test(docs['CLAUDE.md'])) errors.push('CLAUDE.md must import exactly @AGENTS.md on its own line.');
    if (/@[\w./-]+/.test(docs['AGENTS.md'])) errors.push('AGENTS.md must link references normally, not auto-import them.');
    if (/^## /m.test(docs['CLAUDE.md'])) errors.push('CLAUDE.md is an import wrapper; shared rules belong in AGENTS.md.');

    const traps = read('docs/TRAPS.md');
    const entries = [...traps.matchAll(/^<a id="(trap-\d+)"><\/a>\n\n- \*\*([\s\S]*?)\*\*/gm)];
    const leads = [...traps.matchAll(/^- \*\*/gm)].length;
    const routes = [...docs['AGENTS.md'].matchAll(/^- \[(.+)\]\(docs\/TRAPS\.md#(trap-\d+)\)$/gm)];
    if (!leads || leads !== entries.length) errors.push('Every trap needs its own stable anchor immediately before the entry.');
    if (entries.length !== new Set(entries.map(m => m[1])).size) errors.push('Trap anchors must be unique.');
    if (routes.length !== entries.length) errors.push('AGENTS.md must have one route for every trap, without extras.');
    for (const entry of entries) {
        const matches = routes.filter(route => route[2] === entry[1]);
        if (matches.length !== 1 || flat(matches[0][1]) !== flat(entry[2])) errors.push(`Missing or stale trap route: ${entry[1]}.`);
    }
    const groups = [...traps.matchAll(/^<a id="(group-[a-z-]+)"><\/a>\n\n## (.+)$/gm)];
    const groupRoutes = [...docs['AGENTS.md'].matchAll(/\[Open the whole group\]\(docs\/TRAPS\.md#(group-[a-z-]+)\)/g)];
    if (!groups.length || groups.length !== new Set(groups.map(m => m[1])).size || groupRoutes.length !== groups.length) {
        errors.push('Every trap group needs a unique anchor and one whole-group route in AGENTS.md.');
    }
    for (const group of groups) {
        const matches = groupRoutes.filter(route => route[1] === group[1]);
        const heading = matches.length === 1
            ? [...docs['AGENTS.md'].slice(0, matches[0].index).matchAll(/^### (.+)$/gm)].at(-1)?.[1] : undefined;
        if (heading !== group[2]) errors.push(`Missing or stale trap group route: ${group[1]}.`);
    }
    for (const entry of entries) {
        const home = groups.filter(group => group.index < entry.index).at(-1)?.[1];
        const route = routes.find(route => route[2] === entry[1]);
        const routedHome = route && groupRoutes.filter(group => group.index < route.index).at(-1)?.[1];
        if (!home || routedHome !== home) errors.push(`Wrong or missing trap group for ${entry[1]}.`);
    }
    for (const [file, text] of Object.entries(docs)) {
        for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
            const target = match[1];
            if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
            const [path, fragment] = target.split('#');
            const local = resolve(ROOT, dirname(file), decodeURIComponent(path));
            if (!exists(local)) { errors.push(`${file}: missing linked file ${path}.`); continue; }
            if (!fragment) continue;
            const body = read(local);
            const ids = [...body.matchAll(/<a id="([^"]+)"/g)].map(m => m[1]);
            const headings = [...body.matchAll(/^#{1,6} (.+)$/gm)].map(m => m[1].toLowerCase()
                .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-'));
            if (![...ids, ...headings].includes(decodeURIComponent(fragment))) errors.push(`${file}: missing anchor ${target}.`);
        }
    }
    return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    // Relative links resolve from repo root, independently of the calling cwd.
    try {
        const errors = checkAgentDocs(file => readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n/g, '\n'), existsSync);
        if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
        else console.log('Agent docs checked: one import, compact entry points, every trap grouped and linked, local routes resolve.');
    } catch (error) { console.error(`Agent docs check could not run: ${error.message}`); process.exitCode = 1; }
}
