# Clerk setup (host shell required)

The Clerk CLI needs your Mac terminal (keychain + browser login). Run these from the **repo root** in your own terminal — not inside a sandboxed agent.

Linked Clerk application: `app_3GKdeu8xQ3JCXb7fNkY4jPe4pBT`

## One-time setup

```bash
# 1. Ensure Clerk CLI is available
command -v clerk && clerk update --yes

# 2. Sign in (opens browser)
pnpm clerk:login

# 3. Scaffold / link Clerk for the Vite client
pnpm clerk:init

# 4. Pull API keys into env files
pnpm clerk:env

# 5. Verify
pnpm clerk:doctor
```

`clerk env pull` writes:

- `client/.env.local` — `VITE_CLERK_PUBLISHABLE_KEY`
- `.env` (repo root) — `CLERK_SECRET_KEY` for the server

## Run the app

```bash
docker compose up -d postgres
pnpm dev
```

Open http://localhost:5173 → **Sign up** to create your first test user. You should see the profile icon (`UserButton`) in the top-right when signed in.

## Troubleshooting

| Issue | Fix |
|---|---|
| `Could not detect a framework` at repo root | Run `pnpm clerk:init` (targets `client/`) |
| `Not authenticated` | Run `pnpm clerk:login` on your host terminal |
| Missing publishable key | Run `pnpm clerk:env` after login |
| Server 401 | Ensure `CLERK_SECRET_KEY` is in root `.env` |

## Docs

- [Clerk React quickstart](https://clerk.com/docs/react/getting-started/quickstart)
- [Clerk CLI](https://clerk.com/docs/cli)
- [Organizations](https://clerk.com/docs/guides/organizations/overview) (future Plus/Pro)
