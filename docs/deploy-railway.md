# Railway deployment

Deploy pqp as an independent copy — your own URL, database, and Clerk instance.

## Steps

1. Fork or connect this repository to [Railway](https://railway.app)
2. Add a **PostgreSQL** plugin
3. Set environment variables from [`.env.example`](../.env.example):
   - `DATABASE_URL` — from Railway Postgres (auto-linked)
   - `CLERK_SECRET_KEY` — your Clerk app secret
4. Deploy using the root `Dockerfile` or `railway.toml`
5. For the client, either:
   - Build client with `VITE_CLERK_PUBLISHABLE_KEY` baked in at Docker build time, or
   - Serve client separately on Cloudflare Pages pointing `VITE_API_URL` / `VITE_WS_URL` at your Railway URL

### Pairing Railway API with Cloudflare Pages

After Railway gives you a public HTTPS URL (e.g. `https://pqp-production.up.railway.app`):

```bash
gh secret set VITE_API_URL   # paste https://…railway.app  (no trailing slash)
gh secret set VITE_WS_URL    # paste wss://…railway.app/ws
gh workflow run deploy-web.yml
```

Also add `https://pqp-3yr.pages.dev` (and any custom domain) to your Clerk app’s allowed origins / redirect URLs. The API already allows cross-origin browser requests (`Access-Control-Allow-Origin: *`).

## Clerk setup

1. Create a Clerk application at [clerk.com](https://clerk.com)
2. Add your Railway (or Pages) URL to allowed origins
3. Copy publishable key → `VITE_CLERK_PUBLISHABLE_KEY`
4. Copy secret key → `CLERK_SECRET_KEY`

## TURN

Cross-network mesh voice **requires a working TURN server**. STUN alone is not enough when peers are on different NATs.

Set one of these on the **Railway API** (preferred — never bake secrets into Pages):

### Option A — Cloudflare Realtime TURN (recommended)

1. Cloudflare Dashboard → **Realtime** → **TURN** → create a TURN key
2. Copy the key **UID** and the key **API token** (shown once)
3. On Railway:

```bash
railway variables set CLOUDFLARE_TURN_KEY_ID=<uid>
railway variables set CLOUDFLARE_TURN_API_TOKEN=<token>
```

The API fetches short-lived `iceServers` via Cloudflare’s credential API and serves them at `GET /api/ice-servers`.

### Option B — Metered / Open Relay

1. Sign up at [metered.ca](https://www.metered.ca/tools/openrelay) and create an API key
2. Set on Railway:

```bash
railway variables set METERED_API_KEY=<key>
# optional if using a Metered app domain:
railway variables set METERED_DOMAIN=<appname>
```

### Option C — Static TURN credentials

```bash
railway variables set TURN_URL=turn:turn.example.com:3478
railway variables set TURN_USERNAME=...
railway variables set TURN_CREDENTIAL=...
```

`TURN_URL` may be comma-separated for multiple URLs (UDP + TCP + TLS).

The client fetches ICE config from `GET /api/ice-servers` at bootstrap and again on each voice join. If no TURN is configured, the API returns public STUN only and cross-NAT calls will show **FAILED**.

> Note: The old static Open Relay credentials (`openrelayproject` / `openrelayproject`) no longer work reliably — do not rely on them.

## What you get

A fully independent pqp instance — not connected to pqp.gg. Same codebase as the hosted product.
