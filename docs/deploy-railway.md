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

## Clerk setup

1. Create a Clerk application at [clerk.com](https://clerk.com)
2. Add your Railway (or Pages) URL to allowed origins
3. Copy publishable key → `VITE_CLERK_PUBLISHABLE_KEY`
4. Copy secret key → `CLERK_SECRET_KEY`

## TURN (optional)

For voice across different networks, configure Cloudflare TURN or coturn and set `VITE_TURN_*` in the client build env.

## What you get

A fully independent pqp instance — not connected to pqp.gg. Same codebase as the hosted product.
