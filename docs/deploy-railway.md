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

For voice across different networks, set on the **Railway API** (preferred):

- `TURN_URL` — e.g. `turn:turn.example.com:3478` (comma-separated for multiple)
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

The client fetches these from `GET /api/ice-servers` at bootstrap. If unset, the API falls back to public STUN + Metered Open Relay so mesh voice still works across NATs.

## What you get

A fully independent pqp instance — not connected to pqp.gg. Same codebase as the hosted product.
