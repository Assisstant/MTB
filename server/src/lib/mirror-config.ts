import { timingSafeEqual } from 'node:crypto';

export type MirrorMode = 'off' | 'readonly';

export function mirrorMode(env: NodeJS.ProcessEnv = process.env): MirrorMode {
    const raw = String(env.MTB_MIRROR_MODE || 'off').trim().toLowerCase();
    if (raw === '' || raw === 'off' || raw === '0') return 'off';
    if (raw === 'readonly' || raw === 'read-only' || raw === '1') return 'readonly';
    throw new Error('MTB_MIRROR_MODE must be off or readonly');
}

export function mirrorExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = String(env.MTB_MIRROR_EXPORT || '0').trim().toLowerCase();
    if (raw === '' || raw === '0' || raw === 'off') return false;
    if (raw === '1' || raw === 'on') return true;
    throw new Error('MTB_MIRROR_EXPORT must be 0/off or 1/on');
}

export function mirrorExportKey(env: NodeJS.ProcessEnv = process.env): string {
    if (!mirrorExportEnabled(env)) return '';
    const key = String(env.MTB_MIRROR_EXPORT_KEY || '').trim();
    if (key.length < 32 || /[\x00-\x20\x7f]/.test(key)) {
        throw new Error('MTB_MIRROR_EXPORT_KEY must be at least 32 non-whitespace characters');
    }
    return key;
}

function equalSecret(offered: string, expected: string): boolean {
    const left = Buffer.from(offered, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

/** The export key authorizes exactly one read endpoint, never another API. */
export function mirrorExportRequest(req: {
    method: string;
    url?: string;
    headers: Record<string, unknown>;
}, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!mirrorExportEnabled(env) || !['GET', 'HEAD'].includes(req.method)) return false;
    if (String(req.url || '').split('?')[0] !== '/api/mirror/snapshot') return false;
    const match = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ''));
    return Boolean(match && equalSecret(match[1], mirrorExportKey(env)));
}

export function mirrorSourceLabel(env: NodeJS.ProcessEnv = process.env): string {
    return String(env.MTB_MIRROR_SOURCE_LABEL || 'Supabase').trim() || 'Supabase';
}
