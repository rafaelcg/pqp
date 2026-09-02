# Deploying pqp

This repo deploys the **marketing site + static SPA shell** to **Cloudflare Pages**. The WebSocket/API server and Postgres are **not** on Pages — host them separately (e.g. [Railway](./deploy-railway.md)).

## Architecture (hosted)

| Piece | Where | Notes |
|---|---|---|
| Landing + `/app` SPA | Cloudflare Pages (`pqp`) | Static Vite build from `client/` |
| API + `/ws` | Railway / Docker / VPS | See `railway.toml`, `Dockerfile` |
| Auth | Clerk | Publishable key in client build; secret on server only |
| Database | Postgres | Railway plugin or self-hosted |
| Attachments | Cloudflare R2 (or any S3) | Optional — off unless configured. See [`ATTACHMENTS.md`](./ATTACHMENTS.md) |

First deploy priority: **dev / marketing website** on Pages. Point `VITE_API_URL` / `VITE_WS_URL` at your API when it exists.

**Expected without an API:** `/` (landing) works. After Clerk sign-in, `/app` cannot load servers until a backend is hosted and the client is rebuilt with API URLs.

## GitHub Actions

### Which changes restart the API, and therefore drop every call

`deploy-api-fly.yml` only deploys when the commit touches something the server
actually runs. The gate is an **allowlist**, so anything not on it is left
alone and a new top-level directory defaults to *not* restarting production:

```
server/  packages/  Dockerfile  fly.toml  pnpm-lock.yaml
pnpm-workspace.yaml  package.json  .github/workflows/deploy-api-fly.yml
```

**`packages/` is on that list in full, and this is the one that surprises
people.** The server compiles `@pqp/shared` into itself, so a change there is a
server change no matter how client-side the feature feels. On 24 Aug 2026 a PR
that added in-app notification sounds touched `packages/shared/src/api.ts` and
restarted `pqp-api`, disconnecting everyone who was in a voice call at the time.
Nothing was broken and the gate behaved correctly; the PR simply did not look
like a server change to anyone reading it.

A Fly deploy is a rolling restart of a single machine, so every WebSocket goes
with it. Open chats reconnect on their own. **Web and Electron** keep the media
session and reattach the same peer id. In the same process that is a 90-second
orphan window. After a Fly restart the map is empty, so reconstruct uses the
HMAC token (valid for hours, so a long call still resumes). A deploy that
stays down longer than 90 seconds drops the held mesh and cold-rejoins when
the socket is back. Reconnect still needs a Clerk token that can be fetched
(cached JWT, or the browser is online). **iOS and Android**
still cold-join (new peer id, call drops) until a follow-up. Tabs that have not
refreshed since this shipped also cold-join.

The PR that added resume still drops everyone once on merge: old clients do not
send the token. After that refresh, later API deploys should not cut web/Electron
audio.

Voice does not follow the message curve, either. Traffic overnight in Brazil is
mostly *calls*, so "it is 2am, nobody is around" is a bad instinct: on 24 Aug
there were 26 people in 12 rooms at 02:20Z while text had fallen to 11 messages
an hour. Read `GET /api/admin/metrics` (`voice.participants`) before merging
something server-relevant, rather than guessing from the clock.

Client-only changes skip all of this and can ship whenever.


| Workflow | Path | Triggers | Purpose |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | PR + push to `main` | pnpm install, build shared/server/client |
| Deploy Web | `.github/workflows/deploy-web.yml` | push to `main`, `workflow_dispatch` | Production client → Cloudflare Pages |
| Electron | `.github/workflows/electron.yml` | push `main`, tags `v*`, `workflow_dispatch` | Unsigned mac/win/linux artifacts |
| Deploy Staging | `.github/workflows/deploy-staging.yml` | push to `staging`, `workflow_dispatch` on any ref | Staging client (Pages branch `staging`) + staging API (`pqp-api-staging`). Never touches production. See [`STAGING.md`](./STAGING.md) |

### Trigger deploy manually

```bash
gh workflow run deploy-web.yml
# or
gh workflow run "Deploy Web"
```

### Trigger Electron build

```bash
gh workflow run electron.yml
# or push a version tag: git tag v0.0.1 && git push origin v0.0.1
```

## Required GitHub Actions secrets

Set these on the repo (**Settings → Secrets and variables → Actions**), or via CLI:

```bash
# Cloudflare (Pages deploy)
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID

# Client build (publishable key is safe in the browser bundle)
gh secret set VITE_CLERK_PUBLISHABLE_KEY

# Required for a working /app (not just marketing) — public API origin
gh secret set VITE_API_URL
gh secret set VITE_WS_URL
```

| Secret | Required for | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Web | Token with **Cloudflare Pages — Edit** (see below) |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy Web | Cloudflare account ID (Workers & Pages overview sidebar) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Deploy Web | Clerk publishable key (`pk_…`) |
| `VITE_API_URL` | Working `/app` | Public API origin, e.g. `https://your-api.up.railway.app` (no trailing slash) |
| `VITE_WS_URL` | Working `/app` | Public WebSocket URL, e.g. `wss://your-api.up.railway.app/ws` |

Do **not** put `CLERK_SECRET_KEY`, database URLs, TURN credentials, or `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in Pages/client secrets for the static deploy.

**Donations page (hosted-only).** `VITE_SPONSOR_URL`, `VITE_PIX_KEY` and `VITE_PIX_BRCODE` build the `/apoie` and `/support` page and its footer link. `deploy-web.yml` sets the Sponsors URL inline and reads the two Pix values from repository **variables** (`gh variable set VITE_PIX_KEY`), not secrets, because all three are public and printed on the page. Leave all three empty on a self-host: with the sponsor URL and the Pix key both empty, the routes redirect to `/` and the footer link disappears, so a fork never carries pqp.gg's donation links, the same rule as the analytics and advertising tags. See `client/src/lib/support-links.ts`.

## Server-side env (Railway / Docker / VPS)

These live on the API, never in the client build. Names only — see [`../.env.example`](../.env.example).

| Group | Names | Required |
|---|---|---|
| Core | `DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT` | Yes |
| Core | `CORS_ALLOWED_ORIGINS` | Yes — unset means wildcard CORS: the API answers every origin with `*` |
| Core | `CLERK_AUTHORIZED_PARTIES` | Yes — unset means no `azp` check, so a token issued for a different app is accepted |
| Core | `TRUST_PROXY` | Yes — unset behind Railway's edge means every client shares one rate-limit bucket, so a single abusive caller exhausts the pre-auth budget for everybody |
| Hardening | `PG_POOL_MAX`, `DATABASE_SSL` | Recommended |
| ICE / TURN | one of the options in [`deploy-railway.md`](./deploy-railway.md) | For cross-NAT voice |
| SFU | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Only past the mesh limit |
| GIF search | `KLIPY_API_KEY` | Optional feature |
| **Game connections** | `PUBLIC_APP_URL`, `STEAM_WEB_API_KEY`, `BATTLENET_CLIENT_ID`, `BATTLENET_CLIENT_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Optional, per provider — [`CONNECTIONS.md`](./CONNECTIONS.md) |
| **Attachments** | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | Optional feature |
| Attachments (tuning) | `S3_PUBLIC_BASE_URL`, `MAX_ATTACHMENT_BYTES`, `ATTACHMENT_URL_TTL_SECONDS` | Optional |

Attachments are **off** until the six `S3_*` names above are set: `GET /api/attachments/config` reports `{"enabled":false}` and the client hides the attach button, the same way GIF search behaves without `KLIPY_API_KEY`.

Setting the variables is not the whole job — an R2 bucket also needs a **CORS policy** or every browser upload fails while the API logs stay silent. Full walkthrough: [`ATTACHMENTS.md`](./ATTACHMENTS.md).

### Create a Cloudflare API token

1. Open [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. **Create Token**
3. Prefer one of:
   - Template **Edit Cloudflare Workers** (includes Pages deploy permissions), **or**
   - **Custom token** with:
     - **Account** → **Cloudflare Pages** → **Edit**
     - **Account** → **Account Settings** → **Read** (if the template/custom set needs it)
4. Scope the token to the account that owns the `pqp` Pages project
5. Create the token, then set it (paste when prompted — never echo the value):

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

6. **Account ID** — Cloudflare Dashboard → **Workers & Pages** → overview **right sidebar** → Account ID (already set as a GH secret if you ran setup earlier):

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Official reference: [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

## Why `/app` shows “Can’t reach the API” (or used to spin on “Loading servers…”)

Pages only serves the static Vite build. With empty `VITE_API_URL` / `VITE_WS_URL`:

1. Clerk sign-in still works (CDN / Clerk-hosted)
2. The SPA calls **same-origin** `/api/me` and `/api/servers` on `*.pages.dev`
3. Those routes do not exist on Pages (SPA `_redirects` may even return `index.html` as HTTP 200)
4. Bootstrap fails — the app now shows a clear error instead of spinning forever

### Fix: host API + rebuild client

1. Deploy the API (see [Railway](./deploy-railway.md) or Docker Compose)
2. Allow your Pages origin in Clerk (authorized parties / allowed origins) for the API’s Clerk verification
3. Server already sends permissive CORS (`Access-Control-Allow-Origin: *`) for browser calls from `*.pages.dev`
4. Set secrets and redeploy the web client:

```bash
# Example — replace with your real public API host
gh secret set VITE_API_URL   # paste https://your-api.example.com
gh secret set VITE_WS_URL    # paste wss://your-api.example.com/ws
gh workflow run deploy-web.yml
```

Or rebuild locally and deploy with Wrangler after exporting the same `VITE_*` vars.

There is **no** production Railway URL checked into this repo yet — you must create/host your own API instance.

## Local / first Pages deploy (wrangler)

If you are already logged in with Wrangler OAuth:

```bash
pnpm --filter @pqp/shared build
# Load publishable key from client/.env without committing it
pnpm --filter @pqp/client build
cd client && wrangler pages deploy dist --project-name=pqp
```

Config: `client/wrangler.toml` (`pages_build_output_dir = "dist"`).

SPA fallback: `client/public/_redirects` → `/* /index.html 200` (copied into `dist` on build).

## Pages URL

First deploy succeeded. Project name: **`pqp`**.

- Production: [https://pqp-3yr.pages.dev](https://pqp-3yr.pages.dev)
- Attach a custom domain (e.g. `pqp.gg`) in Cloudflare → Workers & Pages → pqp → Custom domains

```bash
wrangler pages deployment list --project-name=pqp
```

## What this deploy does *not* include

- Postgres / `DATABASE_URL`
- Clerk secret key / server auth
- WebSocket signaling and voice mesh coordination
- Electron code signing (CI uploads **unsigned** builds)

Wire the SPA to a live API later with `VITE_API_URL` and `VITE_WS_URL` secrets, then re-run **Deploy Web**.

## CI deploy status

- **Local first deploy:** done via Wrangler OAuth → [https://pqp-3yr.pages.dev](https://pqp-3yr.pages.dev)
- **GitHub Actions Deploy Web:** requires `CLOUDFLARE_API_TOKEN` (OAuth login is not available on runners). Until that secret is set, the workflow fails fast with a clear error. Account ID and Clerk publishable key are already configured as repo secrets when set via setup.
