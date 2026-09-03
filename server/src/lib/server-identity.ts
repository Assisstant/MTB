import os from 'node:os';

export type ServerRole = 'work' | 'home' | 'other';

export type ServerIdentity = {
    id: string;
    role: ServerRole;
    place: string;
    machine: string;
    label: string;
    warning?: string;
};

function cleanId(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function roleOf(value: string): ServerRole {
    const normalized = cleanId(value);
    if (normalized === 'work') return 'work';
    if (normalized === 'home') return 'home';
    return 'other';
}

function displayMachineName(machine: string): string {
    const normalized = cleanId(machine);
    if (normalized === 'zenpc') return 'ZenPC';
    if (normalized === 'zenpc1' || normalized === 'zenpc-1') return 'ZenPC-1';
    return machine || 'непознат сервер';
}

/**
 * The identity belongs to the installation, not to PostgreSQL. A complete
 * WORK database restore on HOME must still introduce itself as HOME.
 */
export function resolveServerIdentity(
    env: NodeJS.ProcessEnv = process.env,
    hostName: string = os.hostname()
): ServerIdentity {
    const declaredRole = env.MANUAL_SYNC_NAME
        || env.HANDOFF_NAME
        || env.SYNC_NAME
        || '';
    const declaredId = cleanId(env.MTB_SERVER_ID || declaredRole);
    // Windows hostnames are not identities: both installations may legitimately
    // be named ZenPC. The local, untracked server configuration is authoritative.
    const role = roleOf(declaredRole || env.MTB_SERVER_ID || '');
    const machine = String(env.MTB_SERVER_MACHINE || hostName || '').trim();
    const id = declaredId || (role !== 'other' ? role : cleanId(machine)) || 'unknown';
    const place = role === 'work' ? 'РАБОТА' : role === 'home' ? 'ДОМА' : 'СЕРВЕР';
    const label = String(env.MTB_SERVER_LABEL || '').trim()
        || `${place} · ${displayMachineName(machine)}`;
    const warning = !declaredId
        ? 'server role is not configured; set SYNC_NAME=work or SYNC_NAME=home'
        : '';

    return { id, role, place, machine, label, ...(warning ? { warning } : {}) };
}
