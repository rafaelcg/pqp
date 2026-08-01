# Handover — pqp (as of 2026-07-31)

Cold-start status for agents and humans. Companion: [`../CLAUDE.md`](../CLAUDE.md). Roadmap checklist: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Product

**pqp** — open-source Discord-like voice + text chat. Hosted twin aimed at **pqp.gg**; self-host is an independent copy (own URL, DB, Clerk).

- **Repo:** https://github.com/rafaelcg/pqp
- **Model:** servers (invite codes) → public/private channels → text chat + full-mesh voice
- **Roles:** `owner` / `admin` / `member` · usernames `name#1234`

## Live endpoints (hosted)

| Service | URL |
|---|---|
| Web (Cloudflare Pages) | https://pqp-3yr.pages.dev |
| API (Railway) | https://api-production-206d.up.railway.app |
| WebSocket | `wss://api-production-206d.up.railway.app/ws` |

ICE config: `GET https://api-production-206d.up.railway.app/api/ice-servers` (auth as required by current server).

## Monorepo

pnpm workspaces: `client/` · `server/` · `packages/shared/` · `electron/`

```bash
docker compose up -d postgres
pnpm install && pnpm dev          # :5173 + :3001
pnpm electron:dev                 # desktop shell vs Vite
```

Never commit `.env`. Template: [`.env.example`](../.env.example).

## Phase status

| Phase | Status |
|---|---|
| 0 Shell + docs | Done |
| 1 Auth + DB + API | Done |
| 2 Text chat | Done |
| 3 Voice (mesh) | Done (cross-NAT FIXED 2026-07-11) |
| 4 Self-host / Railway + Pages | Done (live) |
| 5 SFU | **LiveKit implemented 2026-07-30, not yet run against a live server**; Cloudflare Realtime still a stub |
| 6 Electron + billing | **Partial** (shell + CI artifacts + deep links; no app icon, no Stripe UI) |

Detail and “still open” list: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Recent shipped work (context for next agents)

- Discord-like **voice sidebar** + **speaking rings**
- Channel **topics / icons**
- **Avatar presets**
- Fix: Clerk **`getToken` remount loop**
- Production voice plumbing: ICE via `/api/ice-servers`, Railway `TURN_*` (ExpressTURN); Metered / Cloudflare TURN still supported as alternatives
- **Fix (2026-07-11):** cross-NAT mesh voice — real TURN + client Retry / ICE restart; dead Open Relay removed

## Resolved (2026-07-11)

**Cross-NAT mesh: remote peer FAILED** — fixed via ExpressTURN on Railway (`TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` → `/api/ice-servers`) plus client Retry and ICE restart. Dead Open Relay creds removed.

**Retest:** hard-refresh both clients, leave and rejoin the voice channel.

## CI / secrets checklist (names only)

### GitHub Actions

| Workflow | File |
|---|---|
| CI | `.github/workflows/ci.yml` |
| Deploy Web (Pages) | `.github/workflows/deploy-web.yml` |
| Electron | `.github/workflows/electron.yml` |

**GH secret names:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`.

Do **not** put `CLERK_SECRET_KEY`, `DATABASE_URL`, or TURN credentials in Pages/client secrets.

### Railway (API)

**Env names:** `DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT` (optional), and one ICE path:

- `TURN_URL` + `TURN_USERNAME` + `TURN_CREDENTIAL` (production: ExpressTURN), or
- `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`, or
- `METERED_API_KEY` (+ optional `METERED_DOMAIN`)

## Auth notes

- Clerk on client + `@clerk/backend` verify on server.
- Local bypass: `DEV_AUTH_BYPASS` + `VITE_DEV_AUTH_BYPASS` (see README / CLAUDE.md).
- Allow Pages origin(s) and API origin in Clerk dashboard.

## Docs map

| Doc | Use |
|---|---|
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | System design, WS protocols, voice backends |
| [`DEPLOY.md`](./DEPLOY.md) | Pages + GH Actions + client wiring |
| [`deploy-railway.md`](./deploy-railway.md) | Railway + TURN options |
| [`CLERK_SETUP.md`](./CLERK_SETUP.md) | Clerk CLI |
| [`voice-backends.md`](./voice-backends.md) | SFU notes |
| [`billing.md`](./billing.md) | Future Plus/Pro |
| [`PLAN_STATUS.md`](./PLAN_STATUS.md) | Phase checklist |

## Hardening + product pass (2026-07-31)

A large pass landed across security, reliability, chat UX, moderation, and engineering health.
Full list in [`PLAN_STATUS.md`](./PLAN_STATUS.md). The parts most likely to surprise you:

- **Client API calls no longer take a token.** `client/src/lib/api.ts` holds a provider that
  resolves a fresh Clerk token per request and retries once on 401. Passing a captured token
  around was why actions failed with "Unauthorized" about a minute into a session.
- **The WebSocket reconnects.** `client/src/lib/realtime.ts` owns backoff, an app-level
  ping/pong, and a silence watchdog. `onReady(reconnected)` fires on every connect — that is
  where channel resubscription and history re-sync happen.
- **Routes live in a table.** `server/src/api/index.ts` registers against
  `server/src/lib/router.ts`. Params named `*Id` must be UUIDs or the request 404s before
  reaching Postgres.
- **New env vars:** `ALLOWED_ORIGINS`, `TRUST_PROXY`, `PG_POOL_MAX`. Set `ALLOWED_ORIGINS` on
  Railway; without it CORS stays permissive.
- **Rate limiting and chat presence are in-process**, so the API is single-instance for now.
- **Schema additions** apply on boot via `initDb()`: `messages.edited_at`, `message_mentions`,
  `channel_reads`, `server_bans`.

## Verification status

| Checked | How |
|---|---|
| Authorization matrix | 24 integration tests against real Postgres (`server/src/api/api.test.ts`) |
| Reconnect, optimistic send, chat reducers | 30 client unit tests |
| Send, multi-line, markdown + mentions, reconnect after restart, dialogs | Driven in a browser |
| **Voice (mesh, deafen, per-peer volume)** | **Not verified** — no microphone was available |

## Suggested next work (priority)

1. **Exercise voice with a real mic** — mesh join, deafen, per-peer volume, and the persistent
   voice bar all changed and none were run against real hardware.
2. **Verify LiveKit end-to-end** — `docker compose --profile livekit up -d`, set `LIVEKIT_*`, join from two clients. Token minting is verified; the browser join/publish path is not.
3. **Set `ALLOWED_ORIGINS` on Railway** to the Pages origin (and pqp.gg when it exists).
4. **pqp.gg is unregistered** — canonical/OG tags in `client/index.html` and `SITE_URL` in `seo.tsx` point at a domain nobody owns, so shared links render a broken preview. Buy the domain or repoint the metadata.
5. **Electron app icon** — no `electron/build` icons; packaged apps use the default Electron icon.
6. Move rate limiting + presence to Redis before running more than one API instance.
7. Cloudflare Realtime SFU adapter (optional — LiveKit covers the need)
8. Clerk Billing (Plus/Pro) when ready
