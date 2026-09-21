# Optional single-user cloud test

Browser → Render HTTPS (the existing HTML and Fastify API, same origin) →
Supabase PostgreSQL. This is an optional experiment, not a HOME/WORK migration.
Local PostgreSQL, `.env`, Windows tasks, Tailscale, pCloud, backups and manual
handoff remain unchanged. JSON import/export and colleague/PIN permissions remain
unchanged. Google login is an additional single-owner boundary, not multi-user auth.

## Environment and Render settings

| Setting | Local default | Cloud test |
|---|---|---|
| `DATABASE_URL` | Existing local connection | Supabase **Shared Session Pooler**, port 5432, copied from Connect → Session pooler |
| `HOST` | `127.0.0.1` | `0.0.0.0` |
| `PORT` | 3000 | Render-provided port |
| `MTB_CLOUD_AUTH` | unset / `off` | `google`; `basic` only for temporary rollback (old `0`/`1` aliases still work) |
| `MTB_GOOGLE_CLIENT_ID`, `MTB_GOOGLE_CLIENT_SECRET` | unused | Web application OAuth credentials from Google Console |
| `MTB_GOOGLE_ALLOWED_EMAIL` | unused | Exact owner email as Google returns it; no aliases or case folding |
| `MTB_SESSION_SECRET` | unused | Unique randomly generated secret of at least 32 characters |
| `MTB_CLOUD_USER`, `MTB_CLOUD_PASSWORD` | unused | Required only for temporary Basic rollback; password at least 24 characters |
| `MTB_CLOUD_ORIGIN` | unused | Exact Render HTTPS origin, without trailing slash |
| `MTB_SERVER_ID`, `MTB_SERVER_LABEL` | Existing installation identity | Distinct cloud identity/label; do not copy HOME/WORK sync identity |
| `NODE_VERSION`, `NODE_ENV` | Existing setup | 24, production |

Keep secrets only in Render's environment or a temporary operator process.
Percent-encode reserved characters in the database password. Use
`sslmode=verify-full` in `DATABASE_URL`. If the provider requires its downloaded
CA, supply `NODE_EXTRA_CA_CERTS` pointing to its mounted PEM certificate (also for
operator commands). Never disable certificate verification. `pg.Pool` remains
unchanged; no Supabase SDK or API key is used.

Proposed Render Web Service: repository `Assisstant/MTB`, branch
`codex/optional-cloud-test`, **Free** instance, repository root (Root Directory
blank), build `npm ci --prefix server --include=dev`, start
`npm start --prefix server`, health `/healthz`, auto-deploy **Off**.
`render.yaml` records these settings; do not deploy it until reviewed.
Dev dependencies are included because the existing start command uses `tsx`.
No migration runs during build or startup. No disk or paid database is requested.

Open `/MTB-Workspace.html` at the Render origin, not the GitHub Pages copy.
The Google login screen leads through Google's server-side authorization-code
flow (`openid email` scopes only). `openid-client` validates state, nonce, PKCE,
issuer, audience, expiry and the ID-token signature. The verified email must
exactly match the configured owner. Other accounts receive Access denied.
No Google access/refresh tokens are retained, sent to the apps, or logged.
All API metadata, directories and static pages require authentication; the login
and OAuth entry/callback routes are public, as is `GET`/`HEAD /healthz`, which
returns `{ "ok": true }` without a DB query.
It proves process liveness, not database readiness. Check authenticated
`/api/health` separately for connectivity and Cyrillic-collation warnings.
Cross-origin data requests are refused; top-level navigation and the protected
OIDC callback permit returning from Google. Existing colleague enforcement still
applies when `MTB_REQUIRE_SIGNIN` is enabled; Google login grants no internal role.

The signed, opaque `__Host-mtb-session` cookie is Secure, HttpOnly, SameSite=Lax,
host-only and path `/`. Identity lives in a bounded in-memory store, never a user
table. Sessions have an absolute eight-hour expiry; login attempts expire after
ten minutes. Logout destroys the server-side session and clears the cookie.
**Одјава од MTB** appears centrally in the shared navigation and Workspace top bar.
Internal colleague logout remains separate. Browser diary data is not erased by
logout; use your own browser profile or a private window on shared computers.

Use one Render instance: restarting or sleeping/restarting it signs the owner
out. This intentionally avoids a session database/Redis for the one-owner test.
Render terminates HTTPS; Google mode enables Fastify proxy awareness solely for
secure cookies. Callback URLs always use the configured HTTPS origin, never
request Host/Forwarded headers. Request logging omits query strings and headers.

## Later: Google Console setup

1. Create/select a Google Cloud project. Open **Google Auth Platform** and set
   the required app name, support email and developer contact under Branding.
2. Under Audience, use **External / Testing** for a personal Google account and
   add only the owner's account as a test user. Use Internal only if this is an
   eligible Workspace organization and the owner belongs to it. The server's
   exact-email check remains authoritative regardless of Google's audience UI.
3. Under Clients, create an OAuth client of type **Web application**. This
   server-side redirect flow needs no Authorized JavaScript origins.
4. Add the exact Authorized redirect URI:
   `https://<render-service>.onrender.com/auth/google/callback`.
   Register any required domain in Branding as prompted by Google; no actual
   deployment domain is hardcoded in MTB.
5. Put the resulting credentials in Render's `MTB_GOOGLE_CLIENT_ID` and
   `MTB_GOOGLE_CLIENT_SECRET`. Set `MTB_GOOGLE_ALLOWED_EMAIL`,
   `MTB_SESSION_SECRET`, `MTB_CLOUD_ORIGIN` and select Google with `MTB_CLOUD_AUTH`.
   The origin is the same HTTPS service address without a trailing slash.
6. Retain only identity scopes `openid` and `email` in Data Access; no Drive,
   Gmail, Calendar, refresh/offline access or Supabase Auth integration is needed.
   Test later in a regular browser; Google may reject embedded webviews.

The blueprint lists environment-variable names with secret inputs unset.
Keep Basic Auth only until hosted Google login, denied-account handling, HTTPS
cookies and logout have been verified. Then remove the Basic mode and its unused
credential variables in a separate reviewed change. Auth-off remains for local use.

## Later: empty database, then optional JSON import

1. Create a separate **empty** Supabase test project manually. Before migration,
   **disable its Data API**: MTB does not use it, and its independent REST/GraphQL
   exposure must not bypass Fastify authentication. Verify this in the project
   settings; don't assume table defaults protect legacy SQL tables/views.
2. Use the **Shared Session Pooler**, not transaction mode (6543). The runner
   holds a session advisory lock. Supply `DATABASE_URL` explicitly in a temporary
   shell; `migrate` deliberately does not read local `.env` or assume credentials.
   Do not overwrite the existing `server/.env`. Disable dotenv for subsequent
   import/export commands with `DOTENV_CONFIG_PATH` set to a nonexistent path.
3. From the repository root, with that environment already set:

   ```sh
   npm ci --prefix server --include=dev
   npm run migrate --prefix server
   npm run migrate --prefix server
   ```

   First run applies numbered migrations through 033; the second skips recorded
   files. Each file and ledger row commit together. Failure reports filename and
   SQLSTATE and rolls back that file; earlier successful files remain recorded.
   Existing outer transactions are normalized in memory, not edited on disk.
   Never use this as an automatic repair for an existing unledgered database.
4. Start with invented JSON. After checking the dry-run report, the existing CLI
   can import explicitly selected private backups into that test database:

   ```sh
   npm run import --prefix server -- "/absolute/private/UnifiedSync.json" "/absolute/private/SDnevnik.json"
   npm run import --prefix server -- "/absolute/private/UnifiedSync.json" "/absolute/private/SDnevnik.json" --apply
   npm run export --prefix server -- "/absolute/private/cloud-json-export"
   ```

   Replace paths, not JSON shapes. Never upload these files to GitHub. JSON is
   compatibility interchange, **not a complete database backup**: teaching,
   evidence, annual configuration and other relational facts need separate
   review before transferring real work. No real data is migrated by this task.
5. Only then manually configure Render, review HTTPS, certificate validation,
   unauthorized access, cloud identity and sample reads/writes. Validate the
   hosted session-pooler connection and free-tier availability before real use.

## Rollback

Stop using the optional service and open the unchanged local installation. Cloud
edits do not automatically reach HOME or WORK. Before retiring a used experiment,
export JSON for compatibility and take a PostgreSQL dump for full recovery;
restore only into a separate reviewed target, never blindly over a live database.
Render's free filesystem is ephemeral and its service can sleep; it is not backup
storage. Supabase free-tier capacity/pausing and Render cold starts need practical
evaluation. This preparation creates no resources and changes no repository visibility.

Provider references: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[disable Data API](https://supabase.com/docs/guides/api/securing-your-api),
[Render blueprint](https://render.com/docs/blueprint-spec),
[Render free limits](https://render.com/docs/free),
[Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).
