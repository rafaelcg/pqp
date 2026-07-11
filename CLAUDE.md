# CLAUDE.md — agent guidance for pqp

Open-source Discord-like voice + text chat (**pqp.gg**). Repo: [rafaelcg/pqp](https://github.com/rafaelcg/pqp).

For current product status and open work, see [`docs/HANDOVER.md`](./docs/HANDOVER.md). Deeper design: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Deploy: [`docs/DEPLOY.md`](./docs/DEPLOY.md), [`docs/deploy-railway.md`](./docs/deploy-railway.md).

## Stack

- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`)
- **Client:** React 19 + Vite + Tailwind + Clerk (`@clerk/clerk-react`)
- **Server:** Node HTTP API + WebSocket (`/ws`) + Postgres
- **Shared:** Zod schemas / protocol types (`@pqp/shared`)
- **Desktop:** Electron shell (loads web client)
- **Auth:** Clerk JWT (Bearer on HTTP; first WS message `{ type: "auth", token }`)
- **Voice:** full-mesh WebRTC per voice channel; signaling over the same WS

## Monorepo layout

| Path | Package | Role |
|---|---|---|
| `client/` | `@pqp/client` | SPA (landing + `/app`) |
| `server/` | `@pqp/server` | API, WS chat + voice signaling, optional static serve |
| `packages/shared/` | `@pqp/shared` | Shared types / Zod / voice config |
| `electron/` | `@pqp/electron` | Desktop shell |

## How to run (local)

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env
# Fill Clerk keys, or enable DEV_AUTH_BYPASS (see below)

docker compose up -d postgres
pnpm dev
# Client http://localhost:5173 — Server http://localhost:3001 — WS /ws

# Optional desktop shell (Vite must be up)
pnpm electron:dev
```

**Dev auth bypass** (no Clerk): set `DEV_AUTH_BYPASS=true` in root `.env` and `VITE_DEV_AUTH_BYPASS=true` in `client/.env`, then restart server.

## Env vars (names only — never commit `.env`)

See `.env.example`. Important names:

| Area | Names |
|---|---|
| Server | `DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT`, `DEV_AUTH_BYPASS` |
| Client | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`, `VITE_DEV_AUTH_BYPASS`, `VITE_VOICE_BACKEND` |
| ICE / TURN (API preferred) | `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `METERED_API_KEY`, `METERED_DOMAIN` |
| Client TURN fallback (avoid in prod) | `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` |
| SFU stubs (Phase 5) | `CLOUDFLARE_REALTIME_*`, `LIVEKIT_*` |
| Electron | `VITE_APP_URL` |

**Rule:** never commit `.env` / secrets. Prefer serving ICE via `GET /api/ice-servers` (Railway) over baking TURN into the Pages build.

## Architecture (short)

```
Browser/Electron → Clerk (auth)
                 → HTTPS API (servers, channels, messages, /api/ice-servers)
                 → WSS /ws (chat + presence + WebRTC offer/answer/ICE relay)
                 → P2P mesh (audio); TURN when cross-NAT
```

- **Mesh limit:** ~5–8 peers per voice channel; SFU deferred (`cloudflare-sfu` / `livekit` stubs fall back to mesh).
- **Data model:** Server → Channels (`text` \| `voice`) → Messages; roles `owner` / `admin` / `member`; usernames `name#1234`.

## Deploy targets (hosted)

| Piece | Where | URL (as of 2026-07-11) |
|---|---|---|
| Static SPA | Cloudflare Pages project `pqp` | https://pqp-3yr.pages.dev |
| API + WS | Railway | https://api-production-206d.up.railway.app — `wss://…/ws` |

CI workflows: `.github/workflows/ci.yml`, `deploy-web.yml`, `electron.yml`.

**GitHub Actions secrets (names):** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`.

**Railway env (names):** `DATABASE_URL`, `CLERK_SECRET_KEY`, plus TURN/ICE vars above. Do not put Clerk secret or TURN credentials in Pages/client secrets.

## Pitfalls already hit

1. **Cross-NAT voice FAILED** — STUN-only is not enough; dead Open Relay creds were unreliable. **Fixed (2026-07-11):** Railway `TURN_*` (ExpressTURN) via `/api/ice-servers`, plus client Retry / ICE restart. Retest: hard-refresh both clients and rejoin voice.
2. **Clerk `getToken` remount loop** — unstable token getter in React deps caused remount storms; keep token access stable (ref / memoized callback), don’t put a fresh `getToken` identity in effect deps every render.
3. **Pages without API URLs** — empty `VITE_API_URL` / `VITE_WS_URL` makes `/app` hit same-origin Pages (no API). Set GH secrets and redeploy web.
4. **Clerk origins** — allow Pages + API origins in the Clerk dashboard.
5. **`@pqp/shared` on Railway** — production resolution needed a dedicated fix; rebuild/shared packaging matters for Docker deploys.
6. **pnpm version** — CI uses pnpm matching the lockfile (pnpm 10); don’t downgrade casually.
7. **Electron Linux artifacts** — scoped package name broke `.deb` paths; fixed in CI metadata.

## Agent norms

- Do not invent secret values in docs or commits.
- Point humans to `docs/CLERK_SETUP.md` for Clerk CLI setup; `docs/voice-backends.md` for SFU notes.
- Update `docs/HANDOVER.md` + `docs/PLAN_STATUS.md` when phase status changes.
