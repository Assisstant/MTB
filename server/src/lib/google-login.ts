import cookie from '@fastify/cookie';
import session from '@fastify/session';
import type { SessionStore } from '@fastify/session';
import * as oidc from 'openid-client';
import type { FastifyInstance, Session } from 'fastify';

const CALLBACK = '/auth/google/callback';
const COOKIE = '__Host-mtb-session';
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

declare module 'fastify' {
    interface Session {
        owner?: { sub: string; email: string; expiresAt: number };
        oauth?: { state: string; nonce: string; verifier: string; expiresAt: number };
    }
}

/** Bounded single-instance store; restart signs everyone out. No database or tokens. */
export class CloudSessionStore implements SessionStore {
    private entries = new Map<string, { data: Session; expiresAt: number }>();
    private prune() {
        for (const [id, item] of this.entries) if (item.expiresAt <= Date.now()) this.entries.delete(id);
    }
    set(id: string, data: Session, done: (err?: Error) => void) {
        this.prune();
        if (!this.entries.has(id) && this.entries.size >= 256) {
            // New anonymous logins must not evict an existing owner session.
            done(new Error('Login capacity reached')); return;
        }
        this.entries.set(id, { data: structuredClone({ cookie: data.cookie, owner: data.owner, oauth: data.oauth }),
            expiresAt: data.owner?.expiresAt || data.oauth?.expiresAt || Date.now() + TEN_MINUTES });
        done();
    }
    get(id: string, done: (err: Error | null, data?: Session) => void) {
        this.prune();
        const item = this.entries.get(id);
        done(null, item ? structuredClone(item.data) : undefined);
    }
    destroy(id: string, done: (err?: Error) => void) { this.entries.delete(id); done(); }
    clear() { this.entries.clear(); }
}

export function googleSettings(env: NodeJS.ProcessEnv) {
    const clientId = env.MTB_GOOGLE_CLIENT_ID || '';
    const clientSecret = env.MTB_GOOGLE_CLIENT_SECRET || '';
    const email = env.MTB_GOOGLE_ALLOWED_EMAIL || '';
    const secret = env.MTB_SESSION_SECRET || '';
    if (!clientId || !clientSecret || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || secret.length < 32) {
        throw new Error('Google mode requires MTB_GOOGLE_CLIENT_ID, MTB_GOOGLE_CLIENT_SECRET, MTB_GOOGLE_ALLOWED_EMAIL and MTB_SESSION_SECRET (at least 32 characters)');
    }
    return { clientId, clientSecret, email, secret };
}

export function loginPage(denied = false) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MTB · Sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef2f7;color:#17263d;font:16px system-ui,sans-serif}main{box-sizing:border-box;width:min(90vw,380px);padding:40px;border:1px solid #dce4ef;border-radius:20px;background:white;box-shadow:0 12px 40px #17263d12;text-align:center}h1{font-size:32px;margin:0 0 24px}a{display:block;padding:14px 18px;border-radius:10px;background:#234e88;color:white;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid #eab308;outline-offset:4px}p{line-height:1.5}</style></head><body><main><h1>MTB</h1>${denied ? '<p>Access denied. Use the approved Google account.</p>' : ''}<a href="/auth/google" target="_top">Sign in with Google</a></main></body></html>`;
}

export async function installGoogleLogin(server: FastifyInstance, origin: string,
    settings: ReturnType<typeof googleSettings>, customFetch?: oidc.CustomFetch) {
    const store = new CloudSessionStore();
    await server.register(cookie);
    await server.register(session, { secret: settings.secret, cookieName: COOKIE, store,
        saveUninitialized: false, rolling: false,
        cookie: { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: EIGHT_HOURS } });
    server.addHook('onClose', async () => store.clear());
    // Google's published OIDC endpoints. No discovery call or credentials are
    // needed in auth-off mode; tests replace ONLY the provider HTTP transport.
    const config = new oidc.Configuration({ issuer: 'https://accounts.google.com',
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        id_token_signing_alg_values_supported: ['RS256'] }, settings.clientId, settings.clientSecret);
    if (customFetch) config[oidc.customFetch] = customFetch;
    config.timeout = 10;
    oidc.enableNonRepudiationChecks(config);

    server.get('/auth/login', async (_req, reply) => reply.type('text/html').send(loginPage()));
    server.get('/auth/google', async (req, reply) => {
        await req.session.regenerate();
        const pending = { state: oidc.randomState(), nonce: oidc.randomNonce(),
            verifier: oidc.randomPKCECodeVerifier(), expiresAt: Date.now() + TEN_MINUTES };
        req.session.set('oauth', pending);
        req.session.options({ maxAge: TEN_MINUTES });
        const url = oidc.buildAuthorizationUrl(config, { redirect_uri: origin + CALLBACK,
            scope: 'openid email', state: pending.state, nonce: pending.nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
            code_challenge_method: 'S256', prompt: 'select_account' });
        return reply.redirect(url.href);
    });
    server.get(CALLBACK, async (req, reply) => {
        const pending = req.session.get('oauth');
        if (!pending) return reply.code(403).type('text/html').send(loginPage(true));
        // Consume the pre-login session before any network operation. Replays
        // cannot reuse it, and login success always receives a fresh session id.
        await req.session.destroy();
        reply.clearCookie(COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
        try {
            if (!pending || pending.expiresAt <= Date.now()) throw new Error('Missing login attempt');
            const callback = new URL(req.url, origin);
            if (callback.origin !== origin) throw new Error('Invalid callback');
            const tokens = await oidc.authorizationCodeGrant(config, callback, {
                expectedState: pending.state, expectedNonce: pending.nonce,
                pkceCodeVerifier: pending.verifier, idTokenExpected: true });
            const claims = tokens.claims();
            if (!claims || claims.email !== settings.email || claims.email_verified !== true ||
                typeof claims.sub !== 'string' || !claims.sub) throw new Error('Owner not approved');
            // The old session is destroyed; decryptSession creates a fresh one.
            await new Promise<void>((resolve, reject) => server.decryptSession('', req, err => err ? reject(err) : resolve()));
            req.session.options({ maxAge: EIGHT_HOURS });
            req.session.set('owner', { sub: claims.sub, email: settings.email, expiresAt: Date.now() + EIGHT_HOURS });
            await req.session.save();
            return reply.redirect('/MTB-Workspace.html');
        } catch {
            // Never log provider errors, codes, tokens, or identity claims.
            return reply.code(403).type('text/html').send(loginPage(true));
        }
    });
    server.post('/auth/logout', async (req, reply) => {
        await req.session.destroy();
        reply.clearCookie(COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
        return reply.code(204).send();
    });
}
