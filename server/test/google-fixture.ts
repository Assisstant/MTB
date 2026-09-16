import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { cloudRequestLog, installCloudAuth } from '../src/lib/cloud-auth.js';
import { installPublicStatic } from '../src/lib/public-static.js';
import { installColleagueBoundary } from '../src/lib/colleague.js';
const origin = 'https://mtb.example';
const env = { MTB_CLOUD_AUTH: 'google', MTB_CLOUD_ORIGIN: origin,
    MTB_GOOGLE_CLIENT_ID: 'invented-client', MTB_GOOGLE_CLIENT_SECRET: 'invented-client-secret',
    MTB_GOOGLE_ALLOWED_EMAIL: 'owner@example.test', MTB_SESSION_SECRET: 'invented-test-session-secret-0123456789abcdef' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const headers = { 'x-forwarded-proto': 'https', host: 'untrusted.example' };
const COOKIE = '__Host-mtb-session';
function sessionCookie(response: { headers: Record<string, unknown> }) {
    const raw = response.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String)
        .filter(v => v.startsWith(COOKIE + '=')).at(-1)?.split(';')[0] || '';
}

async function fixture(overrides: Record<string, unknown> = {}, badSignature = false) {
    let nonce = '', challenge = '', exchanges = 0;
    const logs: string[] = [];
    const app = Fastify({ trustProxy: true, logger: { level: 'info', stream: { write: (s: string) => logs.push(s) },
        serializers: { req: cloudRequestLog } } });
    await installCloudAuth(app, env, async (input, init) => {
        const url = new URL(String(input));
        if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') {
            return Response.json({ keys: [jwk] });
        }
        assert.equal(url.href, 'https://oauth2.googleapis.com/token', 'no real provider network requests');
        exchanges++;
        const params = new URLSearchParams(String(init?.body));
        assert.equal(params.get('redirect_uri'), origin + '/auth/google/callback');
        assert.equal(createHash('sha256').update(params.get('code_verifier') || '').digest('base64url'), challenge);
        const claims = { iss: 'https://accounts.google.com', aud: env.MTB_GOOGLE_CLIENT_ID,
            sub: 'invented-owner', email: env.MTB_GOOGLE_ALLOWED_EMAIL, email_verified: true,
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...overrides };
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const body = encode({ alg: 'RS256', kid: 'test-key' }) + '.' + encode(claims);
        const signature = sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url');
        return Response.json({ access_token: 'must-not-leak-access-token', refresh_token: 'must-not-leak-refresh-token',
            token_type: 'Bearer', expires_in: 300, id_token: body + '.' + (badSignature ? 'invalid' : signature) });
    });
    installColleagueBoundary(app);
    installPublicStatic(app, fileURLToPath(new URL('../..', import.meta.url)));
    app.get('/api/private-test', async () => ({ ok: true }));
    app.post('/api/private-test', async () => ({ saved: true }));
    app.get('/api/health', async () => ({ ok: true, cloudAuth: 'google', server: { label: 'Test cloud' } }));
    app.get('/api/years', async () => [{ label: '2026/2027', is_current: true }]);
    app.get('/api/roster', async () => ({ students: [], therapists: [], teachers: [] }));
    const authorization = (url: URL) => {
        nonce = url.searchParams.get('nonce') || '';
        challenge = url.searchParams.get('code_challenge') || '';
    };
    const start = async () => {
        const response = await app.inject({ url: '/auth/google', headers });
        assert.equal(response.statusCode, 302, response.body);
        const url = new URL(String(response.headers.location));
        authorization(url);
        assert.equal(url.origin, 'https://accounts.google.com');
        assert.equal(url.searchParams.get('scope'), 'openid email');
        assert.equal(url.searchParams.get('redirect_uri'), origin + '/auth/google/callback');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(nonce && challenge);
        assert.match(String(response.headers['set-cookie']), /Secure/);
        assert.match(String(response.headers['set-cookie']), /HttpOnly/);
        assert.match(String(response.headers['set-cookie']), /SameSite=Lax/);
        assert.doesNotMatch(String(response.headers['set-cookie']), /Domain=/);
        return { cookie: sessionCookie(response), state: url.searchParams.get('state')! };
    };
    const callback = (attempt: { cookie: string; state: string }, state = attempt.state) => app.inject({
        url: '/auth/google/callback?code=secret-test-code&state=' + encodeURIComponent(state),
        headers: { ...headers, cookie: attempt.cookie, 'sec-fetch-site': 'cross-site' } });
    return { app, start, callback, logs, authorization, exchanges: () => exchanges };
}


export { fixture, origin, env, headers, COOKIE, sessionCookie };
