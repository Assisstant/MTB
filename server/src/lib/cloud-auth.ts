import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { CustomFetch } from 'openid-client';
import { googleSettings, installGoogleLogin } from './google-login.js';
import { mirrorExportRequest, mirrorMode } from './mirror-config.js';

export function cloudRequestLog(req: { method: string; url?: string }) {
    return { method: req.method, url: String(req.url || '').split('?')[0] };
}

export function cloudAuthMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'basic' | 'google' {
    const flag = env.MTB_CLOUD_AUTH || 'off';
    // Phase-1 values remain explicit rollback aliases.
    if (flag === '0' || flag === 'off') return 'off';
    if (flag === '1' || flag === 'basic') return 'basic';
    if (flag === 'google') return 'google';
    throw new Error('MTB_CLOUD_AUTH must be off, basic, or google');
}

export function listenOptions(env: NodeJS.ProcessEnv = process.env) {
    const port = Number(env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
    return { host: env.HOST || '127.0.0.1', port };
}

/** Single-owner outer boundary. Existing colleague permissions still apply. */
export function installCloudAuth(server: FastifyInstance, env: NodeJS.ProcessEnv = process.env, oidcFetch?: CustomFetch) {
    const mode = cloudAuthMode(env);
    const enabled = mode !== 'off';
    const user = env.MTB_CLOUD_USER || '';
    const password = env.MTB_CLOUD_PASSWORD || '';
    let origin = '';
    if (enabled) {
        if (mode === 'basic' && (!user || /[:\x00-\x1f\x7f]/.test(user) || password.length < 24 || /[\x00-\x1f\x7f]/.test(password))) {
            throw new Error('Cloud auth requires a username without colon/control characters and a password of at least 24 characters');
        }
        try {
            const url = new URL(env.MTB_CLOUD_ORIGIN || '');
            if (url.protocol !== 'https:' || url.origin !== env.MTB_CLOUD_ORIGIN) throw new Error();
            origin = url.origin;
        } catch { throw new Error('MTB_CLOUD_ORIGIN must be an HTTPS origin without a trailing slash'); }
    }
    const google = mode === 'google' ? googleSettings(env) : null;
    return setup();
    async function setup() {
        if (google) await installGoogleLogin(server, origin, google, oidcFetch);
        const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
        const expected = digest(`${user}:${password}`);
        server.addHook('onSend', async (_req, reply, payload) => {
            if (enabled) reply.header('Cache-Control', 'no-store');
            return payload;
        });
        server.addHook('onRequest', async (req, reply) => {
            if (!enabled) return;
            reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
                .header('X-Content-Type-Options', 'nosniff')
                .header('Content-Security-Policy', "frame-ancestors 'self'");
            if (['GET', 'HEAD'].includes(req.method) && req.url.split('?')[0] === '/healthz') return;
            // A revocable machine credential can read exactly the mirror
            // snapshot. It is not a Google/browser cookie and cannot enter any
            // other static or API route.
            if (mirrorExportRequest(req, env)) return;
            const route = req.routeOptions.url;
            // Google's cross-site top-level callback is the one exception. The OIDC
            // library checks its bound state, nonce, PKCE, issuer, audience and signature.
            if (mode === 'google' && ['GET', 'HEAD'].includes(req.method) && route === '/auth/google/callback') return;
            // Browsers cache Basic credentials: CORS alone does not prevent CSRF.
            const safeNavigation = ['GET', 'HEAD'].includes(req.method) &&
                req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
            if ((req.headers['sec-fetch-site'] === 'cross-site' && !(mode === 'google' && safeNavigation)) ||
                (req.headers.origin !== undefined && req.headers.origin !== origin) ||
                (mode === 'google' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin)) {
                return reply.code(403).send({ error: 'Same-origin access required' });
            }
            if (mode === 'google') {
                if (['GET', 'HEAD'].includes(req.method) && ['/auth/login', '/auth/google'].includes(route || '')) return;
                const owner = req.session?.get('owner');
                if (owner && owner.email === google!.email && owner.expiresAt > Date.now()) return;
                if (req.url.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) {
                    return reply.code(401).send({ error: 'Authentication required' });
                }
                return reply.redirect('/auth/login');
            }
            const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
            const provided = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
            if (!timingSafeEqual(digest(provided), expected)) {
                reply.header('WWW-Authenticate', 'Basic realm="MTB cloud test", charset="UTF-8"');
                return reply.code(401).send({ error: 'Authentication required' });
            }
        });
        server.get('/healthz', async () => ({ ok: true }));
        // Legacy screens and the launcher need an explicit hosted-server capability.
        server.get('/mtb-runtime.js', async (_req, reply) => reply.type('application/javascript')
            .header('Cache-Control', 'no-store').send(
                `window.MTB_CLOUD_SAME_ORIGIN=${enabled};window.MTB_MIRROR_READONLY=${mirrorMode(env) === 'readonly'};`
            ));
        return enabled;
    }
}
