# Deploying pqp

This repo deploys the **marketing site + static SPA shell** to **Cloudflare Pages**. The WebSocket/API server and Postgres are **not** on Pages — host them separately (e.g. [Railway](./deploy-railway.md)).

## Architecture (hosted)

| Piece | Where | Notes |
|---|---|---|
| Landing + `/app` SPA | Cloudflare Pages (`pqp`) | Static Vite build from `client/` |
| API + `/ws` | Railway / Docker / VPS | See `railway.toml`, `Dockerfile` |
| Auth | Clerk | Publishable key in client build; secret on server only |
| Database | Postgres | Railway plugin or self-hosted |

First deploy priority: **dev / marketing website** on Pages. Point `VITE_API_URL` / `VITE_WS_URL` at your API when it exists.

**Expected without an API:** `/` (landing) works. After Clerk sign-in, `/app` cannot load servers until a backend is hosted and the client is rebuilt with API URLs.

## GitHub Actions

| Workflow | Path | Triggers | Purpose |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | PR + push to `main` | pnpm install, build shared/server/client |
| Deploy Web | `.github/workflows/deploy-web.yml` | push to `main`, `workflow_dispatch` | Production client → Cloudflare Pages |
| Electron | `.github/workflows/electron.yml` | push `main`, tags `v*`, `workflow_dispatch` | Unsigned mac/win/linux artifacts |

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

Do **not** put `CLERK_SECRET_KEY`, database URLs, or TURN credentials in Pages/client secrets for the static deploy.

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
