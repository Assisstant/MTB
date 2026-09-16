# Optional single-user cloud test

Browser → Render HTTPS (the existing HTML and Fastify API, same origin) →
Supabase PostgreSQL. This is an optional experiment, not a HOME/WORK migration.
Local PostgreSQL, `.env`, Windows tasks, Tailscale, pCloud, backups and manual
handoff remain unchanged. JSON import/export and colleague/PIN permissions remain
unchanged. Basic Auth is an additional single-owner boundary, not multi-user auth.

## Environment and Render settings

| Setting | Local default | Cloud test |
|---|---|---|
| `DATABASE_URL` | Existing local connection | Supabase **Shared Session Pooler**, port 5432, copied from Connect → Session pooler |
| `HOST` | `127.0.0.1` | `0.0.0.0` |
| `PORT` | 3000 | Render-provided port |
| `MTB_CLOUD_AUTH` | unset / `0` | `1` |
| `MTB_CLOUD_USER` | unused | Owner's username, no colon/control characters |
| `MTB_CLOUD_PASSWORD` | unused | Unique randomly generated password, at least 24 characters; spaces, punctuation and UTF-8 supported |
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
The browser's Basic Auth prompt covers embedded pages and same-origin fetches.
All API metadata, directories and static pages require authentication; only
`GET`/`HEAD /healthz` is public and returns `{ "ok": true }` without a DB query.
It proves process liveness, not database readiness. Check authenticated
`/api/health` separately for connectivity and Cyrillic-collation warnings.
Cross-origin requests are refused in cloud mode. Existing colleague enforcement
still applies if `MTB_REQUIRE_SIGNIN=1`; the outer login grants no internal role.
Basic credentials are browser-cached: use a private browser session and close it
when finished; the internal PIN logout does not log out Basic Auth.

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

   First run applies numbered migrations through 032; the second skips recorded
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
[Render free limits](https://render.com/docs/free).
