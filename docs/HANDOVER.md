# Handover — pqp (as of 2026-07-11)

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
| 5 SFU | **Deferred** (stubs → mesh fallback) |
| 6 Electron + billing | **Partial** (shell + CI artifacts; no Stripe UI) |

Detail and “still open” list: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Recent shipped work (context for next agents)

- Discord-like **voice sidebar** + **speaking rings**
- Channel **topics / icons**
- **Avatar presets**
- Fix: Clerk **`getToken` remount loop**
- Production voice plumbing: ICE via `/api/ice-servers`, Railway `TURN_*` (ExpressTURN); Metered / Cloudflare TURN still supported as alternatives
- **Fix (2026-07-11):** cross-NAT mesh voice — real TURN + client Retry / ICE restart; dead Open Relay removed

### Audit hardening (2026-07-11)

A full app audit produced a batch of security, robustness, and hygiene fixes:

- **Realtime disconnects fixed:** WS heartbeat (server ping/pong) + client
  auto-reconnect with backoff and fresh-token resolution; WS handlers wrapped
  in try/catch and `pool.on("error")` + process guards so one bad message no
  longer crashes the server (which had shown as "Realtime connection closed").
- **Voice signaling scoped to rooms:** relay and rosters were instance-wide
  (cross-server mic-audio eavesdropping risk); now room/member scoped, with a
  client peer allowlist. Mesh cap enforced server-side; mic released on join
  timeout; old peer managers disposed on rejoin.
- **Auth/abuse:** `DEV_AUTH_BYPASS` ignored in production, request body size
  cap, per-user rate limits (API + WS), Clerk `authorizedParties`, CORS
  allowlist (`CORS_ALLOWED_ORIGINS`).
- **Moderation added:** kick, ban (blocks rejoin), and message delete (live).
- **Infra:** Dockerfile pins pnpm 10 + non-root + `.dockerignore`; pg pool
  config; `/health` checks the DB.
- **Tests + CI:** vitest suite (unit + DB-backed ACL/moderation) run in CI
  against a Postgres service; `deploy-web` gated on CI success.

New env names: `CLERK_AUTHORIZED_PARTIES`, `CORS_ALLOWED_ORIGINS`,
`DATABASE_SSL` / `PG_POOL_MAX`.

### Voice random-disconnect investigation (2026-07-11)

Reported: two phones in the same voice channel (WiFi, screen on, foreground)
get kicked out of the call at random, uncorrelated times.

- **Observability added:** the server now logs greppable WS/voice lifecycle
  lines — `ws.connect` / `ws.auth` / `ws.close` (with close code + `wasInVoice`)
  / `ws.heartbeatTerminate` / `voice.join|leave|roomFull` (`server/src/lib/log.ts`).
  Next repro, `railway logs | grep '\[pqp\]'` names the cause (client close vs
  heartbeat reap vs proxy-injected 1006).
- **Repro tool:** `pnpm soak:voice` (`scripts/voice-soak.mjs`) spawns the
  server, joins N simulated clients to a voice room, and soaks the connections.
  A local 70s soak of 2 idle clients showed **zero drops** — so the cause is
  not a plain server bug; it points at real-network latency and/or the Railway
  edge proxy, which localhost doesn't have.
- **Client hardening (the fix):** the keepalive was dropping a healthy link
  after a single 10s pong gap — each phone's independent timer explains the
  random uncorrelated drops. Now it tolerates missed pongs
  (`MAX_MISSED_PONGS`, ~40s) before declaring the link dead, handles
  `visibilitychange`, and — most importantly — a brief WS reconnect now
  **auto-rejoins the voice room** (`voice.notifyReconnected`) instead of
  ejecting the user (`client/src/lib/realtime.ts`, `client/src/hooks/use-voice.ts`).
  Verified: the transport survives 30s of silence (old code dropped at 10s),
  still detects a truly dead link, and reconnects.

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

## Suggested next work (priority)

1. Channel rename UI + private-channel member picker
2. Promote/demote admins UI
3. Electron packaging / deep links polish
4. SFU (Phase 5) when mesh limits hurt
5. Clerk Billing (Plus/Pro) when ready
