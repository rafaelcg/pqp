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
# Cloudflare (Pages deploy) — create an API token with Account → Cloudflare Pages → Edit
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID

# Client build (publishable key is safe in the browser bundle)
gh secret set VITE_CLERK_PUBLISHABLE_KEY

# Optional — when API is hosted elsewhere
gh secret set VITE_API_URL
gh secret set VITE_WS_URL
```

| Secret | Required for | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Web | Token with **Cloudflare Pages — Edit** (and Account read) |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy Web | Cloudflare account ID |
| `VITE_CLERK_PUBLISHABLE_KEY` | Deploy Web (CI uses placeholder) | Clerk publishable key (`pk_…`) |
| `VITE_API_URL` | Optional | Public API origin for the SPA |
| `VITE_WS_URL` | Optional | Public WebSocket URL (`wss://…`) |

Do **not** put `CLERK_SECRET_KEY`, database URLs, or TURN credentials in Pages/client secrets for the static deploy.

### Create a Cloudflare API token

1. [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create token → use **Edit Cloudflare Pages** template (or custom: Account → Cloudflare Pages → Edit)
3. Scope to your account
4. `gh secret set CLOUDFLARE_API_TOKEN` (paste when prompted)
5. Account ID: dashboard overview URL / sidebar → `gh secret set CLOUDFLARE_ACCOUNT_ID`

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
