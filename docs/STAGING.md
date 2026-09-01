# Staging

A full staging environment: real Clerk auth, real Postgres, real Fly and Pages, zero overlap with production users or data. Use it to try a change against hosted infrastructure without restarting `pqp-api` or touching pqp.gg.

## URLs

| Piece | URL |
|---|---|
| Web (Pages branch deploy of project `pqp`) | https://staging.pqp-3yr.pages.dev |
| API (Fly.io app `pqp-api-staging`, region `gru`) | https://pqp-api-staging.fly.dev |
| WebSocket | `wss://pqp-api-staging.fly.dev/ws` |
| Health | `GET https://pqp-api-staging.fly.dev/health` |

## What staging is (and is not)

- **Separate users.** Auth is a Clerk DEVELOPMENT instance (`pk_test` / `sk_test`). Accounts, sessions and origins are fully disjoint from production Clerk. Your prod account does not exist here; sign up again.
- **Separate, empty database.** Database `pqp-staging` (hyphen: Fly Managed Postgres rejects underscores in database names) on the existing cluster `pqp-db`, created with `fly mpg databases create --name pqp-staging`. The schema self-applies at boot via `server/src/schema.sql` (`initDb()` in `server/src/db.ts`); there is no migration step and nothing to run by hand.
- **Object storage is its own R2 bucket, `pqp-attachments-staging`** (created 2026-09-01, private, CORS for `https://staging.pqp-3yr.pages.dev` and `http://localhost:5173`). `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION=auto` and `S3_FORCE_PATH_STYLE=false` are set on `pqp-api-staging`; the two credentials come from an R2 API token scoped to that bucket (Dashboard → R2 → Manage R2 API Tokens → Object Read & Write). `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set from the account token `pqp-staging` (Object Read & Write, that bucket only), verified with a signed PUT / HEAD / DELETE round trip on 2026-09-01. Attachments and Baú media both work on staging. Never point staging at the production bucket; to rotate, create a new token in the dashboard, `fly secrets set` the pair, then delete the old token.
- **No TURN.** Cross-NAT voice may fail on staging; same-network voice works. This is the known STUN-only limitation (CLAUDE.md pitfall 1), accepted here to keep staging cheap.
- **No analytics or ads tags.** The build omits Umami, Google Ads and the APK click beacon on purpose; staging traffic must not pollute production numbers.
- **Scales to zero.** `fly.staging.toml` sets `auto_stop_machines = "stop"` and `min_machines_running = 0`, so the machine parks when idle and the first request after an idle period takes a few seconds while it boots. Production deliberately keeps min 1 because a stop drops every live WebSocket; staging accepts that trade.

## How to deploy

Both jobs (web and API) run in parallel from `.github/workflows/deploy-staging.yml`; neither blocks the other, and neither waits for CI.

```bash
# Option A: the long-lived branch
git push origin my-branch:staging     # or merge to staging and push

# Option B: try any ref without touching the staging branch
gh workflow run deploy-staging.yml --ref my-feature-branch
```

A deploy to staging never restarts production: the workflow only talks to `pqp-api-staging` and to the `staging` branch alias of the Pages project.

## Resetting the staging database

Wipe the contents of `pqp-staging` in place; the next boot recreates the whole schema from `server/src/schema.sql`. Dropping the database itself is not an option on Managed Postgres: the `schema_admin` role owns neither the database nor the `public` schema (both belong to `postgres`, and there is no `fly mpg databases delete`), so `DROP DATABASE` and `DROP SCHEMA public` are both refused. What the role can drop is everything it created, which is exactly the app's tables and the `pgcrypto` extension (the app's `fly-user` login resolves to `schema_admin` on this cluster).

```bash
fly machine stop -a pqp-api-staging     # so nothing holds connections or recreates tables mid-wipe
echo 'DROP OWNED BY current_user;' | fly mpg connect 82ylg01v4n30zx19 -d pqp-staging
fly machine start -a pqp-api-staging    # boot reapplies schema.sql, including CREATE EXTENSION pgcrypto
```

`82ylg01v4n30zx19` is the `pqp-db` cluster id (`fly mpg list -o personal` to look it up). Double-check the `-d pqp-staging` flag before running anything here: the same command without it connects to `fly-db`, which is production.

## Credentials that back it (names only, never values)

| Where | Name | What |
|---|---|---|
| GitHub Actions secret | `FLY_API_TOKEN_STAGING` | Deploy token scoped to `pqp-api-staging` |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shared with the production web deploy |
| GitHub repo variable | `STAGING_CLERK_PUBLISHABLE_KEY` | Clerk dev `pk_test`; public by definition, so a variable, not a secret |
| Fly secrets on `pqp-api-staging` | `DATABASE_URL` | Points at `pqp-staging` on `pqp-db` |
| Fly secrets on `pqp-api-staging` | `CLERK_SECRET_KEY` | The dev instance `sk_test`, never the prod key |
| Fly secrets on `pqp-api-staging` | `CORS_ALLOWED_ORIGINS`, `CLERK_AUTHORIZED_PARTIES` | The staging Pages origin |
| Fly secrets on `pqp-api-staging` | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | R2 API token scoped to `pqp-attachments-staging` only |

## Known caveats

- **Canonical URLs point at production.** Marketing and blog routes pin their canonical tag to https://pqp.gg (`client/src/lib/marketing-meta.ts`, `client/src/lib/blog-meta.ts`), so staging pages carry prod canonicals. Harmless for testing; it only means staging marketing pages are not independently indexable, which is a feature.
- **Game connections do not work.** Steam, Battle.net and Twitch OAuth apps are registered for the production origin only; the staging origin has no provider registrations, so those linking flows will fail or stay hidden.
- **First request after idle is slow.** A parked machine takes a few seconds to wake. If a probe or test suite hits a timeout, retry once before suspecting the deploy.
- **Staging shares the `pqp-db` cluster with production's database.** Different database, same Postgres machines. Do not point load tests at staging expecting them to be free; heavy load shows up on the shared cluster.
